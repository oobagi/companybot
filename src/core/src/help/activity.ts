import type { HelpPage } from "./index";

export default {
	id: "activity",
	title: "Activity",
	summary: "What changed in databases and what agents did.",
	text: `# Activity
[Activity](#/settings/activity) shows two things:
- **Database changes**: records, fields, databases and shared views, including changes agents made for people.
- **Agent activity**: every tool call an agent made in chats you can see. Filter by agent, and click one for its input and result.

Privacy: an entry is as private as its chat. Results show only to the person the agent acted for; owners get no extra access. Calls an agent made because of an Always rule say so.

To undo a record change, use Undo in the record's history (see **help: databases**).
`,
} satisfies HelpPage;
