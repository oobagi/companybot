import type { HelpPage } from "./index";

export default {
	id: "automations",
	title: "Automations",
	summary: "Jobs agents do on their own: on a schedule, when something happens, or from a webhook; and follow-ups, when an agent checks back later.",
	text: `# Automations
An automation asks an agent to do something without you typing it. Make one in [Automations](#/settings/automations) → New automation, or ask Companybot ("every Monday morning summarize last week").

## Parts
- **When**: on a schedule, when something happens here (someone posts in a channel, someone joins the workspace), or when another app sends a webhook. A webhook gives you a secret URL to paste into the other app; keep it private.
- **What to ask the agent**: the prompt, sent each run as if the person it runs for had asked.
- **Agent**: which agent does it.
- **Runs for**: just you; anyone who turns it on; or one post in a channel. Nobody gets messages they didn't ask for: others choose to turn it on.

## Schedules
- Pick how it repeats: every few hours (between two times), daily, weekly, or monthly (a day like the 15th, or one like the first Monday). Daily and weekly take several times, like 9:00 AM and 1:00 PM; times in one schedule share their minutes past the hour (9:00 and 1:00, or 9:30 and 1:30).
- Under it is the same schedule as cron, which you can type in for anything else (like "0 9 * 1 *" for every day in January). The description and the next 3 runs show what it will do.
- Schedules run in the time zone of whoever made the automation, and at most every 15 minutes. If a run is missed, it runs once when it can, never several in a row.

## Good to know
- Runs act with the rights of the person they run for, and post in their DM with the agent (or once in the channel).
- **Run now** tests it with sample data. Each automation shows when it last ran and what happened.
- Anything that leaves Companybot still asks first. In an automation someone else wrote, acting as you asks the first time: see **help: permissions**.
- The maker or an owner can edit, pause or delete one. Deleted ones go to [Trash](#/settings/trash).

## Follow-ups
Ask an agent to check back later and it sets a follow-up: "remind me to chase Acme's invoice in 3 days if it's unpaid", "reach out to them in April", "check this deal every Monday for a month".
- When it's time, the agent wakes in the same chat, acting for the same person, and checks whether it still applies (is the invoice still unpaid?). It gets the record's current values if the follow-up is about one.
- It's quiet: it posts only when there's something worth telling you. Each time it wakes shows as one line in [Activity](#/settings/activity).
- Pending follow-ups are listed under Follow-ups in [Automations](#/settings/automations), and on the record they're about. You see the ones in chats you can see; owners see all of them.
- Cancel one there, or ask the agent. Its person, whoever set it up, or an owner can cancel it. Times use your time zone; one can be at most 2 years ahead.
- If you leave the workspace, your follow-ups are deleted: they never run as anyone else. One whose record, agent or chat is in Trash waits, and runs once it's restored.
- One set while an agent was following words you didn't write (a webhook, another person's automation) asks you before acting as you when it wakes, like that automation would.
`,
} satisfies HelpPage;
