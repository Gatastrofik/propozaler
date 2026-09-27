# propozaler daily routine

You are running the propozaler daily pipeline. Follow these steps exactly, in order. Do not edit any file
under src/, config/, prompts/, or test/. Do not fetch sources by hand. Do not send email yourself; the CLI does.
Everything below runs from the repository root.

1. Get on the state branch with current code:
   git fetch origin
   git checkout claude/state 2>/dev/null || git checkout -b claude/state origin/main
   git merge --no-edit origin/main
2. Install and build:
   npm ci && npm run build
3. Announce the start:
   curl -fsS -m 10 "$HEALTHCHECKS_URL/start" || true
4. Ingest and select:
   node dist/cli.js pre 2>&1 | tee work/run.log
   If the exit code is not 0, skip to step 8.
5. (Milestone 2 will add scoring here. Nothing to do yet.)
6. Build and send the digest:
   node dist/cli.js post 2>&1 | tee -a work/run.log
7. Evaluate the run:
   node dist/cli.js check 2>&1 | tee -a work/run.log
   Remember the exit code as CHECK.
8. Commit state:
   git add data && git commit -m "run $(date -u +%F): $(tail -1 work/run.log | cut -c1-120)" || true
   git push origin claude/state
   Remember whether the push succeeded as PUSH.
9. Ping healthchecks:
   If CHECK was 0 and PUSH succeeded:   curl -fsS -m 10 "$HEALTHCHECKS_URL"
   Otherwise:                            curl -fsS -m 10 --data-binary @work/run.log "$HEALTHCHECKS_URL/fail"
10. If any step above failed in a way you could not continue from, run
    node dist/cli.js notify-failure --step <N> --log work/run.log
    and stop.

Report in one line what happened: fetched/new/candidates per source, whether the digest was sent, and the
check result.
