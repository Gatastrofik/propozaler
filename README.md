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

Production runs happen in a Claude Code routine; see `ROUTINE.md`.
