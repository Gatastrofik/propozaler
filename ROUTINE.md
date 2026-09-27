# propozaler daily routine

You are running the propozaler daily pipeline. Follow these steps exactly, in order. Do not edit any file
under src/, config/, prompts/, or test/. Do not fetch sources by hand. Do not send email yourself; the CLI does.
Everything below runs from the repository root.

1. Get on the state branch with current code:
   git fetch origin
   git checkout claude/state 2>/dev/null || git checkout -b claude/state origin/main
   git merge --no-edit origin/main
2. Install and build:
   mkdir -p work && npm ci && npm run build
3. Announce the start:
   curl -fsS -m 10 "$HEALTHCHECKS_URL/start" || true
4. Ingest and select:
   node dist/cli.js pre > work/pre.log 2>&1; PRE=$?; cat work/pre.log >> work/run.log; cat work/pre.log
   If the exit code is not 0 ($PRE), skip to step 8.
5. (Milestone 2 will add scoring here. Nothing to do yet.)
6. Build and send the digest:
   node dist/cli.js post > work/post.log 2>&1; POST=$?; cat work/post.log >> work/run.log; cat work/post.log

   Only if the Task 15 probe showed SMTP is blocked from the sandbox, use this fallback instead of the
   command above:
   node dist/cli.js post --no-send > work/post.log 2>&1; POST=$?; cat work/post.log >> work/run.log; cat work/post.log
   Read `work/digest.meta.json` for `to` and `subject`. Send `work/digest.html` (with `work/digest.txt` as
   the plain-text part) through the Gmail connector on the dedicated account to that `to` list with that
   `subject`. Then run:
   node dist/cli.js sent --digest-id <digest_id from work/digest.meta.json> --message-id <the Gmail connector's message id>
7. Evaluate the run:
   node dist/cli.js check > work/check.log 2>&1; CHECK=$?; cat work/check.log >> work/run.log; cat work/check.log
   Remember the exit code as CHECK.
8. Commit state:
   git add data && git commit -m "run $(date -u +%F): $(head -c 120 work/pre.log)" || true
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
