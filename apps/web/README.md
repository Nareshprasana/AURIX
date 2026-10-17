# AURIX Web — local-first read-only dashboard (Milestone 1)

React 19 + TypeScript (strict) + Vite + Tailwind v4 + shadcn-style
components + React Router + TanStack Query. No Zustand (no shared client
state exists yet: server state lives in the query cache, auth is a session
cookie). No trading operations anywhere in this app.

## Develop (loopback only)

```powershell
# 1. Start the read-only backend (separate terminal):
$env:AURIX_API_TOKEN = "<local-only-token>"
python services-python -m aurix_ai.dashboard  # --runs DIR --port 8742
# (from services-python/: .venv/Scripts/python -m aurix_ai.dashboard)

# 2. Start the frontend (repo root):
cd apps/web
npm run dev   # http://127.0.0.1:5173, /api proxied to :8742
```

`npm install` was used inside `apps/web` because `pnpm install` cannot reach
the registry from this machine (retried, fails); the pnpm workspace layout is
unchanged and no root dependency was modified. Revisit when the toolchain allows.

## Build / preview

```powershell
cd apps/web
npm run build    # typecheck + vite build → dist/
npm run preview  # http://127.0.0.1:4173 with the same /api proxy
```

Production serving (who serves `dist/` same-origin) is a Milestone-2 decision;
until then, `preview` is the local production-like check.

## Auth model

The dashboard's GET reads are intentionally public on loopback (approved
task scope): any local process can already read these run artifacts from
disk, so no new privilege is granted. There are no credentials anywhere in
this app — no login form, no tokens, no storage, no URL-embedded secrets.
`VITE_API_BASE` (`.env.example`) may prefix a loopback origin for explicitly
configured setups; default is same-origin (`""`). The training API
(`api.py`) and the dashboard's login/logout session flow (used by the
bundled static page) are untouched and remain fully authenticated.

## Verified backend surface used

`GET /api/health`, `GET /api/training/state`, `GET /api/training/events`,
`POST /api/login`, `POST /api/logout` — and nothing else. Every other
section renders an explicit unavailable state.
