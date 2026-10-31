import type { HelpPage } from "./index";

export default {
	id: "automations",
	title: "Automations",
	summary: "Jobs agents do on their own: on a schedule, when something happens, or from a webhook.",
	text: `# Automations
An automation asks an agent to do something without you typing it. Make one in [Automations](#/settings/automations) → New automation, or ask Companybot ("every Monday morning summarize last week").

## Parts
- **When**: on a schedule (days and time), when something happens here (someone posts in a channel, someone joins the workspace), or when another app sends a webhook. A webhook gives you a secret URL to paste into the other app; keep it private.
- **What to ask the agent**: the prompt, sent each run as if the person it runs for had asked.
- **Agent**: which agent does it.
- **Runs for**: just you; anyone who turns it on; or one post in a channel. Nobody gets messages they didn't ask for: others choose to turn it on.

## Good to know
- Runs act with the rights of the person they run for, and post in their DM with the agent (or once in the channel).
- **Run now** tests it with sample data. Each automation shows when it last ran and what happened.
- Anything that leaves Companybot still asks first. In an automation someone else wrote, acting as you asks the first time: see **help: permissions**.
- The maker or an owner can edit, pause or delete one. Deleted ones go to [Archive](#/settings/archive).
`,
} satisfies HelpPage;
