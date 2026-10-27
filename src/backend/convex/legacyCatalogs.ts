import { defineAutomation, defineSkill, type Automation, type Skill } from "@companybot/core";

// COMPAT(0.1.0-alpha.8): definitions for existing installs until storedSkills and storedAutomations finish; then delete this file and its read fallbacks. Never offer these for installation.
export const legacySkills: Skill[] = [
	defineSkill({
		id: "meeting-notes",
		name: "Meeting notes",
		description: "Turn rough meeting notes into a summary with decisions and action items.",
		version: "0.1.0",
		instructions: `Rewrite the notes as:
1. **Summary** — two or three sentences.
2. **Decisions** — bullet list. Write "None" if there were none.
3. **Action items** — "- [ ] Owner: task (due date if mentioned)".
Keep the people's own wording for decisions. Don't invent owners or dates.`,
	}),
	defineSkill({
		id: "email-reply",
		name: "Email reply",
		description: "Draft a short, friendly reply to an email.",
		version: "0.1.0",
		instructions: `Draft a reply that:
- Opens by answering the main question directly.
- Stays under 120 words unless the email needs more.
- Ends with one clear next step.
- Uses a warm, plain tone. No "I hope this email finds you well."
Offer one alternative subject line only if the original is unclear.`,
	}),
];

export const legacyAutomations: Automation[] = [
	defineAutomation({
		id: "morning-brief",
		name: "Morning brief",
		description: "Every weekday at 8am, each person gets their day at a glance.",
		details: `Each weekday morning the agent messages every member with:
- **Today** — meetings and deadlines it knows about.
- **Open tasks** — follow-ups and action items still waiting on them.
- **Overnight** — anything that changed since yesterday.

It uses the agent's memory and whatever connectors the agent is granted, so it gets better as you connect more.`,
		version: "0.1.0",
		publisher: "Companybot",
		trigger: { type: "schedule", time: "08:00", weekdays: [1, 2, 3, 4, 5] },
		connectors: [],
		prompt: `Morning brief. Give me my day at a glance, in this order:
1. **Today** — meetings, deadlines, and anything time-sensitive.
2. **Open tasks** — follow-ups and action items still waiting on me.
3. **Overnight** — what changed since yesterday.
Use your memory and any tools you have. Skip a section if there's nothing for it. Keep it short.`,
	}),
	defineAutomation({
		id: "after-call-summary",
		name: "After-call summary",
		description: "When a call ends, get a summary with next steps and action items.",
		details: `After each call, the agent writes up:
- **Summary** — two or three sentences.
- **Next steps** — what was agreed.
- **Action items** — who does what, by when.

**Setup:** copy this automation's webhook URL into your phone system, or anything that can send a webhook when a call ends. Pick a channel like #calls, or leave it on DMs to message the person each call is for.`,
		version: "0.2.0",
		publisher: "Companybot",
		trigger: {
			type: "webhook",
			webhookEvent: "call.ended",
			label: "When a call ends",
			sample: {
				event: "call.ended",
				id: "sample",
				data: {
					direction: "inbound",
					caller: { name: "Dana Reyes", phone: "+15305550142" },
					takenBy: "AI receptionist",
					durationSeconds: 212,
					summary:
						"Dana's water heater is leaking. She wants a quote to replace it this week and asked whether tankless is worth it. Agreed a technician visits Thursday 10am; office to text a confirmation.",
				},
			},
		},
		connectors: [],
		prompt: `A call just ended. Using the call details below, write:
1. **Summary** — two or three sentences: who called and why.
2. **Next steps** — what was agreed.
3. **Action items** — "- [ ] Owner: task (due date)". Leave out the owner or date when the details don't name one; never guess.
If the details include a link to the call, add it at the end. Don't comment on what the details leave out.`,
	}),
];

export const legacyAutomation = (id: string) => legacyAutomations.find((a) => a.id === id);
