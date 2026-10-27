"use strict";

// ------------------------------------------------------------------ helpers

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const app = $("#app");
const modal = $("#modal");

const EXAM_SIZE = 24;
const EXAM_SECONDS = 45 * 60;
const PASS_RATIO = 0.75;

let DB = null;
let QUIZ = null;
let timerHandle = null;

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function sameSet(a, b) {
  return a.length === b.length && [...a].sort().join() === [...b].sort().join();
}

function fmtTime(sec) {
  sec = Math.max(0, Math.round(sec));
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function fmtDate(iso) {
  if (!iso) return "–";
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short" }) + " " +
    d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

const startOfDay = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const calendarDaysFromToday = d => Math.round((startOfDay(d) - startOfDay(new Date())) / 86400000);

function relDays(iso) {
  if (!iso) return "now";
  const due = new Date(iso);
  if (due <= new Date()) return "now";
  const days = calendarDaysFromToday(due);
  if (days === 0) return `later today (${due.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })})`;
  return days === 1 ? "tomorrow" : `in ${days} days`;
}

function toast(msg, ms = 2600) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast.h);
  toast.h = setTimeout(() => t.classList.remove("show"), ms);
}

async function api(method, path, body, headers = {}) {
  const opts = { method, headers: { ...headers } };
  if (body instanceof Blob || body instanceof ArrayBuffer) {
    opts.body = body;
  } else if (body !== undefined) {
    opts.body = JSON.stringify(body);
    opts.headers["Content-Type"] = "application/json";
  }
  const res = await fetch("/api/" + path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

async function reload() {
  DB = await api("GET", "db");
}

// ------------------------------------------------------------------ derived data

// Progress model (see server.py): a streak of right answers on separate days; MASTERED of them
// = mastered. State is the highest of: Mastered > Learning (answered at least once) > New.
// "Missed before" is a permanent mark, not a state.
const allQs = () => Object.values(DB.questions);
const MASTERED = () => DB.config.mastered_streak;
const isMastered = q => q.stats.streak >= MASTERED();
const step = q => Math.min(q.stats.streak, MASTERED());
const missedBefore = q => !!q.flags?.missed;
const wasWrongInTest = (q, testId) => q.sources.some(s => s.result === "incorrect" && (!testId || s.test === testId));
// A right answer given now would count (not already counted today, or a mastered question's check is due).
const isDue = q => !q.stats.due || new Date(q.stats.due) <= new Date();
const needsFix = q => missedBefore(q) && !isMastered(q);
const accuracy = q => (q.stats.seen ? q.stats.right / q.stats.seen : null);
const isMulti = q => q.correct.length > 1;

const state = q => (isMastered(q) ? "Mastered" : q.flags?.practised ? "Learning" : "New");
const STATE_CLASS = { New: "", Learning: "accent", Mastered: "ok" };

function level(q) {
  const label = state(q);
  return { label, cls: STATE_CLASS[label] };
}

const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const today = () => ({ answers: 0, steps: 0, mastered: 0, slipped: 0, ...(DB.daily?.[todayIso()] || {}) });

function relAgo(iso) {
  if (!iso) return "never";
  const days = -calendarDaysFromToday(new Date(iso));
  return days <= 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
}

function testShort(id) {
  const t = DB.tests[id];
  return t ? t.title.replace(/^Test\s*/i, "T") : id;
}

function weakness(q) {
  // Lower = weaker. Streak dominates, accuracy breaks ties, unpractised mistakes first.
  const acc = accuracy(q);
  return q.stats.streak * 10 + (acc === null ? (missedBefore(q) ? 0 : 5) : acc * 9);
}

// ------------------------------------------------------------------ exam date

function examInfo() {
  const iso = DB.settings?.exam_date;
  if (!iso) return null;
  const [y, m, d] = iso.split("-").map(Number);
  const day = new Date(y, m - 1, d);
  // Study days left: today up to the day before the exam.
  return { iso, day, daysLeft: calendarDaysFromToday(day), active: calendarDaysFromToday(day) > 0 };
}

const stepsLeft = q => MASTERED() - step(q);

async function saveSettings(patch) {
  try {
    DB.settings = await api("PATCH", "settings", patch);
    await reload();
    renderHome();
  } catch (e) {
    alert(e.message);
  }
}

const MODES = {
  plan: {
    title: "Exam plan",
    desc: "Built around your test date: only questions where a right answer counts today, furthest from mastered first.",
    pool: () => shuffle(allQs().filter(isDue)).sort((a, b) => stepsLeft(b) - stepsLeft(a)),
    requeue: true, size: 20,
    available: () => !!examInfo()?.active,
  },
  fix: {
    title: "Missed, not yet mastered",
    desc: "Questions you've got wrong at least once, in a test or here, that aren't mastered yet. Wrong answers come back at the end of the round.",
    pool: () => shuffle(allQs().filter(needsFix)).sort((a, b) => isDue(b) - isDue(a) || step(a) - step(b)),
    requeue: true, size: 20,
  },
  review: {
    title: "Ready to count",
    desc: "Questions where a right answer counts right now: not yet counted today, or a mastered question due its check. Each one is a step towards mastery.",
    pool: () => shuffle(allQs().filter(isDue)).sort((a, b) => step(a) - step(b)),
    requeue: true, size: 20,
  },
  exam: {
    title: "Mock exam",
    desc: `${EXAM_SIZE} random questions in ${EXAM_SECONDS / 60} minutes, like the real test. No feedback until you submit. Pass mark is ${PASS_RATIO * 100}%.`,
    pool: () => shuffle(allQs()),
    exam: true, size: EXAM_SIZE, fixedSize: true,
  },
  weak: {
    title: "Weakest questions",
    desc: "The questions with your lowest streak and accuracy, whether or not an answer counts today.",
    pool: () => shuffle(allQs()).sort((a, b) => weakness(a) - weakness(b)),
    requeue: true, size: 10,
  },
  flagged: {
    title: "Flagged",
    desc: "Questions you flagged (press F during a quiz, or flag them in the question bank).",
    pool: () => shuffle(allQs().filter(q => q.flagged)),
    requeue: true, size: 20,
  },
  all: {
    title: "Everything, shuffled",
    desc: "Practise the whole bank in random order with instant feedback.",
    pool: () => shuffle(allQs()),
    requeue: false, size: 24,
  },
};

// ------------------------------------------------------------------ routing

function setNav(name) {
  $$(".topbar nav a").forEach(a => a.classList.toggle("active", a.dataset.nav === name));
}

async function router() {
  clearInterval(timerHandle);
  document.onkeydown = null;
  const hash = location.hash.slice(1) || "/";
  const [, route, arg] = hash.split("/");
  try {
    if (!DB) await reload();
  } catch (e) {
    app.innerHTML = `<div class="card empty">Could not reach the server: ${esc(e.message)}<br>Is <code>server.py</code> running?</div>`;
    return;
  }
  if (route === "quiz") return QUIZ ? renderQuiz() : (location.hash = "#/");
  if (route === "results") return QUIZ ? renderResults() : (location.hash = "#/");
  if (route === "bank") { setNav("bank"); return renderBank(arg); }
  if (route === "history") { setNav("history"); return renderHistory(); }
  setNav("home");
  renderHome();
}

window.addEventListener("hashchange", router);

// ------------------------------------------------------------------ dashboard

function renderHome() {
  const qs = allQs();
  const tests = Object.values(DB.tests).sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }));
  const toFix = qs.filter(needsFix).length;
  const due = qs.filter(isDue).length;
  const exams = DB.sessions.filter(s => s.mode === "exam").slice(-5);
  const examAvg = exams.length ? exams.reduce((n, s) => n + s.score / s.total, 0) / exams.length : null;
  const examPasses = exams.filter(s => s.score / s.total >= PASS_RATIO).length;

  if (!qs.length) {
    app.innerHTML = `
      <div class="card empty">
        <h2>No questions yet</h2>
        <p>Put your result PDFs in <code>${esc(DB.config.pdf_dir)}</code> and scan, or drop them below.</p>
      </div>
      ${importSection()}`;
    bindImport();
    return;
  }

  const counts = {
    plan: due, fix: toFix, review: due, exam: qs.length, weak: qs.length,
    flagged: qs.filter(q => q.flagged).length, all: qs.length,
  };

  app.innerHTML = `
    <section>
      <h1>Life in the UK – practice</h1>
      ${examCard(qs)}
      ${todayCard()}
      ${ladderCard(qs)}
      <div class="grid tiles">
        ${tile(qs.length, "questions in your bank")}
        ${tile(due, "ready to count now")}
        ${tile(toFix, "missed before, not yet mastered")}
        ${tile(examAvg === null ? "–" : `${Math.round(examAvg * 100)}%`,
              examAvg === null ? "no mock exams yet" : `avg of last ${exams.length} mock exams · ${examPasses} passed`)}
      </div>
    </section>

    <section>
      <h2>Start a quiz</h2>
      <div class="grid modes">
        ${Object.entries(MODES).filter(([, m]) => !m.available || m.available())
          .map(([key, m]) => modeCard(key, m, counts[key])).join("")}
      </div>
    </section>

    <section>
      <div class="section-head">
        <h2>Your tests <span class="badge">${tests.length}</span></h2>
        <button class="small" id="tests-toggle" aria-expanded="${TESTS_OPEN}" aria-controls="tests-table">
          ${TESTS_OPEN ? "Hide tests ▴" : "Show tests ▾"}</button>
      </div>
      <div class="card table-wrap" id="tests-table" ${TESTS_OPEN ? "" : "hidden"}></div>
    </section>

    ${importSection()}

    <section>
      <h2>Data</h2>
      <div class="card" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <a class="btn small" href="/api/export">Download backup</a>
        <button class="small" id="rescan-force">Re-import all PDFs</button>
        <button class="small" id="exam-date-open">${examInfo() ? "Change test date" : "Set test date"}</button>
        <button class="small danger" id="reset-progress" title="Back to just after importing your PDFs; right/wrong counters are kept">Reset progress</button>
        <button class="small danger" id="reset-blank" title="Everything New, counters at 0, no missed marks">Start from blank</button>
        <span class="muted small">Stored in <code>data/db.json</code>; a backup is taken before every import or reset.</span>
      </div>
    </section>
  `;

  $$("[data-mode]").forEach(btn => btn.onclick = () => {
    const key = btn.dataset.mode;
    const size = $(`[data-size="${key}"]`)?.value ?? MODES[key].size;
    startQuiz(key, size === "all" ? Infinity : Number(size));
  });
  if (TESTS_OPEN) drawTestsTable();
  $("#tests-toggle").onclick = () => {
    TESTS_OPEN = !TESTS_OPEN;
    const btn = $("#tests-toggle");
    btn.setAttribute("aria-expanded", TESTS_OPEN);
    btn.textContent = TESTS_OPEN ? "Hide tests ▴" : "Show tests ▾";
    $("#tests-table").hidden = !TESTS_OPEN;
    if (TESTS_OPEN) drawTestsTable();
  };
  bindExamCard();
  $("#rescan-force").onclick = () => scan(true);
  const reset = async (blank, message) => {
    if (!confirm(message)) return;
    await api("POST", "reset-progress", { blank });
    await reload();
    toast(blank ? "Started from blank" : "Progress reset");
    renderHome();
  };
  $("#reset-progress").onclick = () => reset(false,
    "Reset progress to just after importing your PDFs?\n\nStreaks and quiz history are cleared; questions, missed marks from the PDFs and right/wrong counters are kept. A backup is saved first.");
  $("#reset-blank").onclick = () => reset(true,
    "Start from blank?\n\nEvery question becomes New, counters go to 0, missed marks are removed and quiz history is cleared, as if you had never answered anything. A backup is saved first.");
  bindLadder();
  bindImport();
}

// ------------------------------------------------------------------ today + ladder

function todayCard() {
  const t = today();
  const info = examInfo();
  let goal = "";
  if (info?.active) {
    // Today's share of what's left; today's own steps are added back so the goal holds still all day.
    const needed = allQs().reduce((n, q) => n + stepsLeft(q), 0);
    const target = Math.max(1, Math.ceil((needed + t.steps) / info.daysLeft));
    const pct = Math.min(100, t.steps / target * 100);
    goal = `<div class="goal">
      <div class="goal-head"><span>Today's goal for your test</span><b>${t.steps} / ${target} steps</b></div>
      <div class="bar ${t.steps >= target ? "ok" : ""}" role="progressbar" aria-valuenow="${t.steps}" aria-valuemax="${target}"><span style="width:${pct}%"></span></div>
    </div>`;
  }
  const stat = (n, label, cls = "") => `<div class="today-stat ${cls}"><b>${n}</b><span>${label}</span></div>`;
  return `<div class="card today-card">
    <h2>Today</h2>
    <div class="today-stats">
      ${stat(`+${t.steps}`, "steps earned", t.steps ? "good" : "")}
      ${stat(t.mastered, "newly mastered", t.mastered ? "good" : "")}
      ${stat(t.slipped, "slipped back to step 0", t.slipped ? "bad" : "")}
      ${stat(t.answers, "answers given")}
    </div>
    ${goal}
    ${t.answers ? "" : `<p class="small muted" style="margin:8px 0 0">Nothing yet today – start with <b>${examInfo()?.active ? "Exam plan" : "Ready to count"}</b> below.</p>`}
  </div>`;
}

// The ladder: every question is in exactly one segment. Learning is split by step.
function ladderParts(qs) {
  const parts = [
    { key: "state:New", label: "New", cls: "seg-new", n: 0 },
    ...[0, 1, 2].map(s => ({ key: `step:${s}`, label: `Learning · step ${s}`, short: `step ${s}`, cls: `seg-l${s}`, n: 0 })),
    { key: "state:Mastered", label: "Mastered", cls: "seg-mastered", n: 0 },
  ];
  for (const q of qs) {
    const st = state(q);
    const part = st === "New" ? parts[0] : st === "Mastered" ? parts[4] : parts[1 + step(q)];
    part.n++;
  }
  return parts;
}

function donut(parts, total) {
  // Thin ring, a 2px surface gap between segments, every segment labelled in the list beside it.
  const r = 42, c = 2 * Math.PI * r, gap = parts.filter(p => p.n).length > 1 ? 2 : 0;
  let offset = 0;
  const segs = parts.filter(p => p.n).map(p => {
    const len = p.n / total * c;
    const s = `<circle class="${p.cls}-stroke" r="${r}" cx="50" cy="50" fill="none" stroke-width="12"
      stroke-dasharray="${Math.max(0, len - gap)} ${c}" stroke-dashoffset="${-offset}"><title>${p.label}: ${p.n}</title></circle>`;
    offset += len;
    return s;
  }).join("");
  return `<svg viewBox="0 0 100 100" class="donut" role="img" aria-label="${parts.map(p => `${p.label}: ${p.n}`).join(", ")}">
    <g transform="rotate(-90 50 50)">${segs}</g>
    <text x="50" y="48" text-anchor="middle" class="donut-n">${total}</text>
    <text x="50" y="62" text-anchor="middle" class="donut-l">learning</text>
  </svg>`;
}

function ladderCard(qs) {
  const parts = ladderParts(qs);
  const learning = parts.slice(1, 4);
  const nLearning = learning.reduce((n, p) => n + p.n, 0);
  const total = qs.length;
  const pct = n => `${(n / total * 100).toFixed(n && n / total < 0.01 ? 1 : 0)}%`;
  const chip = (key, label, n, cls, extra = "") =>
    `<button class="chip" data-ladder="${key}" ${extra}><i class="${cls}"></i>${label} <b>${n}</b></button>`;
  const open = LADDER_OPEN;
  return `<div class="card ladder-card">
    <div class="ladder-head">
      <h2>Where your questions are</h2>
      <span class="small muted">Mastered = right on ${MASTERED()} separate days with no miss in between</span>
    </div>
    <div class="ladder" role="img" aria-label="${parts.map(p => `${p.label}: ${p.n}`).join(", ")}">
      ${parts.filter(p => p.n).map(p => `<button class="${p.cls}" style="flex:${p.n}" data-ladder="${p.key}"
        title="${p.label}: ${p.n} (${pct(p.n)}) – click to see them"></button>`).join("")}
    </div>
    <div class="legend chips">
      ${chip("state:New", "New", parts[0].n, "seg-new")}
      ${chip("learning", `Learning ${open ? "▾" : "▸"}`, nLearning, "seg-l1", `aria-expanded="${open}"`)}
      ${chip("state:Mastered", "Mastered", parts[4].n, "seg-mastered")}
      ${chip("missed", "Missed before", allQs().filter(missedBefore).length, "mark-missed", 'title="A permanent mark: got wrong at least once, here or in a PDF"')}
    </div>
    ${open ? `<div class="learning-detail">
      ${nLearning ? donut(learning, nLearning) : ""}
      <div class="learning-rows">
        ${learning.map(p => `<div class="learning-row">
          <i class="${p.cls}"></i>
          <span><b>${p.n}</b> at ${p.short} <span class="muted">· ${MASTERED() - Number(p.key.slice(5))} more day${MASTERED() - Number(p.key.slice(5)) === 1 ? "" : "s"} right to master</span></span>
          <button class="small" data-ladder="${p.key}" ${p.n ? "" : "disabled"}>Show</button>
          <button class="small" data-ladder-practise="${p.key}" ${p.n ? "" : "disabled"}>Practise</button>
        </div>`).join("")}
        <p class="small muted" style="margin:6px 0 0">A step is a right answer on a new day. A wrong answer sends a question back to step 0.</p>
      </div>
    </div>` : ""}
  </div>`;
}

let LADDER_OPEN = false;
// "Your tests" starts closed on every page load and remembers its state while the app is open.
let TESTS_OPEN = false;

function questionsFor(key) {
  return allQs().filter(q => bankMatches(q, key));
}

function bindLadder() {
  $$("[data-ladder]").forEach(el => el.onclick = () => {
    const key = el.dataset.ladder;
    if (key === "learning") { LADDER_OPEN = !LADDER_OPEN; return renderHome(); }
    location.hash = `#/bank/${encodeURIComponent(key)}`;
  });
  $$("[data-ladder-practise]").forEach(el => el.onclick = () => {
    const key = el.dataset.ladderPractise;
    startCustom(`Learning · step ${key.slice(5)}`, questionsFor(key).filter(isDue).map(q => q.id)
      .concat(questionsFor(key).filter(q => !isDue(q)).map(q => q.id)).slice(0, 20), { requeue: true });
  });
}

// ------------------------------------------------------------------ exam card

const fmtDay = d => d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });

function examDateForm(info) {
  const tomorrow = new Date(Date.now() + 86400000);
  const min = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, "0")}-${String(tomorrow.getDate()).padStart(2, "0")}`;
  return `<form class="exam-form" id="exam-form">
    <input type="date" id="exam-date" required min="${min}" value="${info?.active ? info.iso : ""}" aria-label="Test date">
    <button type="submit" class="primary">Save</button>
    ${info ? `<button type="button" id="exam-clear">Clear date</button>` : `<button type="button" id="exam-dismiss">Not booked yet</button>`}
  </form>`;
}

function examCard(qs) {
  const info = examInfo();
  const dismissed = DB.settings?.exam_prompt_dismissed;
  if (!info && dismissed) return "";
  if (!info) {
    return `<div class="card exam-card">
      <h2>When is your Life in the UK test?</h2>
      <p class="muted">Set the date and the app builds an <b>Exam plan</b>: reviews are spaced so every question can be mastered before the day.</p>
      ${examDateForm(null)}
    </div>`;
  }
  if (!info.active) {
    return `<div class="card exam-card">
      <h2>${info.daysLeft === 0 ? "Your test is today – good luck! 🍀" : `Your test was on ${fmtDay(info.day)}`}</h2>
      <p class="muted">Practice is back on the normal spaced schedule. Booked another one? Set the new date.</p>
      ${examDateForm(info)}
    </div>`;
  }
  const toMaster = qs.filter(q => !isMastered(q));
  const needed = toMaster.reduce((n, q) => n + stepsLeft(q), 0);
  const perDay = Math.ceil(needed / info.daysLeft);
  const dueNow = qs.filter(isDue).length;
  return `<div class="card exam-card">
    <div class="exam-head">
      <div>
        <h2>Your test is ${info.daysLeft === 1 ? "tomorrow" : `in ${info.daysLeft} days`}</h2>
        <div class="muted">${fmtDay(info.day)} · ${info.daysLeft} study day${info.daysLeft === 1 ? "" : "s"} left, including today</div>
      </div>
      <button class="primary" id="plan-start" ${dueNow ? "" : "disabled"}>Start today's plan</button>
    </div>
    <div class="exam-stats">
      <div><b>${toMaster.length}</b><span>questions still to master</span></div>
      <div><b>${needed}</b><span>steps needed in total</span></div>
      <div><b>~${perDay}</b><span>steps a day to finish in time</span></div>
      <div><b>${dueNow}</b><span>ready to count now</span></div>
    </div>
    <p class="small muted" style="margin:10px 0 0">
      A step is a right answer on a new day; ${MASTERED()} steps in a row master a question.
      ${dueNow ? "" : "Everything has counted for today – come back tomorrow."}
      <a href="#" id="exam-change">Change date</a>
    </p>
    <div id="exam-change-form" hidden style="margin-top:10px">${examDateForm(info)}</div>
  </div>`;
}

function bindExamCard() {
  $("#plan-start")?.addEventListener("click", () => startQuiz("plan", MODES.plan.size));
  $("#exam-change")?.addEventListener("click", e => { e.preventDefault(); $("#exam-change-form").hidden = false; });
  $("#exam-form")?.addEventListener("submit", e => { e.preventDefault(); saveSettings({ exam_date: $("#exam-date").value }); });
  $("#exam-clear")?.addEventListener("click", () => saveSettings({ exam_date: null }));
  $("#exam-dismiss")?.addEventListener("click", () => saveSettings({ exam_prompt_dismissed: true }));
  $("#exam-date-open").onclick = () => {
    if (!examInfo() && DB.settings?.exam_prompt_dismissed) return saveSettings({ exam_prompt_dismissed: false });
    const form = $("#exam-change-form");
    if (form) form.hidden = false;
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
}

// ------------------------------------------------------------------ tests table

const TEST_COLUMNS = [
  { key: "test", label: "Test" },
  { key: "score", label: "Score", cls: "num" },
  { key: "left", label: "Mistakes left", cls: "num hide-sm" },
  { key: "imported", label: "Imported", cls: "hide-sm" },
];

const TEST_SORT = (() => {
  try { return JSON.parse(localStorage.getItem("testSort")) || { key: "test", dir: 1 }; }
  catch (e) { return { key: "test", dir: 1 }; }
})();

const byTitle = (a, b) => a.t.title.localeCompare(b.t.title, undefined, { numeric: true });
const TEST_SORTERS = {
  test: byTitle,
  score: (a, b) => a.t.score / a.t.total - b.t.score / b.t.total,
  left: (a, b) => a.left - b.left || a.wrong - b.wrong,
  imported: (a, b) => (a.t.imported || "").localeCompare(b.t.imported || ""),
};

function drawTestsTable() {
  const box = $("#tests-table");
  if (!box) return;
  const rows = Object.values(DB.tests).map(t => {
    const wrongQs = t.questions.map(id => DB.questions[id]).filter(q => q && wasWrongInTest(q, t.id));
    return { t, wrong: wrongQs.length, left: wrongQs.filter(q => !isMastered(q)).length };
  });
  // Ties always fall back to test order, whichever direction the column is sorted.
  rows.sort((a, b) => TEST_SORTERS[TEST_SORT.key](a, b) * TEST_SORT.dir || byTitle(a, b));

  const header = TEST_COLUMNS.map(c => {
    const active = c.key === TEST_SORT.key;
    const aria = active ? (TEST_SORT.dir > 0 ? "ascending" : "descending") : "none";
    return `<th class="${c.cls || ""}" aria-sort="${aria}">
      <button class="th-sort ${active ? "active" : ""}" data-sort="${c.key}">${c.label}<span class="arrow" aria-hidden="true">${active ? (TEST_SORT.dir > 0 ? "▲" : "▼") : "↕"}</span></button></th>`;
  }).join("");

  box.innerHTML = `<table>
    <thead><tr>${header}<th></th></tr></thead>
    <tbody>${rows.map(({ t, wrong, left }) => {
      const passed = t.score / t.total >= PASS_RATIO;
      return `<tr>
        <td><strong>${esc(t.title)}</strong> <span class="muted small">${esc(t.file)}</span>
          ${t.warnings?.length ? `<span class="badge warn" title="${esc(t.warnings.join("; "))}">⚠ check</span>` : ""}</td>
        <td class="num">${t.score}/${t.total} <span class="badge ${passed ? "ok" : "bad"}">${passed ? "✓ pass" : "✗ fail"}</span></td>
        <td class="num hide-sm">${left} of ${wrong}</td>
        <td class="hide-sm muted small">${fmtDate(t.imported)}</td>
        <td style="white-space:nowrap;text-align:right">
          <button class="small" data-test-mistakes="${t.id}" ${wrong ? "" : "disabled"}>Mistakes</button>
          <button class="small" data-test-retake="${t.id}">Retake</button>
        </td>
      </tr>`;
    }).join("")}</tbody>
  </table>`;

  $$("[data-sort]", box).forEach(btn => btn.onclick = () => {
    const key = btn.dataset.sort;
    // Same column flips the direction; a new column starts ascending.
    TEST_SORT.dir = TEST_SORT.key === key ? -TEST_SORT.dir : 1;
    TEST_SORT.key = key;
    try { localStorage.setItem("testSort", JSON.stringify(TEST_SORT)); } catch (e) { /* ignore */ }
    drawTestsTable();
    $(`[data-sort="${key}"]`, box)?.focus();
  });
  $$("[data-test-mistakes]", box).forEach(btn => btn.onclick = () => {
    const t = DB.tests[btn.dataset.testMistakes];
    const ids = t.questions.filter(id => DB.questions[id] && wasWrongInTest(DB.questions[id], t.id));
    startCustom(`${t.title} – mistakes`, ids, { requeue: true });
  });
  $$("[data-test-retake]", box).forEach(btn => btn.onclick = () => {
    const t = DB.tests[btn.dataset.testRetake];
    startCustom(`${t.title} – retake`, t.questions.filter(id => DB.questions[id]), { exam: true });
  });
}

function tile(value, label) {
  return `<div class="card tile"><div class="value">${value}</div><div class="label">${esc(label)}</div></div>`;
}

function modeCard(key, m, count) {
  const sizes = m.fixedSize ? [] : [10, 20, 30, "all"];
  const disabled = !count;
  return `<div class="card mode">
    <h3>${esc(m.title)} <span class="badge">${count}</span></h3>
    <p>${esc(m.desc)}</p>
    <div class="row">
      ${sizes.length ? `<select data-size="${key}" aria-label="Number of questions">
        ${sizes.map(s => `<option value="${s}" ${s === m.size ? "selected" : ""}>${s === "all" ? "All" : s} ${s === "all" ? "" : "questions"}</option>`).join("")}
      </select>` : ""}
      <button class="primary" data-mode="${key}" ${disabled ? "disabled" : ""}>Start</button>
    </div>
  </div>`;
}

// ------------------------------------------------------------------ import

function importSection() {
  return `<section>
    <h2>Add tests</h2>
    <div class="dropzone" id="dropzone">
      <p style="margin:0 0 8px">Drop result PDFs here (saved into <code>${esc(DB.config.pdf_dir)}</code>)</p>
      <label class="btn small">Choose files<input type="file" id="file-input" accept="application/pdf" multiple hidden></label>
      <button class="small" id="scan">Scan folder for new PDFs</button>
    </div>
  </section>`;
}

function bindImport() {
  const dz = $("#dropzone");
  if (!dz) return;
  $("#scan").onclick = () => scan(false);
  $("#file-input").onchange = e => upload([...e.target.files]);
  dz.ondragover = e => { e.preventDefault(); dz.classList.add("over"); };
  dz.ondragleave = () => dz.classList.remove("over");
  dz.ondrop = e => {
    e.preventDefault();
    dz.classList.remove("over");
    upload([...e.dataTransfer.files].filter(f => f.name.toLowerCase().endsWith(".pdf")));
  };
}

function importSummary(results, errors = []) {
  const lines = results.map(r => `${r.test}: ${r.questions} questions, ${r.wrong} wrong` +
    (r.warnings.length ? ` (⚠ ${r.warnings.join("; ")})` : ""));
  errors.forEach(e => lines.push(`✗ ${e.file}: ${e.error}`));
  return lines;
}

async function scan(force) {
  try {
    const r = await api("POST", "scan", { force });
    await reload();
    renderHome();
    const lines = importSummary(r.imported, r.errors);
    if (lines.length) alert("Import finished\n\n" + lines.join("\n"));
    else toast("No new PDFs found");
  } catch (e) {
    alert("Import failed: " + e.message);
  }
}

async function upload(files) {
  if (!files.length) return;
  const results = [], errors = [];
  for (const f of files) {
    try {
      results.push(await api("POST", "upload", f, { "X-Filename": encodeURIComponent(f.name) }));
    } catch (e) {
      errors.push({ file: f.name, error: e.message });
    }
  }
  await reload();
  renderHome();
  alert("Import finished\n\n" + importSummary(results, errors).join("\n"));
}

// ------------------------------------------------------------------ quiz engine

function startQuiz(modeKey, size) {
  const m = MODES[modeKey];
  const pool = m.pool();
  const ids = pool.slice(0, m.fixedSize ? m.size : size).map(q => q.id);
  if (!ids.length) return toast("Nothing to practise here yet 🎉");
  begin({ mode: modeKey, label: m.title, ids, exam: !!m.exam, requeue: !!m.requeue });
}

function startCustom(label, ids, { exam = false, requeue = false } = {}) {
  if (!ids.length) return toast("No questions");
  begin({ mode: exam ? "exam" : "custom", label, ids: exam ? ids : shuffle(ids), exam, requeue });
}

function begin({ mode, label, ids, exam, requeue }) {
  const order = {};
  for (const id of ids) {
    const q = DB.questions[id];
    const idx = q.options.map((_, i) => i);
    // Keep True/False in their natural order; shuffle everything else.
    const tf = q.options.length === 2 && q.options.every(o => /^(true|false)$/i.test(o));
    order[id] = tf ? idx : shuffle(idx);
  }
  QUIZ = {
    mode, label, exam, requeue,
    queue: [...ids],        // what is asked, in order (requeued items are appended)
    first: [...ids],        // the questions that count for the score
    order,
    pos: 0,
    selected: {},           // pos -> [option index]
    checked: {},            // pos -> bool (practice: answer revealed)
    firstResult: {},        // qid -> {ok, chosen}
    deltas: [],             // what each saved answer did to progress (for the results summary)
    marked: new Set(),      // exam: marked for review
    started: new Date().toISOString(),
    startMs: Date.now(),
    deadline: exam ? Date.now() + EXAM_SECONDS * 1000 : null,
    submitted: false,
  };
  if (location.hash === "#/quiz") router();
  else location.hash = "#/quiz";
}

function currentQ() {
  return DB.questions[QUIZ.queue[QUIZ.pos]];
}

function renderQuiz() {
  setNav("");
  const q = currentQ();
  const pos = QUIZ.pos;
  const sel = QUIZ.selected[pos] || [];
  const checked = !!QUIZ.checked[pos];
  const multi = isMulti(q);
  const total = QUIZ.queue.length;
  const isRetry = pos >= QUIZ.first.length;

  const optionHtml = QUIZ.order[q.id].map((oi, n) => {
    let cls = "";
    if (checked) {
      const isC = q.correct.includes(oi), isS = sel.includes(oi);
      cls = isC && isS ? "correct" : isS ? "wrong" : isC ? "missed" : "";
    } else if (sel.includes(oi)) cls = "selected";
    return `<button class="option ${cls}" data-opt="${oi}" ${checked ? "disabled" : ""} aria-pressed="${sel.includes(oi)}">
      <span class="key">${n + 1}</span><span>${esc(q.options[oi])}</span></button>`;
  }).join("");

  let feedback = "";
  if (checked) {
    const ok = sameSet(sel, q.correct);
    feedback = `<div class="feedback ${ok ? "ok" : "bad"}">
      <strong>${ok ? "✓ Correct" : "✗ Not quite"}</strong>
      ${ok ? "" : `<div>Answer: <b>${q.correct.map(i => esc(q.options[i])).join(" + ")}</b></div>`}
      ${q.explanation ? `<div class="small" style="margin-top:6px">${esc(q.explanation)}</div>` : ""}
      ${q.note ? `<div class="small" style="margin-top:6px">📝 ${esc(q.note)}</div>` : ""}
      ${progressNote(QUIZ.change?.[pos], ok)}
    </div>`;
  }

  const remaining = QUIZ.exam ? Math.max(0, (QUIZ.deadline - Date.now()) / 1000) : null;
  const answeredCount = Object.values(QUIZ.selected).filter(s => s.length).length;

  app.innerHTML = `
    <div class="quiz-head">
      <div><strong>${esc(QUIZ.label)}</strong>
        <div class="muted small">Question ${pos + 1} of ${total}${isRetry ? " · second chance" : ""}${QUIZ.exam ? ` · ${answeredCount} answered` : ""}</div></div>
      <div style="display:flex;gap:8px;align-items:center">
        ${QUIZ.exam ? `<span class="timer" id="timer">${fmtTime(remaining)}</span>` : ""}
        <button class="small" id="flag" title="Flag this question to practise later (F)">${q.flagged ? "★ Flagged" : "☆ Flag"}</button>
        <button class="small" id="quit">${QUIZ.exam ? "Abandon" : "Finish"}</button>
      </div>
    </div>
    <div class="bar"><span style="width:${(QUIZ.exam ? answeredCount : pos) / total * 100}%"></span></div>

    <div class="card" style="margin-top:16px">
      <div class="muted small">
        ${q.sources.map(s => s.result === "manual" ? "added by you" : `${esc(testShort(s.test))} ${s.result === "incorrect" ? "✗" : "✓"}`).join(" · ")}
        · <span class="badge ${level(q).cls}">${level(q).label}</span>
      </div>
      <div class="question">${esc(q.text)}</div>
      ${multi ? `<div class="badge accent" style="margin-bottom:10px">Select ${q.correct.length} answers${checked ? "" : ` · ${sel.length} chosen${sel.length > q.correct.length ? " – remove one" : ""}`}</div>` : ""}
      <div class="options">${optionHtml}</div>
      ${feedback}
      <div class="quiz-actions">
        <button id="prev" ${pos === 0 || !QUIZ.exam ? "hidden" : ""}>← Previous</button>
        ${QUIZ.exam ? `<button class="small" id="mark">${QUIZ.marked.has(pos) ? "Unmark review" : "Mark for review"}</button>` : "<span></span>"}
        ${QUIZ.exam
          ? (pos < total - 1 ? `<button class="primary" id="next">Next →</button>` : `<button class="primary" id="submit">Submit exam</button>`)
          : checked
            ? `<button class="primary" id="next">${pos < total - 1 ? "Next →" : "See results"}</button>`
            : `<button class="primary" id="check" ${readyToCheck(q, sel) ? "" : "disabled"}>Check</button>`}
      </div>
      ${QUIZ.exam ? `<div class="navgrid">${QUIZ.queue.map((_, i) => `<button class="${QUIZ.selected[i]?.length ? "answered" : ""} ${i === pos ? "current" : ""} ${QUIZ.marked.has(i) ? "flag" : ""}" data-jump="${i}" aria-label="Question ${i + 1}">${i + 1}</button>`).join("")}</div>
        ${pos < total - 1 ? `<div style="margin-top:12px"><button id="submit">Submit exam</button></div>` : ""}` : ""}
      <div class="kbd-hint"><kbd>1</kbd>–<kbd>${q.options.length}</kbd> choose · <kbd>Enter</kbd> ${QUIZ.exam ? "next" : "check / next"} · <kbd>F</kbd> flag${QUIZ.exam ? " · <kbd>←</kbd><kbd>→</kbd> move" : ""}</div>
    </div>`;

  $$("[data-opt]").forEach(b => b.onclick = () => choose(Number(b.dataset.opt)));
  $("#flag").onclick = toggleFlag;
  $("#quit").onclick = quit;
  $("#check")?.addEventListener("click", check);
  $("#next")?.addEventListener("click", next);
  $("#prev")?.addEventListener("click", () => go(pos - 1));
  $("#mark")?.addEventListener("click", () => { QUIZ.marked.has(pos) ? QUIZ.marked.delete(pos) : QUIZ.marked.add(pos); renderQuiz(); });
  $$("#submit").forEach(b => b.onclick = submitExam);
  $$("[data-jump]").forEach(b => b.onclick = () => go(Number(b.dataset.jump)));

  document.onkeydown = e => {
    if (e.target.matches?.("input, textarea, select") || modal.open || e.metaKey || e.ctrlKey) return;
    const n = Number(e.key);
    if (n >= 1 && n <= q.options.length) { e.preventDefault(); choose(QUIZ.order[q.id][n - 1]); }
    else if (e.key === "Enter") {
      e.preventDefault();
      if (QUIZ.exam) (pos < total - 1 ? next() : submitExam());
      else checked ? next() : (readyToCheck(q, sel) && check());
    } else if (e.key.toLowerCase() === "f") toggleFlag();
    else if (QUIZ.exam && e.key === "ArrowRight" && pos < total - 1) go(pos + 1);
    else if (QUIZ.exam && e.key === "ArrowLeft" && pos > 0) go(pos - 1);
  };

  clearInterval(timerHandle);
  if (QUIZ.exam) {
    timerHandle = setInterval(() => {
      const left = (QUIZ.deadline - Date.now()) / 1000;
      const el = $("#timer");
      if (el) { el.textContent = fmtTime(left); el.classList.toggle("low", left < 300); }
      if (left <= 0) { clearInterval(timerHandle); toast("Time is up!"); submitExam(true); }
    }, 1000);
  }
}

function progressNote(change, ok) {
  if (!change) return "";
  const M = MASTERED();
  const stepText = n => (n >= M ? "mastered" : `step ${n} of ${M}`);
  let text;
  if (!ok) {
    text = change.before > 0 ? `Back to step 0 of ${M} (was ${stepText(change.before)})` : `Still at step 0 of ${M}`;
    if (QUIZ.requeue) text += " · you'll get it again at the end of this round";
  } else if (change.counted) {
    text = change.after === M ? "🎉 Mastered – right on 3 separate days"
      : change.after > M ? "Mastered · check passed"
      : `+1 step: now ${stepText(change.after)} · the next step counts ${relDays(change.due)}`;
  } else {
    text = `Already counted today, so it stays at ${stepText(change.after)} · the next step counts ${relDays(change.due)}`;
  }
  return `<div class="small progress-note">${text}</div>`;
}

// What an answer did to a question's progress, from the server's reply.
function answerChange(before, q) {
  const last = q.stats.history[q.stats.history.length - 1];
  return { before, after: q.stats.streak, counted: !!last?.counted, due: q.stats.due };
}

function choose(optIdx) {
  const pos = QUIZ.pos;
  if (QUIZ.checked[pos]) return;
  const q = currentQ();
  let sel = QUIZ.selected[pos] || [];
  if (isMulti(q)) sel = sel.includes(optIdx) ? sel.filter(i => i !== optIdx) : [...sel, optIdx];
  else sel = [optIdx];
  QUIZ.selected[pos] = sel;
  renderQuiz();
}

function go(pos) {
  QUIZ.pos = pos;
  renderQuiz();
  window.scrollTo({ top: 0 });
}

// A question can only be checked with exactly as many options chosen as it has answers.
const readyToCheck = (q, sel) => sel.length === q.correct.length;

async function check() {
  const pos = QUIZ.pos, q = currentQ();
  const sel = QUIZ.selected[pos] || [];
  if (!readyToCheck(q, sel)) return;
  const ok = sameSet(sel, q.correct);
  QUIZ.checked[pos] = true;
  // Only the first answer to a question in a session goes into its lifetime counters.
  const first = !(q.id in QUIZ.firstResult);
  if (first) QUIZ.firstResult[q.id] = { ok, chosen: sel };
  if (!ok && QUIZ.requeue) QUIZ.queue.push(q.id);
  try {
    const before = q.stats.streak;
    DB.questions[q.id] = await api("POST", "answer", { qid: q.id, correct: ok, chosen: sel, count: first });
    const change = answerChange(before, DB.questions[q.id]);
    QUIZ.change = { ...QUIZ.change, [pos]: change };
    QUIZ.deltas.push(change);
  } catch (e) {
    toast("Could not save answer: " + e.message);
  }
  renderQuiz();
}

function next() {
  if (QUIZ.pos < QUIZ.queue.length - 1) return go(QUIZ.pos + 1);
  if (!QUIZ.exam) finish();
}

async function toggleFlag() {
  const q = currentQ();
  DB.questions[q.id] = await api("PATCH", `question/${q.id}`, { flagged: !q.flagged });
  toast(q.flagged ? "Flag removed" : "Flagged – find it under “Flagged”");
  renderQuiz();
}

function quit() {
  if (QUIZ.exam) {
    if (!confirm("Abandon this exam? Nothing will be saved.")) return;
    QUIZ = null;
    location.hash = "#/";
    return;
  }
  if (Object.keys(QUIZ.firstResult).length) finish();
  else { QUIZ = null; location.hash = "#/"; }
}

async function submitExam(timeUp = false) {
  if (QUIZ.submitted) return;
  const unanswered = QUIZ.queue.filter((_, i) => !QUIZ.selected[i]?.length).length;
  if (!timeUp && unanswered && !confirm(`${unanswered} question(s) unanswered. Submit anyway?`)) return;
  QUIZ.submitted = true;
  clearInterval(timerHandle);
  for (let i = 0; i < QUIZ.queue.length; i++) {
    const q = DB.questions[QUIZ.queue[i]];
    const sel = QUIZ.selected[i] || [];
    const ok = sameSet(sel, q.correct);
    QUIZ.firstResult[q.id] = { ok, chosen: sel };
    try {
      const before = q.stats.streak;
      DB.questions[q.id] = await api("POST", "answer", { qid: q.id, correct: ok, chosen: sel, count: true });
      QUIZ.deltas.push(answerChange(before, DB.questions[q.id]));
    } catch (e) { /* keep going, results still shown */ }
  }
  finish();
}

async function finish() {
  clearInterval(timerHandle);
  const answered = QUIZ.first.filter(id => id in QUIZ.firstResult);
  const score = answered.filter(id => QUIZ.firstResult[id].ok).length;
  QUIZ.result = {
    score, total: QUIZ.exam ? QUIZ.first.length : answered.length,
    seconds: Math.round((Date.now() - QUIZ.startMs) / 1000),
  };
  try {
    await api("POST", "session", {
      mode: QUIZ.mode, label: QUIZ.label, started: QUIZ.started, seconds: QUIZ.result.seconds,
      score, total: QUIZ.result.total,
      answers: answered.map(id => ({ qid: id, ok: QUIZ.firstResult[id].ok, chosen: QUIZ.firstResult[id].chosen })),
    });
    await reload();
  } catch (e) {
    toast("Could not save session: " + e.message);
  }
  location.hash = "#/results";
}

// ------------------------------------------------------------------ results

function renderResults() {
  setNav("");
  const { score, total, seconds } = QUIZ.result;
  const pct = total ? score / total : 0;
  const passed = pct >= PASS_RATIO;
  const ids = QUIZ.first.filter(id => id in QUIZ.firstResult);
  const wrong = ids.filter(id => !QUIZ.firstResult[id].ok);
  const d = QUIZ.deltas;
  const steps = d.filter(c => c.counted).length;
  const mastered = d.filter(c => c.counted && c.after === MASTERED()).length;
  const slipped = d.filter(c => c.before > 0 && c.after === 0).length;
  const already = d.filter(c => !c.counted && c.after > 0 && c.after === c.before).length;

  app.innerHTML = `
    <div class="card result-hero">
      <div class="muted">${esc(QUIZ.label)}</div>
      <div class="big">${score} / ${total}</div>
      <div>${Math.round(pct * 100)}% · ${fmtTime(seconds)}
        ${QUIZ.exam ? `<span class="badge ${passed ? "ok" : "bad"}">${passed ? "✓ PASS" : "✗ FAIL"} (need ${Math.ceil(total * PASS_RATIO)})</span>` : ""}</div>
      <div class="result-progress">
        <span class="${steps ? "good" : ""}"><b>+${steps}</b> step${steps === 1 ? "" : "s"}</span>
        <span class="${mastered ? "good" : ""}"><b>${mastered}</b> newly mastered</span>
        <span class="${slipped ? "bad" : ""}"><b>${slipped}</b> slipped back</span>
        ${already ? `<span class="muted"><b>${already}</b> already counted today</span>` : ""}
      </div>
      <div style="margin-top:16px;display:flex;gap:8px;justify-content:center;flex-wrap:wrap">
        ${wrong.length ? `<button class="primary" id="retry">Practise the ${wrong.length} I got wrong</button>` : ""}
        <a class="btn" href="#/">Dashboard</a>
      </div>
    </div>
    <section style="margin-top:24px">
      <h2>${wrong.length ? "Review" : "All correct – nice!"}</h2>
      ${[...wrong, ...ids.filter(id => QUIZ.firstResult[id].ok)].map(id => reviewItem(DB.questions[id], QUIZ.firstResult[id])).join("")}
    </section>`;
  $("#retry")?.addEventListener("click", () => startCustom(`${QUIZ.label} – retry`, wrong, { requeue: true }));
}

function reviewItem(q, r) {
  if (!q) return "";
  return `<details class="card qitem" ${r.ok ? "" : "open"}>
    <summary><span class="badge ${r.ok ? "ok" : "bad"}">${r.ok ? "✓" : "✗"}</span><span class="qtext">${esc(q.text)}</span></summary>
    <ul>${q.options.map((o, i) => `<li class="${q.correct.includes(i) ? "is-correct" : ""}">${esc(o)}
      ${r.chosen.includes(i) ? `<span class="badge ${q.correct.includes(i) ? "ok" : "bad"}">your answer</span>` : ""}</li>`).join("")}</ul>
    ${r.chosen.length ? "" : `<p class="small"><span class="badge bad">not answered</span></p>`}
    ${q.explanation ? `<div class="small muted">${esc(q.explanation)}</div>` : ""}
  </details>`;
}

// ------------------------------------------------------------------ question bank

const BANK = { search: "", filter: "all", sort: "test", dir: 1 };

const countsOf = q => q.counts || { right: 0, wrong: 0 };
// State order for sorting: New, then Learning by step, then Mastered.
const stateRank = q => ({ New: 0, Learning: 1 + step(q), Mastered: 1 + MASTERED() }[state(q)]);

const BANK_FILTERS = [
  ["all", "All questions"],
  ["Progress", [["state:New", "New"], ["state:Learning", "Learning (any step)"], ["step:0", "Learning · step 0"],
    ["step:1", "Learning · step 1"], ["step:2", "Learning · step 2"], ["state:Mastered", "Mastered"],
    ["due", "Ready to count now"]]],
  ["Marks", [["missed", "Missed before"], ["fix", "Missed, not yet mastered"], ["testwrong", "Wrong in a PDF test"],
    ["flagged", "Flagged"], ["noted", "With a note"]]],
];

// One definition of every filter, shared by the bank and the dashboard ladder.
function bankMatches(q, f) {
  if (f === "all") return true;
  if (f.startsWith("state:")) return state(q) === f.slice(6);
  if (f.startsWith("step:")) return state(q) === "Learning" && step(q) === Number(f.slice(5));
  if (f.startsWith("test:")) return q.sources.some(s => s.test === f.slice(5));
  return {
    due: isDue, missed: missedBefore, fix: needsFix, testwrong: q => wasWrongInTest(q),
    flagged: q => q.flagged, noted: q => !!q.note,
  }[f]?.(q) ?? true;
}

// Each sort's natural first direction: counts start with the biggest numbers.
const BANK_SORTS = [
  ["test", "Test order", 1], ["state", "State", 1], ["right", "Times right", -1], ["wrong", "Times wrong", -1],
  ["weak", "Weakest first", 1], ["recent", "Recently practised", 1], ["alpha", "A–Z", 1],
];

function renderBank(preset) {
  if (preset) BANK.filter = decodeURIComponent(preset);
  const tests = Object.values(DB.tests).sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }));
  app.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
      <h1>Question bank</h1>
      <button class="primary" id="add-q">+ Add question</button>
    </div>
    <div class="filters">
      <input type="search" id="bank-search" placeholder="Search questions, answers, explanations…" value="${esc(BANK.search)}">
      <select id="bank-filter" aria-label="Filter">
        ${BANK_FILTERS.map(([v, l]) => Array.isArray(l)
          ? `<optgroup label="${v}">${l.map(([v2, l2]) => `<option value="${v2}" ${BANK.filter === v2 ? "selected" : ""}>${l2}</option>`).join("")}</optgroup>`
          : `<option value="${v}" ${BANK.filter === v ? "selected" : ""}>${l}</option>`).join("")}
        <optgroup label="By test">
          ${tests.map(t => `<option value="test:${t.id}" ${BANK.filter === "test:" + t.id ? "selected" : ""}>${esc(t.title)}</option>`).join("")}
        </optgroup>
      </select>
      <select id="bank-sort" aria-label="Sort">
        ${BANK_SORTS.map(([v, l]) => `<option value="${v}" ${BANK.sort === v ? "selected" : ""}>Sort: ${l}</option>`).join("")}
      </select>
      <button id="bank-dir" title="Reverse the order" aria-label="Reverse the order"></button>
    </div>
    <div class="muted small" id="bank-count" style="margin-bottom:8px"></div>
    <div id="bank-list"></div>
    <div style="margin-top:12px" id="bank-practise"></div>`;

  $("#bank-search").oninput = e => { BANK.search = e.target.value; drawBankList(); };
  $("#bank-filter").onchange = e => { BANK.filter = e.target.value; drawBankList(); };
  $("#bank-sort").onchange = e => {
    BANK.sort = e.target.value;
    BANK.dir = BANK_SORTS.find(([v]) => v === BANK.sort)[2];
    drawBankList();
  };
  $("#bank-dir").onclick = () => { BANK.dir = -BANK.dir; drawBankList(); };
  $("#add-q").onclick = () => editQuestion(null);
  drawBankList();
}

function bankFiltered() {
  const testOrder = {};
  Object.values(DB.tests).sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }))
    .forEach((t, ti) => t.questions.forEach((id, qi) => { if (!(id in testOrder)) testOrder[id] = ti * 1000 + qi; }));
  const f = BANK.filter;
  const terms = BANK.search.toLowerCase().split(/\s+/).filter(Boolean);
  let qs = allQs().filter(q => {
    if (!bankMatches(q, f)) return false;
    if (terms.length) {
      const hay = [q.text, ...q.options, q.explanation, q.note].join(" ").toLowerCase();
      if (!terms.every(t => hay.includes(t))) return false;
    }
    return true;
  });
  const byTest = (a, b) => (testOrder[a.id] ?? 1e9) - (testOrder[b.id] ?? 1e9);
  const sorters = {
    test: byTest,
    state: (a, b) => stateRank(a) - stateRank(b),
    right: (a, b) => countsOf(a).right - countsOf(b).right,
    wrong: (a, b) => countsOf(a).wrong - countsOf(b).wrong,
    weak: (a, b) => weakness(a) - weakness(b),
    recent: (a, b) => (b.stats.last_seen || "").localeCompare(a.stats.last_seen || ""),
    alpha: (a, b) => a.text.localeCompare(b.text),
  };
  // Ties keep test order whichever way the list is sorted.
  return qs.sort((a, b) => sorters[BANK.sort](a, b) * BANK.dir || byTest(a, b));
}

function drawBankList() {
  const qs = bankFiltered();
  $("#bank-dir").textContent = BANK.dir > 0 ? "▲ Ascending" : "▼ Descending";
  $("#bank-count").textContent = `${qs.length} question${qs.length === 1 ? "" : "s"}`;
  $("#bank-list").innerHTML = qs.length ? qs.map(bankItem).join("") : `<div class="card empty">No questions match.</div>`;
  $("#bank-practise").innerHTML = qs.length ? `<button class="primary" id="practise-these">Practise these ${qs.length}</button>` : "";
  $("#practise-these")?.addEventListener("click", () => startCustom("Question bank selection", qs.map(q => q.id), { requeue: true }));
  $$("[data-act]", $("#bank-list")).forEach(b => b.onclick = () => bankAction(b.dataset.act, b.dataset.id));
}

function bankItem(q) {
  const lv = level(q);
  const acc = accuracy(q);
  const hist = q.stats.history.slice(-8);
  const c = countsOf(q);
  return `<details class="card qitem">
    <summary>
      <span class="qtext">${q.flagged ? "★ " : ""}${esc(q.text)}</span>
      <span class="counts" title="Times answered right / wrong across all quizzes (first answer per quiz)">
        <span class="${c.right ? "c-right" : ""}" aria-label="${c.right} right">✓ ${c.right}</span>
        <span class="${c.wrong ? "c-wrong" : ""}" aria-label="${c.wrong} wrong">✗ ${c.wrong}</span>
      </span>
      ${missedBefore(q) ? `<span class="mark-missed-badge" title="Missed before: got wrong at least once">missed</span>` : ""}
      <span class="badge ${lv.cls}">${lv.label === "Learning" ? `Learning · ${step(q)}/${MASTERED()}` : lv.label}</span>
    </summary>
    <ul>${q.options.map((o, i) => `<li class="${q.correct.includes(i) ? "is-correct" : ""}">${q.correct.includes(i) ? "✓ " : ""}${esc(o)}</li>`).join("")}</ul>
    ${q.explanation ? `<p class="small muted">${esc(q.explanation)}</p>` : ""}
    ${q.note ? `<p class="small">📝 ${esc(q.note)}</p>` : ""}
    <p class="small muted">
      ${q.sources.map(s => s.result === "manual" ? "added by you" : `${esc(testShort(s.test))}: ${s.result === "incorrect" ? "✗ wrong" : "✓ right"}`).join(" · ")}
      · practised ${q.stats.seen}× ${acc === null ? "" : `(${Math.round(acc * 100)}% right)`}
      · last answered ${relAgo(q.stats.last_seen)} · ${isDue(q) ? "a right answer counts now" : `already counted ${relAgo(q.stats.last_counted)}`}
      ${hist.length ? `<span class="dots" title="last answers, oldest first">${hist.map(h => `<i class="${h.ok ? "ok" : "bad"}"></i>`).join("")}</span>` : ""}
    </p>
    <div class="actions">
      <button class="small" data-act="practise" data-id="${q.id}">Practise</button>
      <button class="small" data-act="flag" data-id="${q.id}">${q.flagged ? "Unflag" : "Flag"}</button>
      <button class="small" data-act="edit" data-id="${q.id}">Edit / note</button>
      <button class="small" data-act="reset" data-id="${q.id}">Reset stats</button>
      <button class="small danger" data-act="delete" data-id="${q.id}">Delete</button>
    </div>
  </details>`;
}

async function bankAction(act, id) {
  const q = DB.questions[id];
  try {
    if (act === "practise") return startCustom("Single question", [id]);
    if (act === "edit") return editQuestion(q);
    if (act === "flag") DB.questions[id] = await api("PATCH", `question/${id}`, { flagged: !q.flagged });
    if (act === "reset") {
      if (!confirm("Reset practice stats for this question?")) return;
      DB.questions[id] = await api("PATCH", `question/${id}`, { reset_stats: true });
    }
    if (act === "delete") {
      if (!confirm(`Delete this question?\n\n${q.text}`)) return;
      await api("DELETE", `question/${id}`);
      await reload();
    }
    const open = $$("details[open] [data-act]", $("#bank-list")).map(b => b.dataset.id);
    drawBankList();
    // keep the item the user was working on expanded
    open.forEach(oid => $(`[data-id="${oid}"]`)?.closest("details")?.setAttribute("open", ""));
  } catch (e) {
    alert(e.message);
  }
}

function editQuestion(q) {
  const isNew = !q;
  const draft = q ? { text: q.text, options: [...q.options], correct: [...q.correct], explanation: q.explanation, note: q.note }
                  : { text: "", options: ["", "", "", ""], correct: [], explanation: "", note: "" };

  const draw = () => {
    modal.innerHTML = `
      <form method="dialog" id="qform">
        <h2>${isNew ? "Add question" : "Edit question"}</h2>
        <div class="form-row"><label for="f-text">Question</label><textarea id="f-text" required>${esc(draft.text)}</textarea></div>
        <div class="form-row"><label>Options <span class="muted small">(tick every correct one)</span></label>
          ${draft.options.map((o, i) => `<div class="opt-edit">
            <input type="checkbox" data-correct="${i}" ${draft.correct.includes(i) ? "checked" : ""} aria-label="Option ${i + 1} is correct">
            <input type="text" data-opt="${i}" value="${esc(o)}" placeholder="Option ${i + 1}">
            <button type="button" class="small" data-remove="${i}" aria-label="Remove option">✕</button></div>`).join("")}
          <button type="button" class="small" id="add-opt">+ option</button>
        </div>
        <div class="form-row"><label for="f-expl">Explanation</label><textarea id="f-expl">${esc(draft.explanation)}</textarea></div>
        <div class="form-row"><label for="f-note">My note / mnemonic</label><textarea id="f-note" placeholder="e.g. SMs = Senedd Members (Wales)">${esc(draft.note)}</textarea></div>
        <div class="dialog-actions">
          <button type="button" id="cancel">Cancel</button>
          <button type="submit" class="primary">Save</button>
        </div>
      </form>`;
    const sync = () => {
      draft.text = $("#f-text", modal).value;
      draft.explanation = $("#f-expl", modal).value;
      draft.note = $("#f-note", modal).value;
      draft.options = $$("[data-opt]", modal).map(i => i.value);
      draft.correct = $$("[data-correct]", modal).filter(c => c.checked).map(c => Number(c.dataset.correct));
    };
    $("#add-opt", modal).onclick = () => { sync(); draft.options.push(""); draw(); };
    $$("[data-remove]", modal).forEach(b => b.onclick = () => {
      sync();
      const r = Number(b.dataset.remove);
      draft.options.splice(r, 1);
      draft.correct = draft.correct.filter(c => c !== r).map(c => (c > r ? c - 1 : c));
      draw();
    });
    $("#cancel", modal).onclick = () => modal.close();
    $("#qform", modal).onsubmit = async e => {
      e.preventDefault();
      sync();
      // drop empty options but keep correct indices aligned
      const keep = draft.options.map((o, i) => [o.trim(), i]).filter(([o]) => o);
      const body = {
        text: draft.text.trim(),
        options: keep.map(([o]) => o),
        correct: keep.map(([, i], n) => (draft.correct.includes(i) ? n : -1)).filter(n => n >= 0),
        explanation: draft.explanation.trim(),
        note: draft.note.trim(),
      };
      try {
        if (isNew) {
          const created = await api("POST", "question", body);
          await api("PATCH", `question/${created.id}`, { explanation: body.explanation, note: body.note });
        } else {
          await api("PATCH", `question/${q.id}`, body);
        }
        await reload();
        modal.close();
        toast("Saved");
        if (location.hash.startsWith("#/bank")) drawBankList(); else router();
      } catch (err) {
        alert(err.message);
      }
    };
  };
  draw();
  modal.showModal();
}

// ------------------------------------------------------------------ history

function renderHistory() {
  const sessions = [...DB.sessions].reverse();
  const exams = DB.sessions.filter(s => s.mode === "exam");
  const best = exams.length ? Math.max(...exams.map(s => s.score / s.total)) : null;
  app.innerHTML = `
    <h1>History</h1>
    <div class="grid tiles" style="margin-bottom:16px">
      ${tile(DB.sessions.length, "quizzes taken")}
      ${tile(DB.sessions.reduce((n, s) => n + (s.total || 0), 0), "questions answered")}
      ${tile(exams.length, "mock exams")}
      ${tile(best === null ? "–" : `${Math.round(best * 100)}%`, "best mock exam")}
    </div>
    ${sessions.length ? `<div class="card table-wrap"><table>
      <thead><tr><th>When</th><th>Quiz</th><th class="num">Score</th><th class="num hide-sm">Time</th><th style="width:30%" class="hide-sm">Result</th></tr></thead>
      <tbody>${sessions.map(s => {
        const pct = s.total ? s.score / s.total : 0;
        const pass = pct >= PASS_RATIO;
        return `<tr>
          <td class="small">${fmtDate(s.finished)}</td>
          <td>${esc(s.label || s.mode)}</td>
          <td class="num">${s.score}/${s.total}</td>
          <td class="num hide-sm">${fmtTime(s.seconds || 0)}</td>
          <td class="hide-sm"><div style="display:flex;gap:8px;align-items:center">
            <div class="bar ${pass ? "ok" : ""}" style="flex:1"><span style="width:${pct * 100}%"></span></div>
            <span class="small" style="width:3.5em;text-align:right">${Math.round(pct * 100)}%</span>
            <span style="width:4.5em">${s.mode === "exam" ? `<span class="badge ${pass ? "ok" : "bad"}">${pass ? "✓ pass" : "✗ fail"}</span>` : ""}</span></div></td>
        </tr>`;
      }).join("")}</tbody></table></div>` : `<div class="card empty">No quizzes yet – start one from the dashboard.</div>`}`;
}

// ------------------------------------------------------------------ theme

(function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem("theme"); } catch (e) { /* ignore */ }
  if (saved) document.documentElement.dataset.theme = saved;
  $("#theme-toggle").onclick = () => {
    const dark = document.documentElement.dataset.theme
      ? document.documentElement.dataset.theme === "dark"
      : matchMedia("(prefers-color-scheme: dark)").matches;
    const next = dark ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("theme", next); } catch (e) { /* ignore */ }
  };
})();

window.addEventListener("beforeunload", e => {
  if (QUIZ && !QUIZ.result && Object.keys(QUIZ.selected).length) e.preventDefault();
});

router();
