# Phone

Issue [#118](https://github.com/oobagi/companybot/issues/118). Built on the Inbox work in [#275](https://github.com/oobagi/companybot/pull/275). The issue's original workspace-number and Cloud-billing proposal predates the decided product rules: numbers belong to agents, and this work adds no plans or paid gate.

## What ships first

An agent's Contact section provisions one Twilio US local number. Staff start and answer texts in Inbox; customer texts reach the same agent as email, using the existing Public role, instructions, customer-handling settings and shared-data tools. Staff can check drafts or take over. Matching phone fields link the conversation to the person's record. These flows come from #275; this slice completes their send and delivery behavior rather than creating another phone inbox.

- New number searches require both SMS and voice capability. Voice routing is not configured yet. Existing numbers are not replaced or bought again.
- Every queued text freezes its sender number and contact-point id. Removing or replacing the number stops that queued send, even if the replacement has the same digits. A pre-upgrade queued text without a bound sender is refused and must be reviewed and sent again.
- Dispatch checks the workspace, active agent, staff sender's current Inbox permission, and the original number. An automatic Public reply also checks staff takeover and whether the agent still sends replies automatically. Staff-approved drafts use the approving person's permission.
- A mutation claims each send before its paid POST. Another worker cannot repeat it. There is no automatic retry of an uncertain text.
- `POST /sms/status?messageId=…&token=…` verifies Twilio's signature over the configured public URL including its query, the account SID, the attempt token, sender, recipient and provider message SID. It updates only that outbound message, never starts a conversation or wakes an agent. Tokens are not exposed in Inbox reads or agent tools.
- Inbox and `inbox.manage` distinguish queued with the phone company, sent to carrier, delivered, failed/undelivered, uncertain, and local simulation. API acceptance does not mean delivered. Final receipts never move backward; a callback that arrives before the create response is retained.
- A timeout, 5xx or unreadable response may already have sent the message. It stays uncertain; check Twilio's message log before making a new send. A claimed action that crashes gets the same state after one minute. A later signed receipt can resolve it. A definite HTTP 4xx is a failure.
- Local logged providers explicitly show that no text was sent. They are development stand-ins, not real test credentials. Tests replace only the network and use synthetic credentials and signed fixtures; they spend nothing.
- Number purchases recheck the requesting person's management permission and agent before contacting Twilio. A purchase completed after the agent is archived or deleted is released. Repeating the same completed purchase does not release the active number.

## Borrowed from Night Owl

Reference checkout: `/Users/jaden/Developer/ai-agency`, read only. These are behavior references; no Night Owl layout, CSS, Supabase schema or provider credentials are copied.

| Keep | Reference | Companybot destination |
|---|---|---|
| Staff work from the person's conversation; public replies and internal comments stay separate | `docs/wiki/agency-inbox-calendar.md`, `docs/wiki/client-inbox-receptionist.md` | Existing Inbox conversations, comments and linked records |
| One SMS transport, signed inbound and delivery webhooks, accepted vs. delivered | `src/server/send.ts` (`sendThroughTwilio`), `src/server/sales-texts.ts`, `src/server/twilio-webhook.ts` | `channelProviders.ts`, `http.ts`, `inbox.ts`; implemented here |
| Recheck sender readiness and claim delivery before sending; don't retry an uncertain result blindly | `src/server/outreach-sms.ts`, `src/server/lead-nurture.ts`, `src/server/send.ts` | Inbox's bound sender and transactional claim; implemented here |
| Keypad digits and the active call survive route changes; DTMF works during the call | `src/components/dashboard/dialer.ts`, `src/pages/admin/PhoneChrome.tsx` (`KeypadBody`, `AdminKeypad`, `DialerPanel`), `src/pages/admin/calling.tsx`, `src/pages/admin/useTwilioDevice.ts` | Later: workspace-scoped LiveKit session above the renderer's routes |
| Incoming-call acceptance, mute, visible hang-up, elapsed time and audio trouble states | `src/pages/admin/PhoneChrome.tsx` | Later: Companybot controls using existing UI components |
| Live transcript suggestions retain history without forcing a rep back to the latest line | `src/pages/admin/CallPrompter.tsx`, `src/server/live-call-prompt.ts` | Later: optional harness-generated staff assistance |
| Recording controls beside the call; shared transport, seek, and stop when the last control closes | `docs/review/quo-call-sidebar/README.md`, `overlay-audit/README.md`, `src/server/call-recordings.ts`, `src/server/twilio-calls.ts` | Later: call body in Inbox and record; permission-checked Convex storage |
| Signed call events, provider ids and guarded late writes | `src/server/twilio-calls.ts`, `src/server/retell-call-webhook.ts` | Later: one call record, transcript, summary and recording per call |

Painful parts to drop: separate admin/receptionist/outreach call representations and business routing tables; shared global sales-number assumptions; a second recording dock (Night Owl already removed it); route-owned call state; keyword-driven intent workflows; a voice provider's separate agent brain. Companybot uses its generic records, Inbox, role gates and lifecycle registry instead. Carrier-reported failures remain provider events, never keyword matching on customer text. Night Owl itself stays on Retell and is unchanged.

## Providers and planning costs

US pay-as-you-go list prices checked November 8, 2026. Estimates, not billing constants. Number rental, carrier fees, registration, taxes, speech, inference, recording and storage are separate charges. No paid service was exercised in this implementation.

| Item | Planning cost | Choice |
|---|---|---|
| Twilio US local number | $1.15/month | One SMS + voice-capable number per agent |
| Twilio SMS | $0.0083 per inbound or outbound segment, plus carrier fees | Existing Twilio adapter; long/Unicode texts can use multiple segments |
| Twilio Programmable Voice US local PSTN leg | $0.0085/min inbound; $0.014/min outbound | Planning baseline for a LiveKit Twilio connector; not an all-in call price |
| LiveKit Cloud third-party telephony bridge | Ship tier: $0.004/min for Twilio connector or third-party SIP overage; plan/minimums apply | Ears and mouth only; Companybot runs the agent |
| Companybot speech + harness | Additional, model-dependent | Select and measure STT/TTS latency and cost in the voice slice; no separate voice reasoning agent |
| Retell | Advertised $0.07–$0.31/min voice-agent range | Reference only; Night Owl keeps its service |
| Vapi | $0.05/min hosting plus provider costs | Not selected; adds another orchestration layer |

Sources: [Twilio messaging](https://www.twilio.com/en-us/sms/pricing/us), [Twilio voice](https://www.twilio.com/en-us/voice/pricing/us), [LiveKit](https://livekit.com/pricing), [Retell](https://www.retellai.com/pricing), [Vapi](https://vapi.ai/pricing). Receipt contract: [Twilio status callbacks](https://www.twilio.com/docs/messaging/guides/track-outbound-message-status).

## Slice order

1. **Agent number + two-way texts, reliable delivery** (this PR). Reuse #275's Public role, Inbox, staff replies, approvals and record matching. Mock provider behavior end to end and keep Calls visible as Soon.
2. **Staff outbound and incoming calls.** Use the same agent number through LiveKit's Twilio connector (or the self-hosted SIP equivalent), a route-independent call session, Keypad and in-call DTMF, accept/reject, mute and hang-up. Recheck permission before joining or dialing; scoped room tokens cannot reach another workspace. Add equivalent outside-risk agent actions, call limits and usage accounting before paid use.
3. **Call record and playback.** Signed lifecycle events create one call attached to the Inbox conversation and matched person. Store transcript, summary and our recording copy outside generic record fields; register cleanup. Playback is inline, storage access checks current Inbox and record visibility, and late events cannot resurrect erased history. No raw public recording URLs.
4. **The same agent answers voice.** A LiveKit media worker sends transcribed turns to Companybot's existing agent/harness using Public access, and speaks the harness's answer. Keep agent id, instructions and role-scoped tools/context in Companybot. Add interruptions, transfer to staff, reconnects, latency measurement and optional staff teleprompter. No Retell/Vapi agent configuration and no keyword intents.

## Setup and remaining real-account work

Convex env: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and the externally reachable `CONVEX_SITE_URL`. Keep credentials out of the renderer. Provisioning sets `/sms/inbound`; every outbound SMS supplies its own `/sms/status` URL, so no manual delivery webhook is needed. Use a dedicated Companybot test account or subaccount; do not reconfigure Night Owl's existing number or services.

Twilio test credentials and mocked requests can validate request shapes without buying or sending. Test credentials do not deliver real texts or real carrier callbacks. Real verification still needs a dedicated account, an explicitly approved number purchase, any required US A2P registration, a reachable signed-webhook endpoint, and an approved inbound/outbound handset test. Never call a logged local send delivered.

Before production: configure approved sender registration and consent/opt-out handling at the carrier, add actual billed phone usage and a bounded spend policy, reconcile messages with missing receipts against Twilio's log, exercise number release retries and lifecycle on a dedicated account. This slice has no usage/budget billing UI and makes no claim of production readiness. It adds no plan/subscription system.

Voice additionally needs LiveKit URL/API credentials, a dedicated Twilio connector or SIP setup, scoped browser/Electron microphone access, a media worker, recording retention, and speech providers. None are configured here. Calls, recordings and teleprompter remain planned, with Calls shown as Soon in Inbox.

## Verification

`backend/tests/phone.test.ts` runs the provisioning, staff start/reply, draft approval, inbound and delivery webhook paths against Convex with mocked provider requests. It covers early/repeated/out-of-order receipts, forged signatures and wrong accounts, attempt and number binding, cross-workspace reads/writes, timeouts and crashed dispatch, policy revocation/takeover, replacement numbers, local simulations and late number completion. Existing Inbox, Public-access, approval, parity and lifecycle suites remain the shared contract.

Local validation: typecheck, lint and all regular suites passed (core 395, backend 909, desktop 196). Seven temporary mutations of the dispatch claim, receipt signature, attempt token, terminal-state guard, sender permission, frozen number and number-management permission each failed their behavior test; the guards were restored.
