# Phone

[#118](https://github.com/oobagi/companybot/issues/118), draft [#283](https://github.com/oobagi/companybot/pull/283), stacked on Inbox #275. Agent-owned numbers; Twilio for texts and LiveKit for staff voice. No plans, billing, Retell integration or teleprompter. Night Owl stays unchanged.

## What works

- Staff dial from Inbox, a phone field on a person's record, or the global Keypad, choosing an agent's Contact number. Microphone consent precedes dialing.
- Incoming calls ring signed-in staff with `inbox.use`. Pickup is atomic; decline is personal. No pickup after 30 seconds is missed. Budget-rejected calls still get a missed entry.
- The dock lives above routes, keyed to account/workspace: who, timer, mute, keypad/DTMF and hang-up. Switching workspace/account or losing Inbox access disconnects it. A server watchdog checks access every 10 seconds and requests closure for revoked, released-number or deleted-workspace calls; provider events close calls when staff or callers disconnect.
- One `inboxMessages.call` entry holds direction, staff member, connected/end times and outcome in the ordinary `call` Inbox conversation. Existing record matching links the person. Record history requires both record visibility and Inbox access. Comments and agent reads reuse Inbox; no parallel call/history table.
- `inbox.manage` has `call` and `end_call`, both outside actions. Preparing a call waits for the person's microphone. Pickup, device readiness and dismissing ringing are personal consent. Agent voice stays **Soon**. Recorded calls have private playback, a transcript and a summary on the same Inbox entry.
- SMS keeps queued, delivered, failed and unknown. Texts bind the approved number, claim one send and verify signed/account-bound receipts for that attempt and pair of numbers. Early receipts survive late REST results. Uncertain sends never automatically repeat. Fake numbers and logged phone sends were removed; tests mock the network.

## Spend and cleanup

General settings has one monthly call budget, default **$0 (off)**, using the picture-budget pattern. Admission holds 31 minutes at the deployment's configured conservative rate against this month's Usage plus active calls. Calls have a 30-minute limit. An uncertain dial spends its full hold and is not retried; known outcomes settle once to `recordUsage`, kind `phone`, labeled estimated. This is an estimated allowance, not a carrier invoice or subscription. Set the rate to cover every enabled destination, LiveKit and rounding; restrict the trunk's dialing geography accordingly.

Unpredictable room names and 60-second staff tokens reach only the claimed room, microphone and DTMF data. Signed `/phone/events` callbacks require the dedicated inbound trunk, Twilio account and active number. Repeated events update the same entry. Existing Inbox cascades erase history; the watchdog retains the exact room name to close even after its row is erased. Recording files live in private Convex storage. Full transcripts live separately from Inbox messages so lists stay bounded; a 320-character transcript excerpt, summaries and processing state stay on the call. Files and transcripts are removed with their conversation, agent or workspace.

## Recording and processing

With recording storage configured, staff calls use server-side LiveKit audio-only Egress to capture all published room audio, including caller and staff tracks. Inbound capture starts before the staff microphone joins; outbound capture starts before dialing. The recorder waits up to 15 seconds for ACTIVE. Unavailable or failed recording never prevents a staff call; the panel shows its actual capture status. A lost start response is reconciled, never automatically started again.

A signed `egress_ended` event matches the room, Egress ID and exact server-chosen object key. The backend ignores callback URLs, reads the known private object with a streaming 24 MB bound, imports it into Convex storage, and deletes the staging object. Missed callbacks have a bounded reconciliation watchdog. Cleanup stops live exports and handles delayed completion after a call was deleted. Configure the staging bucket with a one-day expiration policy as a final cleanup backstop. Final recordings are retained with their conversation; there is no separate age-based retention setting yet.

Playback is requested on demand through `callRecordings.playback`. It returns a five-minute capability URL to `/phone/recording`, never a Convex storage URL or S3 URL. Every audio Range request checks the current user's membership, workspace and `inbox.use` access. Revocation blocks subsequent requests; bytes already delivered to a browser cannot be recalled. A workspace-level playback context owns one real HTML audio element above the routes. The card and call-detail controls share its position; navigating leaves it playing and shows a compact player in the app footer, with pause, seeking, stop and a link back to the call. Loading starts with one Play click. Replacing the selected recording cancels stale link and play results. Closing playback, changing account/workspace or losing live recording access releases the source and buffered audio. A ringing or active staff call pauses recordings and requires an explicit Play afterward. Pointer and keyboard seeking and one expired-link renewal remain available. The call bubble shows a two-line italic transcript excerpt directly under the player; clicking the call bubble opens its detail screen inside the main Inbox pane at `/inbox/<conversation>/call/<message>`, with the usual Inbox sidebar and contact details. Back returns to the mounted thread, preserving its scroll position and draft. The detail uses the normal page scroll, shows the summary above the speaker conversation, and keeps playback in the footer. The full transcript and timed speaker turns load separately through `callRecordings.transcript`. Play, seeking and recovery buttons remain independent of opening the call. The AI summary has its own surface below the bubble. Play requests the audio and starts playback in one click, with no separate load step.

After import, `callRecordingJobs.process` transcribes through AI Gateway using `elevenlabs/scribe-v2` with speaker diarization and word timestamps, then summarizes through the existing background summary model. Provider speaker identities and seconds are preserved as bounded turns outside Inbox list data. The viewer labels distinct voices Speaker 1, Speaker 2 and so on; it does not infer caller/staff identities. Older text-only transcripts remain readable and explicitly lack speaker identification. Agent reads and summaries receive the same speaker-attributed text. Missing or invalid speaker metadata never becomes invented dialogue. Audio is at most 24 MB, transcripts 120,000 characters with at most 4,000 turns, combined transcript storage 900 KB and summaries 4,000 characters. The model sees transcript content as untrusted data and receives no tools. Empty speech produces an explicit no-speech result. Model requests have timeouts and zero automatic retries. A manual retry preserves a successful transcript and reruns only a failed summary. At most three manual retries are allowed.

Scribe v2 costs $0.22/hour at the verified Gateway rate, about $0.11 for a 30-minute call before summary generation. Each processing attempt reserves a conservative $0.25 against the existing monthly call budget, including other calls and processing holds. Completed stages record actual Gateway cost or a conservative estimate when billing metadata is absent. An ambiguous model timeout settles the remaining reservation as estimated phone Usage before allowing a manual retry. Set the configured all-in phone rate to cover telephony and recording export as well. Zero budget blocks paid processing.

Agents can use `inbox.manage` `read_call` for paged transcripts and summaries and `retry_call_processing` for failed processing. These use the same workspace and Inbox access checks as the UI.

## Backend contract for the phone UI

`calls.readiness({})` uses the same admission calculation as `calls.start`. It returns `null` without `inbox.use`, otherwise:

```ts
{
  configured: boolean;
  canCall: boolean;
  reasonCode: "not_configured" | "budget_off" | "budget_exceeded"
    | "call_limit" | "already_on_call" | "no_number" | null;
  reason: string | null;
  budgetUsd: number;
  spentThisMonthUsd: number;
  reservedUsd: number;
  requiredUsd: number;
  month: string;       // UTC YYYY-MM
  monthLabel: string;  // English month name, such as November
}
```

Disable Call while loading, when readiness is null, or when `canCall` is false. Show `reason` beside the control. `configured` means the deployment has voice credentials, both trunks and a positive rate; it does not mean a workspace has a budget or an active number, and it is not a provider health check. `reservedUsd` holds active calls separately from settled `spentThisMonthUsd`; `requiredUsd` is the allowance needed for one more call. Settings can show `$X used in <monthLabel>` using `spentThisMonthUsd`. Budget admission still runs atomically on the server, because another caller can reserve money after the query returns. Select an active number from `calls.numbers` and validate the destination before starting. Refresh the subscription at the UTC month boundary; time passing alone does not invalidate a Convex query.

`calls.start` and media setup throw short string `ConvexError` data. The renderer must display the string in `error.data`, with a short fallback for unexpected failures. Rendering `String(error)`, `error.message` or the whole exception can include Convex's diagnostic wrapper and stack trace. That renderer wiring is outside this backend change.

Every call object in `calls.current().calls`, `calls.forRecord().calls` and `inbox.get().messages[].call` includes:

```ts
{
  direction: "in" | "out";
  status: "completed" | "missed" | "no-answer" | "declined" | "failed"
    | "in-progress" | "ringing";
  startedAt: number;
  answeredAt: number | null;
  endedAt: number | null;
  duration: number | null;
  active: boolean;
  ending: boolean;
  number: string;
  formattedNumber: string;
  recordName: string | null;
  displayName: string;
}
```

Timestamps are Unix milliseconds. `duration` is whole connected seconds, null if the call never connected. During a live call it is a query snapshot: tick a local timer from `answeredAt`, and freeze it at `endedAt`. `ending` marks a requested hangup while provider cleanup finishes. `status` is for cards; the older `state` and `connectedAt` fields remain available. An uncertain provider result has `status: "failed"` and `state: "unknown"`, conservatively spends its full hold, and is never retried automatically. Message-level `status` still describes Inbox delivery; use the nested `call.status` for a call card.

`number` is the contact's E.164 number. `formattedNumber` uses the shared phone formatter, such as `(415) 555-0142` for US/Canada; other countries retain E.164. `recordName` is the currently visible linked record's name or null. `displayName` is that name, otherwise the formatted number. The same helper supplies call conversation fields on `inbox.list` and `inbox.get`; those additional fields exist for call conversations only. Their existing `contactName` now also returns `displayName` for calls, and `calls.current().calls[].name` is the same alias. Record renames update every surface; hidden or archived records fall back to the number instead of leaking a saved name. `contact` remains the raw address for existing clients. Do not construct a caller label from `Call <number>` or stale `contactName` data stored in the row.

Signed LiveKit disconnect reasons distinguish declined, unanswered and failed outbound calls. Known SIP rejection responses settle the estimated attempt once; only uncertain responses spend the full hold. A caller leaving before the join webhook still creates one missed entry. Duplicate or late joins cannot revive a finished entry and request room cleanup. A participant abort closes only the caller or the claimed staff connection, not an unrelated participant. The watchdog closes unanswered calls after 30 seconds and connected calls at the duration limit if end webhooks never arrive. Decline remains personal, so teammates can still answer; no staff pickup ends as missed.

Regenerate backend types from the repo root with `pnpm exec convex codegen` against this checkout's local deployment. Do not hand-sort `_generated/api.d.ts`. A second generation should leave it unchanged. No shared deployment or real provider is needed for tests; `pnpm -C src/backend test` mocks provider requests.

## Night Owl references

Behavior only, no copied visuals or Supabase routing tables:
- `components/dashboard/dialer.ts`, `pages/admin/PhoneChrome.tsx`: persistent digits and call, accept/decline, mute, DTMF, timer and hang-up.
- `server/send.ts`, `sales-texts.ts`, `twilio-webhook.ts`, `lead-nurture.ts`: claimed sends, signed receipts and uncertain outcomes.
- `docs/review/quo-call-sidebar/`, `server/call-recordings.ts`: later inline playback, transcript and summary. Drop the old recording dock and separate admin/receptionist/outreach histories.

## Setup and real-account work

Convex env: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `LIVEKIT_SIP_INBOUND_TRUNK`, `LIVEKIT_SIP_OUTBOUND_TRUNK`, `PHONE_RATE_USD_PER_MINUTE` and reachable `CONVEX_SITE_URL`. New numbers can attach with `TWILIO_SIP_TRUNK_SID`; existing numbers need explicit attachment. Credentials never reach the renderer.

Use dedicated Twilio SIP and authenticated LiveKit trunks. Configure an individual inbound dispatch rule with prefix `cb-call-`, no agent dispatch and a maximum duration of 1800 seconds. Route Twilio origination to LiveKit; allow only Companybot numbers and approved destinations. LiveKit webhooks go to `<CONVEX_SITE_URL>/phone/events`. SMS stays `/sms/inbound` with per-message signed receipts. Set a conservative all-in rate and owner-approved budget. Do not reconfigure Night Owl services.

The renderer permits `*.livekit.cloud` signaling; self-hosted LiveKit needs its exact HTTPS/WSS origin in the renderer CSP. Microphone access needs HTTPS or Electron; the Mac app has the audio-input entitlement. Browsers may silence ringing until the person interacts; the alert stays visible.

[LiveKit SIP](https://docs.livekit.io/telephony/), [DTMF](https://docs.livekit.io/telephony/features/dtmf/), [Twilio trunking](https://www.twilio.com/en-us/sip-trunking/pricing/us). SIP is necessary because Twilio Media Streams cannot send outbound DTMF. Nov 8 planning baseline: local numbers $1.15/month and SMS $0.0083/segment plus carrier fees; voice varies by SIP route and LiveKit usage. Configure the deployment's actual conservative rate before enabling calls.

Recording additionally needs `RECORDING_S3_BUCKET`, `RECORDING_S3_REGION`, `RECORDING_S3_ACCESS_KEY_ID`, `RECORDING_S3_SECRET_ACCESS_KEY`, and optionally `RECORDING_S3_ENDPOINT` (HTTPS, for S3-compatible storage). Keep this bucket private; grant only object read/write/delete for the `calls/` prefix. LiveKit Egress must be enabled and allowed to upload to that bucket. Self-hosted LiveKit needs a running Egress service. `AI_GATEWAY_API_KEY` enables transcription and summaries; `CONNECTIONS_KEY` signs private playback tickets.

No phone numbers or subscriptions were purchased, and no paid calls/texts were made. With explicit approval, live AI Gateway transcription and summary generation were verified on short local synthetic speech; the earlier two model passes cost $0.0004957 total. A later 24-second synthetic two-voice sample was processed with live Scribe v2 and summary generation, producing six correctly separated timestamped turns for about $0.0016. This verifies model processing and persistence, not live telephone capture. Live Egress capture remains unverified until dedicated private staging storage is configured. Automated tests use synthetic credentials, real token/signature/SDK verification and mocked provider requests. Live verification needs dedicated accounts, trunks/webhooks, approved number/rate/budget, required SMS registration, and handset checks for sound, DTMF, pickup races and disconnects. Invoice reconciliation remains future work.

## Next

1. Dedicated-account handset acceptance for recording both sides, muted microphone behavior, playback, transcript quality, summaries and cleanup.
2. The same Companybot harness answers voice as Public with its existing instructions, tools and role-scoped context. LiveKit stays media only. No teleprompter.
