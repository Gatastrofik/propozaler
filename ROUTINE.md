# propozaler daily routine

You are running the propozaler daily pipeline. Follow these steps exactly, in order. Do not edit any file
under src/, config/, prompts/, or test/. Do not fetch sources by hand. Do not send email except where step 6b
or step 10 below directs you to, through the Gmail connector (interim, until a verified domain lets the
Gmail OAuth app publish); every other step's mail I/O is the CLI's job, not yours.
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
6b. If work/digest.meta.json has "pending_send": true: send an email through the Gmail connector to
    every address in its "to", subject exactly its "subject", HTML body from work/digest.html,
    plain-text body from work/digest.txt; then run
    node dist/cli.js sent --digest-id <digest_id from the meta file> --message-id <id returned by the connector>
    and append its output to work/run.log. If "pending_send" is false or absent, do nothing.
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
    and stop. If work/failure.json exists, send it through the Gmail connector: "to", "subject",
    "text" as the plain body.

Report in one line what happened: fetched/new/candidates per source, whether the digest was sent, and the
check result.
