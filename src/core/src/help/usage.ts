import type { HelpPage } from "./index";

export default {
	id: "usage",
	title: "Usage",
	summary: "What AI has cost this month, and who and what it went to.",
	text: `# Usage
[Usage](#/settings/usage) shows what AI has cost in a month, in US dollars. Pick any of the last six months.

- **Owners** see the whole workspace: the total, then by agent, by person, by kind (replies, chat summaries, web search, images) and by model.
- **Everyone else** sees only their own share, "Your usage".
- A reply counts for the person it ran for: who wrote the message, or who an automation ran for (a channel automation counts for its maker). A chat summary counts for the person whose reply triggered it.
- Pictures agents make count under images, and against the workspace's monthly image budget (**help: general**).
- People who left stay in the totals as former members, so the workspace's bill never shrinks.

Ask Companybot "what did we spend this month?" and it reads the same numbers with your rights.
`,
} satisfies HelpPage;
