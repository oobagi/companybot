---
name: dev
description: Start Companybot locally — this checkout's own local Convex backend and data, plus the desktop app — in one command. Safe to run in several worktrees at once. Use for /dev, or when asked to start, run, or open the dev server or app, reset local data, or check a change in the real app.
---

# Dev

`pnpm dev` runs this checkout against its **own local Convex backend**: its own database, functions, and ports. Never push a branch to the shared cloud dev deployment (`exciting-guanaco-266`); another branch may be using it, and its data may not fit your schema. Background: [wiki/architecture.md](../../../wiki/architecture.md#run).

## Start

From the repo root, in the background (it keeps running):

```
pnpm dev
```

- It unsets `ELECTRON_RUN_AS_NODE` (set in T3 Code terminals) itself.
- First run (about 30s): installs packages, downloads Electron if pnpm skipped it, creates the local deployment (state in `.convex/`, gitignored), and sets its secrets. `AI_GATEWAY_API_KEY` is copied from cloud dev; sign-in and encryption keys are generated fresh. Later runs start in seconds.
- Ready when the log shows `Convex functions ready` and then `starting electron app...`. `convex dev` keeps watching: backend edits deploy on save, renderer edits hot-reload.
- Another checkout already running? The CLI moves this one to the next free ports (3212/3213, …) and `.env.local` follows.

Tell the user in one line: the app is open, the backend URL, and how to sign in.

## Sign in

Any email, no code: local backends send no email and the app signs straight in. The first person becomes the workspace owner. For a second person (a member), invite their email in Settings → Members, sign out, and sign in as them.

## Look at it without Electron

The renderer is also served at `http://localhost:5173` (vite prints the port; it moves if taken). Open it in a browser (Playwright) to click through and screenshot. Screens have paths, so you can open one directly: `#/customize/automations/new`, `#/settings/members`.

## Other commands

| Need | Run |
|---|---|
| Set up only, don't start | `pnpm dev --setup` |
| Wipe this checkout's data and start fresh | `pnpm dev --reset` (asks nothing; only touches this checkout's `.convex/`) |
| Run a function | `npx convex run automations:tick` (while `pnpm dev` runs) |
| See data | the dashboard link `convex dev` prints, under *Local* |
| Stop | Ctrl-C, or kill the background task |

## When it breaks

- **`Electron uninstall`**: Electron's download was skipped. `pnpm dev` fixes this on the next start; if not, run `node install.js` in Electron's package folder.
- **App can't connect**: check that `.env.local` has `CONVEX_DEPLOYMENT=local:…` and `CONVEX_URL=http://127.0.0.1:<port>`. If not, `pnpm dev --setup`.
- **Schema push fails on old local data**: `pnpm dev --reset`.
- **Connector sign-in (OAuth) doesn't finish**: expected. Local backends have no public URL for the callback. Test connector sign-in on cloud dev, on purpose.
