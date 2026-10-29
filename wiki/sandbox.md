# Sandbox

Where agents run code, crunch spreadsheets, make charts and files, convert documents, and drive a real browser for sites with no API. Research, Oct 28 2026. **Not built yet.** Prices and limits are from vendor pages on that date; re-check before buying.

## Decision
- **One provider for both editions: E2B.** Cloud uses E2B Cloud; Community and Enterprise self-host run the Apache-2.0 [E2B Runtime](https://github.com/e2b-dev/runtime). One adapter, one SDK, same behavior everywhere.
- **Fallback for Cloud: Vercel Sandbox**, if agent-browser doesn't run cleanly in an E2B template. It is the only one with first-party agent-browser support, but it is closed and cannot be self-hosted, so it can't be the only adapter.
- **Sandbox is optional in Community.** Off until the self-hoster points us at an E2B runtime (needs a Linux host with hardware virtualization). Without it the tools don't appear.
- **Not Daytona.** Its core went closed-source in June 2026 (below).
- **Spike first:** build an E2B template with Chrome + agent-browser and run 20 real page tasks before building tools. Only a third-party guide shows agent-browser on E2B; Chrome there needs `--no-sandbox --disable-gpu --disable-dev-shm-usage`.

## Compared
| | License / self-host | Isolation | Max session | Persistence | Network control | TS SDK |
|---|---|---|---|---|---|---|
| **E2B** | Apache-2.0 SDK and [runtime](https://github.com/e2b-dev/runtime). Self-host: Terraform (AWS/GCP/Azure) or single-box [Embed](https://github.com/e2b-dev/runtime/blob/main/embed/README.md) | Firecracker microVM | Hobby 1 h, Pro 24 h | Pause keeps memory and processes; kept forever; ~4 s pause per GiB RAM, ~1 s resume | Allow/deny by IP, CIDR, domain; header injection (beta) | Yes |
| **Vercel Sandbox** | Closed service; SDK Apache-2.0. No self-host | Firecracker microVM | Hobby 45 min, Pro 24 h per session | Persistent by default (filesystem snapshot on stop); snapshots expire 30 days after last use | Deny-all, domain allowlist, **credential brokering**, live updates | Yes |
| **Daytona** | Core closed since Jun 11 2026. Old repo (AGPL-3.0, [v0.190.0](https://github.com/daytonaio/daytona)) frozen, unmaintained | Containers historically; microVM option announced Jul 2026 | Not checked | Pause/resume under 1 s (their claim) | CIDR, domain allowlist, block-all; low tiers locked | Yes |
| **Modal** | Closed; no self-host found | VM or gVisor runtime | Not checked | Not checked | Not checked | Yes (libmodal, Apache-2.0) |
| **Cloudflare Sandbox** | SDK [Apache-2.0](https://github.com/cloudflare/sandbox-sdk). Service closed, no self-host | Containers | Sleeps after 10 min idle by default | Not checked | Not checked | Only via a Worker |
| **Freestyle** | Closed; no self-host found | Full Linux VMs | Not checked | Saved VMs and snapshots | Not checked | Yes |
| **boat.dev** | Closed; license, self-host, browser not stated | Full VM (tech not stated) | 1 h default TTL | Not checked | Not stated | Yes |
| **Cua** | Source-available (FSL-1.1-MIT) Spaces app; MIT driver and SDK | Local VMs (Apple Virtualization) | n/a | n/a | n/a | Python / Rust |

Sources: [E2B pricing](https://e2b.dev/pricing), [E2B persistence](https://docs.e2b.dev/sandbox/persistence), [E2B network](https://docs.e2b.dev/sandbox/internet-access), [Vercel concepts](https://vercel.com/docs/sandbox/concepts), [Vercel limits](https://vercel.com/docs/sandbox/pricing), [Daytona announcement](https://daytona.io/dotfiles/updates/daytona-is-going-closed-source), [Daytona microVMs](https://www.daytona.io/dotfiles/vms-pause-and-fork), [Daytona network](https://www.daytona.io/docs/en/network-limits/), [Modal docs](https://modal.com/docs/guide/sandbox-resources.md), [Cloudflare docs](https://developers.cloudflare.com/sandbox/platform/pricing/), [Freestyle](https://www.freestyle.sh/docs/vms/pricing-and-limits.md), [boat](https://docs.boat.dev), [Cua](https://github.com/trycua/cua).

Notes:
- **Daytona:** the post gives no word on self-hosting the closed code and says to ask the account team. A community fork, Nightona, continues v0.190.0, but it is tiny and unvetted. Hosted Daytona is still fine on price, but it can't be our self-host answer.
- **Cloudflare:** needs a Worker plus a Durable Object per sandbox in front of it, so Convex can't call it directly. Extra moving part, container isolation, no gain.
- **Freestyle, boat.dev:** young hosted-only products. Fine to watch, not to bet the self-host story on.
- **Cua:** a desktop computer-use tool (macOS/Windows/Linux GUIs), not a multi-tenant code sandbox. Only worth it if an agent must drive a native desktop app. Skip for now.

## Price: 1,000 tasks a month, 2 minutes each
That is 120,000 seconds (33 hours). Sized 2 vCPU / 4 GiB, the default on E2B and Vercel.

| | Math | Usage cost | Plan fee |
|---|---|---|---|
| **E2B** | $0.000014 per vCPU-s, $0.0000045 per GiB-s → $0.000046/s | **$5.52** | Hobby $0 with one-time $100 credit (20 concurrent, 1 h cap); Pro $150/mo |
| **Vercel Sandbox** | Active CPU $0.128/h (idle waits free), memory $0.0212/GB-h, $0.60 per 1M creates | **$3.70** at 10% CPU use, $11.40 at 100% | Pro $20/mo, which covers it; Hobby caps at 5 CPU-h, so this load would pause on Hobby |
| **Daytona** | $0.0504 per vCPU-h, $0.0162 per GiB-h | **$5.52** | $200 free credit |
| **Modal** | 1 core (= 2 vCPU) $0.00003942/s + $0.00000667 per GiB-s | **$7.93** | Starter $30/mo free credit |
| **Cloudflare** (1 vCPU / 6 GiB) | $0.00002 per active vCPU-s, $0.0000025 per GiB-s | **≈ $2** after allowances | $5/mo Workers Paid, plus Worker and Durable Object charges |
| **Freestyle** | $0.04032 per vCPU-h, $0.0129 per GiB-h | **$4.41** | Free plan covers it (hard cap) |

Takeaways:
- At this scale cost is noise; pick on isolation, self-host and browser support.
- **Vercel bills active CPU only**, so agents that mostly wait on models or pages are cheapest there. E2B bills the whole wall-clock time, so keep sessions short and pause or kill idle ones.
- E2B Pro's $150 fixed fee is the real cost. Start on Hobby's $100 credit.
- A browser task holds the machine longer than a script. Assume 3-5x if browsing becomes common.

## Browser (agent-browser)
- [agent-browser](https://github.com/vercel-labs/agent-browser) is Apache-2.0: a native Rust CLI with a background daemon, driving Chrome from Chrome for Testing. No Node or Playwright needed; Linux needs `agent-browser install --with-deps`.
- **Vercel Sandbox:** official helper (`@agent-browser/sandbox/vercel`) and an example app. A fresh sandbox spends about 30 s installing Chromium and system libraries; from a snapshot it starts in under a second (per the [vercel-sandbox skill](https://skills.sh/vercel-labs/vercel-plugin/vercel-sandbox)).
- **E2B:** no official template. Build one with Chrome and agent-browser baked in; [E2B Desktop](https://github.com/e2b-dev/desktop) (Apache-2.0) exists if we ever want a visible desktop.
- Give browser sandboxes at least 2 vCPU / 4 GiB. Chrome is the heaviest thing we'll run.

## Calling it from Convex
- Convex Node actions run up to **10 minutes**, 512 MiB RAM, **5 MiB arguments** ([limits](https://docs.convex.dev/production/state/limits)). Node concurrency is 64 on Free/Starter, 256 on Professional.
- So: **no long-lived connection.** Each tool call is one short action. The sandbox outlives the action; the action reconnects by id (`Sandbox.connect(id)` on E2B, `Sandbox.get({ name })` on Vercel) and runs one command with a hard timeout of about 8 minutes.
- Long jobs: start the command detached, return, poll from a scheduled action.
- Sandbox lifetime follows the chat or task, not the action. Pause when idle, kill after a day.
- **Files never pass through tool arguments.** Convex storage is the hub: the action streams storage → sandbox on import and sandbox → storage on export. Cap per file (suggest 50 MB) and per task. E2B can also hand out pre-signed upload URLs.
- Self-hosted E2B: confirm the SDK can point at a custom domain before promising it.

## Tool design
Two tools, group `sandbox`. Grouped action unions, one approval identity per tool ([Permissions](permissions.md)).

| Tool | Does | Risk |
|---|---|---|
| `sandbox.run` | `{ language: python \| node \| shell, code, timeoutSec, network?: off \| allowlist \| open }` → stdout, stderr, exit code, new files. Sandbox and files persist for the chat | `inside` with network off; `outside` when network is `open` |
| `sandbox.files` | `{ action: import \| list \| export, … }`. `import` pulls a record attachment or page file in; `export` saves a file to chat or a page | `import` and `list` are `inside` (reads workspace data); `export` is `inside` (writes as the person) |
| `sandbox.browse` (later) | `{ url, goal }` → agent-browser session on its own sandbox; returns page text and screenshots | `outside`, always asks on first use |

Keep it dead simple: the model gets a shell and files, not a menu of libraries. Preinstalled image: Python with pandas, openpyxl, matplotlib; Node; LibreOffice, pandoc, ffmpeg. Charts and documents are files the agent exports.

## Security rules
1. **No secrets inside.** Nothing from `connectors`, API keys or workspace credentials goes into the sandbox, env or files. If code must call an authenticated service, use header injection at the network layer (Vercel credential brokering, E2B per-host rules). The sandbox never sees the token.
2. **One sandbox per workspace and chat.** Never shared across workspaces or people. Kill on member removal and on workspace delete ([Architecture](architecture.md) data lifecycle).
3. **Egress off by default.** Create with a package-registry allowlist (PyPI, npm) only. `network: open` is `outside` and asks. For data work: install, then lock to deny-all before touching workspace data.
4. **Treat output as untrusted text.** Browser pages and file contents can carry instructions; results come back as data, not instructions, and never raise a tool's permission.
5. **Approvals follow the usual order** (strictest wins). Owner locks can set `sandbox.*` to Ask or Blocked per workspace. Always allow is allowed for `run` with network off; never for `open` network or `browse`.
6. **No inbound.** Don't expose ports or public URLs. Previews, if ever wanted, are separate and approved.
7. **Limits (suggested):** 2 vCPU / 4 GiB default, 8 commands in flight per workspace, 60 s default and 8 min max per command, 50 MB per file, 1 GB disk written, 1 h idle → pause. Per-workspace monthly sandbox minutes tied to the AI allowance on Cloud.
8. **Log every run:** command, exit code, network mode, files in and out, in Activity. No command text in notifications.
9. **Isolation:** microVM only (Firecracker). Don't run untrusted code in plain containers.

## Open questions
- agent-browser on E2B (spike above).
- E2B Embed under load: single node, plain HTTP, not called production-ready by E2B. Enterprise self-host needs the Terraform multi-node path or a Bring Your Own Cloud deal.
- Cloud margin: sandbox minutes should count against the monthly AI allowance, priced at cost plus markup like models.
- Whether Vercel Sandbox becomes the second Cloud adapter anyway, if Vercel's active-CPU billing wins at scale.
