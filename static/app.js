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

function relDays(iso) {
  if (!iso) return "now";
  const days = Math.round((new Date(iso) - Date.now()) / 86400000);
  if (days <= 0) return "now";
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

const allQs = () => Object.values(DB.questions);
const masteredBox = () => DB.config.mastered_box;
const wasWrongInTest = (q, testId) => q.sources.some(s => s.result === "incorrect" && (!testId || s.test === testId));
const wasWrongHere = q => q.stats.history.some(h => !h.ok);
const isMastered = q => q.stats.box >= masteredBox();
const isDue = q => !q.stats.due || new Date(q.stats.due) <= new Date();
const needsFix = q => (wasWrongInTest(q) || wasWrongHere(q)) && !isMastered(q);
const accuracy = q => (q.stats.seen ? q.stats.right / q.stats.seen : null);
const isMulti = q => q.correct.length > 1;

function level(q) {
  if (isMastered(q)) return { label: "Mastered", cls: "ok" };
  if (q.stats.box === 0 && (wasWrongInTest(q) || wasWrongHere(q))) return { label: "To fix", cls: "bad" };
  if (q.stats.seen === 0) return { label: "New", cls: "" };
  return { label: "Learning", cls: "warn" };
}

function testShort(id) {
  const t = DB.tests[id];
  return t ? t.title.replace(/^Test\s*/i, "T") : id;
}

function weakness(q) {
  // Lower = weaker. Box dominates, accuracy breaks ties, unseen mistakes first.
  const acc = accuracy(q);
  return q.stats.box * 10 + (acc === null ? (wasWrongInTest(q) ? 0 : 5) : acc * 9);
}

const MODES = {
  fix: {
    title: "Fix my mistakes",
    desc: "Questions you got wrong in a test or here, until they are mastered (right on 3 separate days). Wrong answers come back at the end of the round.",
    pool: () => shuffle(allQs().filter(needsFix)).sort((a, b) => a.stats.box - b.stats.box),
    requeue: true, size: 20,
  },
  review: {
    title: "Spaced review",
    desc: "Questions that are due. Each right answer pushes a question further out (1, 2, 4, 8… days); a wrong answer brings it back to today.",
    pool: () => shuffle(allQs().filter(isDue)).sort((a, b) => a.stats.box - b.stats.box),
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
    desc: "The questions with your lowest box and accuracy, regardless of whether they are due.",
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
  const mastered = qs.filter(isMastered).length;
  // Partial credit: each box up to the mastery box counts, so progress shows after one quiz.
  const progress = qs.length ? qs.reduce((n, q) => n + Math.min(q.stats.box, masteredBox()), 0) / (qs.length * masteredBox()) : 0;
  const byLevel = { Mastered: 0, Learning: 0, New: 0, "To fix": 0 };
  qs.forEach(q => byLevel[level(q).label]++);
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
    fix: toFix, review: due, exam: qs.length, weak: qs.length,
    flagged: qs.filter(q => q.flagged).length, all: qs.length,
  };

  app.innerHTML = `
    <section>
      <h1>Life in the UK – practice</h1>
      <div class="grid tiles">
        ${tile(qs.length, "questions in your bank")}
        ${tile(toFix, "mistakes still to fix")}
        ${tile(due, "due for review now")}
        ${tile(`${Math.round(progress * 100)}%`, `progress to mastery · ${mastered} of ${qs.length} mastered`)}
        ${tile(examAvg === null ? "–" : `${Math.round(examAvg * 100)}%`,
              examAvg === null ? "no mock exams yet" : `avg of last ${exams.length} mock exams · ${examPasses} passed`)}
      </div>
      <div class="stack" style="margin-top:12px" role="img"
           aria-label="${Object.entries(byLevel).map(([k, v]) => `${k}: ${v}`).join(", ")}">
        ${Object.entries(byLevel).filter(([, v]) => v).map(([k, v]) =>
          `<span class="seg-${k.replace(" ", "")}" style="flex:${v}" title="${k}: ${v}"></span>`).join("")}
      </div>
      <div class="legend small">
        ${Object.entries(byLevel).map(([k, v]) => `<span><i class="seg-${k.replace(" ", "")}"></i>${k} <b>${v}</b></span>`).join("")}
        <span class="muted">A question is mastered after 3 right answers spaced out over days (today, then 1 and 2 days later); a wrong answer starts it over.</span>
      </div>
    </section>

    <section>
      <h2>Start a quiz</h2>
      <div class="grid modes">
        ${Object.entries(MODES).map(([key, m]) => modeCard(key, m, counts[key])).join("")}
      </div>
    </section>

    <section>
      <h2>Your tests</h2>
      <div class="card table-wrap">
        <table>
          <thead><tr><th>Test</th><th class="num">Score</th><th class="num hide-sm">Mistakes left</th><th class="hide-sm">Imported</th><th></th></tr></thead>
          <tbody>
          ${tests.map(t => {
            const tq = t.questions.map(id => DB.questions[id]).filter(Boolean);
            const wrong = tq.filter(q => wasWrongInTest(q, t.id));
            const left = wrong.filter(q => !isMastered(q)).length;
            const passed = t.score / t.total >= PASS_RATIO;
            return `<tr>
              <td><strong>${esc(t.title)}</strong> <span class="muted small">${esc(t.file)}</span>
                ${t.warnings?.length ? `<span class="badge warn" title="${esc(t.warnings.join("; "))}">⚠ check</span>` : ""}</td>
              <td class="num">${t.score}/${t.total} <span class="badge ${passed ? "ok" : "bad"}">${passed ? "✓ pass" : "✗ fail"}</span></td>
              <td class="num hide-sm">${left} of ${wrong.length}</td>
              <td class="hide-sm muted small">${fmtDate(t.imported)}</td>
              <td style="white-space:nowrap;text-align:right">
                <button class="small" data-test-mistakes="${t.id}" ${wrong.length ? "" : "disabled"}>Mistakes</button>
                <button class="small" data-test-retake="${t.id}">Retake</button>
              </td>
            </tr>`;
          }).join("")}
          </tbody>
        </table>
      </div>
    </section>

    ${importSection()}

    <section>
      <h2>Data</h2>
      <div class="card" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <a class="btn small" href="/api/export">Download backup</a>
        <button class="small" id="rescan-force">Re-import all PDFs</button>
        <button class="small danger" id="reset-progress">Reset all progress</button>
        <span class="muted small">Stored in <code>quiz-app/data/db.json</code>; a backup is taken before every import or reset.</span>
      </div>
    </section>
  `;

  $$("[data-mode]").forEach(btn => btn.onclick = () => {
    const key = btn.dataset.mode;
    const size = $(`[data-size="${key}"]`)?.value ?? MODES[key].size;
    startQuiz(key, size === "all" ? Infinity : Number(size));
  });
  $$("[data-test-mistakes]").forEach(btn => btn.onclick = () => {
    const t = DB.tests[btn.dataset.testMistakes];
    const ids = t.questions.filter(id => DB.questions[id] && wasWrongInTest(DB.questions[id], t.id));
    startCustom(`${t.title} – mistakes`, ids, { requeue: true });
  });
  $$("[data-test-retake]").forEach(btn => btn.onclick = () => {
    const t = DB.tests[btn.dataset.testRetake];
    startCustom(`${t.title} – retake`, t.questions.filter(id => DB.questions[id]), { exam: true });
  });
  $("#rescan-force").onclick = () => scan(true);
  $("#reset-progress").onclick = async () => {
    if (!confirm("Reset all progress and quiz history? Questions are kept, and a backup is saved first.")) return;
    await api("POST", "reset-progress");
    await reload();
    toast("Progress reset");
    renderHome();
  };
  bindImport();
}

function tile(value, label) {
  return `<div class="card tile"><div class="value">${value}</div><div class="label">${esc(label)}</div></div>`;
}

function modeCard(key, m, count) {
  const sizes = m.fixedSize ? [] : [10, 20, 30, "all"];
  const disabled = !count;
  return `<div class="card mode">
    <h3>${esc(m.title)} <span class="badge ${key === "fix" && count ? "bad" : ""}">${count}</span></h3>
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
      ${multi ? `<div class="badge accent" style="margin-bottom:10px">Select ${q.correct.length} answers</div>` : ""}
      <div class="options">${optionHtml}</div>
      ${feedback}
      <div class="quiz-actions">
        <button id="prev" ${pos === 0 || !QUIZ.exam ? "hidden" : ""}>← Previous</button>
        ${QUIZ.exam ? `<button class="small" id="mark">${QUIZ.marked.has(pos) ? "Unmark review" : "Mark for review"}</button>` : "<span></span>"}
        ${QUIZ.exam
          ? (pos < total - 1 ? `<button class="primary" id="next">Next →</button>` : `<button class="primary" id="submit">Submit exam</button>`)
          : checked
            ? `<button class="primary" id="next">${pos < total - 1 ? "Next →" : "See results"}</button>`
            : `<button class="primary" id="check" ${sel.length ? "" : "disabled"}>Check</button>`}
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
      else checked ? next() : (sel.length && check());
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

async function check() {
  const pos = QUIZ.pos, q = currentQ();
  const sel = QUIZ.selected[pos] || [];
  if (!sel.length) return;
  const ok = sameSet(sel, q.correct);
  QUIZ.checked[pos] = true;
  if (!(q.id in QUIZ.firstResult)) QUIZ.firstResult[q.id] = { ok, chosen: sel };
  if (!ok && QUIZ.requeue) QUIZ.queue.push(q.id);
  try {
    DB.questions[q.id] = await api("POST", "answer", { qid: q.id, correct: ok, chosen: sel });
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
      DB.questions[q.id] = await api("POST", "answer", { qid: q.id, correct: ok, chosen: sel });
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

  app.innerHTML = `
    <div class="card result-hero">
      <div class="muted">${esc(QUIZ.label)}</div>
      <div class="big">${score} / ${total}</div>
      <div>${Math.round(pct * 100)}% · ${fmtTime(seconds)}
        ${QUIZ.exam ? `<span class="badge ${passed ? "ok" : "bad"}">${passed ? "✓ PASS" : "✗ FAIL"} (need ${Math.ceil(total * PASS_RATIO)})</span>` : ""}</div>
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

const BANK = { search: "", filter: "all", sort: "test" };

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
        ${[["all", "All questions"], ["fix", "Mistakes to fix"], ["testwrong", "Wrong in a test"], ["due", "Due for review"],
           ["mastered", "Mastered"], ["new", "Never practised"], ["flagged", "Flagged"], ["noted", "With a note"]]
          .map(([v, l]) => `<option value="${v}" ${BANK.filter === v ? "selected" : ""}>${l}</option>`).join("")}
        <optgroup label="By test">
          ${tests.map(t => `<option value="test:${t.id}" ${BANK.filter === "test:" + t.id ? "selected" : ""}>${esc(t.title)}</option>`).join("")}
        </optgroup>
      </select>
      <select id="bank-sort" aria-label="Sort">
        ${[["test", "Test order"], ["weak", "Weakest first"], ["recent", "Recently practised"], ["alpha", "A–Z"]]
          .map(([v, l]) => `<option value="${v}" ${BANK.sort === v ? "selected" : ""}>${l}</option>`).join("")}
      </select>
    </div>
    <div class="muted small" id="bank-count" style="margin-bottom:8px"></div>
    <div id="bank-list"></div>
    <div style="margin-top:12px" id="bank-practise"></div>`;

  $("#bank-search").oninput = e => { BANK.search = e.target.value; drawBankList(); };
  $("#bank-filter").onchange = e => { BANK.filter = e.target.value; drawBankList(); };
  $("#bank-sort").onchange = e => { BANK.sort = e.target.value; drawBankList(); };
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
    if (f === "fix" && !needsFix(q)) return false;
    if (f === "testwrong" && !wasWrongInTest(q)) return false;
    if (f === "due" && !isDue(q)) return false;
    if (f === "mastered" && !isMastered(q)) return false;
    if (f === "new" && q.stats.seen) return false;
    if (f === "flagged" && !q.flagged) return false;
    if (f === "noted" && !q.note) return false;
    if (f.startsWith("test:") && !q.sources.some(s => s.test === f.slice(5))) return false;
    if (terms.length) {
      const hay = [q.text, ...q.options, q.explanation, q.note].join(" ").toLowerCase();
      if (!terms.every(t => hay.includes(t))) return false;
    }
    return true;
  });
  const sorters = {
    test: (a, b) => (testOrder[a.id] ?? 1e9) - (testOrder[b.id] ?? 1e9),
    weak: (a, b) => weakness(a) - weakness(b),
    recent: (a, b) => (b.stats.last_seen || "").localeCompare(a.stats.last_seen || ""),
    alpha: (a, b) => a.text.localeCompare(b.text),
  };
  return qs.sort(sorters[BANK.sort]);
}

function drawBankList() {
  const qs = bankFiltered();
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
  return `<details class="card qitem">
    <summary>
      <span class="qtext">${q.flagged ? "★ " : ""}${esc(q.text)}</span>
      <span class="badge ${lv.cls}">${lv.label}</span>
    </summary>
    <ul>${q.options.map((o, i) => `<li class="${q.correct.includes(i) ? "is-correct" : ""}">${q.correct.includes(i) ? "✓ " : ""}${esc(o)}</li>`).join("")}</ul>
    ${q.explanation ? `<p class="small muted">${esc(q.explanation)}</p>` : ""}
    ${q.note ? `<p class="small">📝 ${esc(q.note)}</p>` : ""}
    <p class="small muted">
      ${q.sources.map(s => s.result === "manual" ? "added by you" : `${esc(testShort(s.test))}: ${s.result === "incorrect" ? "✗ wrong" : "✓ right"}`).join(" · ")}
      · practised ${q.stats.seen}× ${acc === null ? "" : `(${Math.round(acc * 100)}% right)`}
      · box ${q.stats.box}/${DB.config.mastered_box} to master · next review ${relDays(q.stats.due)}
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
