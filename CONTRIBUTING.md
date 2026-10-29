# Contributing to Companybot

Thanks for helping. Companybot is in alpha and moves fast, so a short issue before a big PR saves everyone time.

## Before you start

- Read [`wiki/index.md`](wiki/index.md). It's a table of contents: open only the pages for your change. [Extending](wiki/extending.md) covers adding tools, connectors, skills, permissions and roles, and the invariants to keep.
- Bugs and small fixes: open a PR directly.
- New features or anything that changes how data is stored: open an issue first.

## Setup

Needs Node 22+ and pnpm (`corepack enable`).

```sh
pnpm install
pnpm dev            # this checkout's own local Convex backend + the desktop app
```

- Sign in with any email. Local backends skip the email code.
- `pnpm dev --reset` wipes this checkout's local data.
- `pnpm --filter @companybot/desktop preview:web` serves the UI in a browser at `localhost:5173`.
- Connector sign-in (OAuth) doesn't work on local backends. They have no public URL for the callback.

### Running it outside the team

`pnpm dev` copies `AI_GATEWAY_API_KEY` from the team's cloud dev deployment, which you won't have access to. Until that's smoothed out, open an issue and we'll help you get a backend running.

## Checks

CI runs these on every PR. Run them before you push:

```sh
pnpm typecheck
pnpm test
pnpm test:scale     # slow list tests over thousands of records
```

## Pull requests

- Keep each PR to one change. Explain what changed for the person using the app and why.
- **Backend changes must keep the previous app version working.** Installed apps update hours after the backend deploys. Add, don't remove; mark compatibility code with `// COMPAT(<version>)`; change stored data only through migrations. See [Releases](wiki/releases.md).
- Update the wiki page your change touches, and the in-app help if it changes what people see.
- Screenshots or a short clip help a lot for UI changes.

## Contributor License Agreement

Outside contributors sign the [CLA](CLA.md) once. The CLA bot comments on your first PR. Reply with the sentence it asks for. You keep ownership of your work. The CLA lets us ship it in every edition, including the paid ones (see [Product → Open source](wiki/product.md#open-source)).

## License

By contributing, you agree your work is licensed under [AGPL-3.0](LICENSE), as described in the CLA.
