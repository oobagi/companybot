# Testing

A test earns its place by catching a bug a person or agent would notice. It should only change when what the product does changes, never on a refactor.

## Test these
- **Rules people depend on:** permissions and approvals, who can see what (private chats, personal memory), workspace isolation, data lifecycle and deletion, Trash and restore, undo and history, chat and handoff limits, money (usage, budgets, currencies), and the invariants in [Extending](extending.md).
- **Security edges:** anything that reads untrusted input (links, files, webhooks, message text fed to a model, names in emails) or could leak across people or workspaces.
- **Dense pure logic:** parsing, time zones, cron, money math, search ranking. Small, fast, in `core`.
- **Guards that keep the codebase honest:** the lifecycle registry, parity, help links, Convex-hook and deep-import checks. They fail with a message saying what to do.

## Don't test these
- **Wording.** Don't pin whole prompts, labels or help copy. Check the rule behind the words (the message is quoted as data, a failed call never says it worked). Prompt quality is what `core/eval/` is for.
- **Markup.** No string-matching rendered HTML or class names, no poking component props. If a screen has logic worth testing, move it into a plain function and test that.
- **Lists of everything.** No hand-kept list of every tool id or table: test the rule ("members never get owner-only tools"), not the inventory.
- **Pass-throughs and libraries.** "The tool calls the store with its input" or "React re-renders" proves nothing.
- **Fixes, as such.** A bug fix gets a test only if the behavior it protects matters on its own. Name the behavior, not the bug.
- **Through a pile of mocks.** If a test has to stub `window`, `document`, observers and three hooks to run, it's testing the stubs. Prefer the real code, then a fake (`fakeMcpServer`, an in-memory `localStorage`), and mock only the network, the model and the clock.

## How to write one
- Name it after what happens, in plain words: "lets only the person the agent acts for decide".
- Go through the public way in: `api.*` with `convex-test` in the backend, exported functions in `core`. Check the result (rows, return value), not which functions got called.
- Keep each test readable alone. Shared setup is fine (`tests/helpers.ts`); the values that matter stay in the test.
- No sleeps. Use `vi.useFakeTimers()` and `t.finishAllScheduledFunctions(vi.runAllTimers)`.
- Seed big data in bulk (`t.run` with `recordOps`), not one mutation per row. Anything over a few seconds goes in a `*.scale.test.ts`.
- A flaky test gets fixed or deleted the day it flakes.
- Before you keep a new test, break the code it protects and watch it fail.

## Where tests live
- `packages/core/src/*.test.ts`: next to the module. Pure, no Convex.
- `packages/backend/tests/*.test.ts`: Convex functions through `convex-test` (edge runtime). It doesn't enforce every Convex limit or run crons: call the cron's function yourself.
- `packages/backend/tests/*.scale.test.ts`: thousands of rows under real limits. Slow, so only in `pnpm test:scale` (CI runs both).
- `apps/desktop/src/**/*.test.ts`: the renderer's plain logic (drafts, emoji, filters, money input), plus a few flows where a regression loses data (delete-workspace confirmation, sign-out of an erased account). They run on a stand-in page (happy-dom); UI renders inside `inApp` (`testing.ts`), as `main.tsx` wraps the app.
- `packages/core/eval/`: model evals, paid, not in `pnpm test` ([Chat](chat.md)).

## Run
```sh
pnpm test && pnpm typecheck     # everything, from the repo root
pnpm test:scale                 # slow backend list tests
pnpm --filter @companybot/backend exec vitest run tests/records.test.ts -t "undo"   # one file or test
```
