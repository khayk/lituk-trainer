#!/bin/bash
# Double-click in Finder (or run ./start.command) to start the quiz app.
cd "$(dirname "$0")" && exec python3 server.py "$@"
