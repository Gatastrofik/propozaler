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
(07:00 EDT), repo `https://github.com/Gatastrofik/propozaler`, model `claude-sonnet-5`, connectors: Gmail
(interim; see below). Its prompt is `ROUTINE.md`, pasted verbatim. `config/recipients.yaml` is on
`transport: connector`: the routine sends the rendered digest through its Gmail connector and records it
with `propozaler sent`, so the environment variables the CLI itself needs reduce to `HEALTHCHECKS_URL` and
optional `SOCRATA_APP_TOKEN`, live on the routine's cloud environment, never in the repo. State is committed
to the `claude/state` branch; code lives on `main`.

Network allowlist on the environment: `data.cityofnewyork.us`, `hc-ping.com`.

Routine URL: (fill in after creation)

Before the first run: real addresses in `config/recipients.yaml`, the healthchecks.io check created, and
the connectivity probe in `docs/superpowers/plans/2026-09-27-milestone-1-crol-digest.md` Task 15 step 4 done.

### When a verified domain exists

Once a domain verified to the engineer's Google account can host the OAuth consent screen's homepage and
privacy URLs, Google will let the app publish and the routine can switch back to `transport: gmail_api` in
`config/recipients.yaml`. That path also needs `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`,
`GMAIL_REFRESH_TOKEN` on the routine's cloud environment, and `oauth2.googleapis.com`,
`gmail.googleapis.com` on the network allowlist.

#### One-time Gmail consent

Run this locally once to mint the refresh token the routine uses to send:

    set -a; source .env; set +a
    npm run propozaler -- gmail-auth

Open the printed URL, sign in as `jobdigest0@gmail.com`, and grant consent. Copy the printed
`GMAIL_REFRESH_TOKEN=<token>` line into the routine's cloud environment and into your local `.env`.
