# Phone

[#118](https://github.com/oobagi/companybot/issues/118), draft [#283](https://github.com/oobagi/companybot/pull/283), stacked on Inbox #275. Agent-owned numbers; Twilio for texts and LiveKit for staff voice. No plans, billing, Retell integration or teleprompter. Night Owl stays unchanged.

## What works

- Staff dial from Inbox, a phone field on a person's record, or the global Keypad, choosing an agent's Contact number. Microphone consent precedes dialing.
- Incoming calls ring signed-in staff with `inbox.use`. Pickup is atomic; decline is personal. No pickup after 30 seconds is missed. Budget-rejected calls still get a missed entry.
- The dock lives above routes, keyed to account/workspace: who, timer, mute, keypad/DTMF and hang-up. Switching workspace/account or losing Inbox access disconnects it. A server watchdog checks access every 10 seconds and requests closure for revoked, released-number or deleted-workspace calls; provider events close calls when staff or callers disconnect.
- One `inboxMessages.call` entry holds direction, staff member, connected/end times and outcome in the ordinary `call` Inbox conversation. Existing record matching links the person. Record history requires both record visibility and Inbox access. Comments and agent reads reuse Inbox; no parallel call/history table.
- `inbox.manage` has `call` and `end_call`, both outside actions. Preparing a call waits for the person's microphone. Pickup, device readiness and dismissing ringing are personal consent. Agent voice, recording, transcript and summary show **Soon**.
- SMS keeps queued, delivered, failed and unknown. Texts bind the approved number, claim one send and verify signed/account-bound receipts for that attempt and pair of numbers. Early receipts survive late REST results. Uncertain sends never automatically repeat. Fake numbers and logged phone sends were removed; tests mock the network.

## Spend and cleanup

General settings has one monthly call budget, default **$0 (off)**, using the picture-budget pattern. Admission holds 31 minutes at the deployment's configured conservative rate against this month's Usage plus active calls. Calls have a 30-minute limit. An uncertain dial spends its full hold and is not retried; known outcomes settle once to `recordUsage`, kind `phone`, labeled estimated. This is an estimated allowance, not a carrier invoice or subscription. Set the rate to cover every enabled destination, LiveKit and rounding; restrict the trunk's dialing geography accordingly.

Unpredictable room names and 60-second staff tokens reach only the claimed room, microphone and DTMF data. Signed `/phone/events` callbacks require the dedicated inbound trunk, Twilio account and active number. Repeated events update the same entry. Existing Inbox cascades erase history; the watchdog retains the exact room name to close even after its row is erased. No recording/storage objects exist yet.

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

No numbers were bought or paid calls/texts made. Tests use synthetic credentials, real token/signature verification and mocked provider requests. Live verification needs dedicated accounts, trunks/webhooks, approved number/rate/budget, required SMS registration, and handset checks for sound, DTMF, pickup races and disconnects. Invoice reconciliation remains future work.

## Next

1. Recording, transcript and summary on this entry, inline playback and permission-checked retention/cleanup.
2. The same Companybot harness answers voice as Public with its existing instructions, tools and role-scoped context. LiveKit stays media only. No teleprompter.
