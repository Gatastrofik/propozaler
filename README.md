# propozaler

Internal government bid finder. See `SPEC.md` for the design and `CLAUDE.md` for conventions.

## Develop

    npm ci
    npm test          # offline unit tests
    npm run build     # compile to dist/
    npm run propozaler -- check-env

## Run locally

Copy `.env.example` to `.env`, fill it in, then `set -a; source .env; set +a` and:

    npm run propozaler -- pre
    npm run propozaler -- post --no-send   # writes work/digest.html without sending
    npm run propozaler -- check

## Routine

Production runs happen in a Claude Code cloud routine named `propozaler-daily`, cron `0 11 * * *` UTC
(07:00 EDT), repo `https://github.com/Gatastrofik/propozaler`, model `claude-sonnet-5`, no connectors.
Its prompt is `ROUTINE.md`, pasted verbatim. Environment variables live on the routine's cloud
environment, never in the repo: `SMTP_USER`, `SMTP_APP_PASSWORD`, `HEALTHCHECKS_URL`, optional
`SOCRATA_APP_TOKEN`. State is committed to the `claude/state` branch; code lives on `main`.

Routine URL: (fill in after creation)

Before the first run: real addresses in `config/recipients.yaml`, the healthchecks.io check created, and
the connectivity probe in `docs/superpowers/plans/2026-09-27-milestone-1-crol-digest.md` Task 15 step 4 done.
