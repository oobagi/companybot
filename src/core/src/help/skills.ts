import type { HelpPage } from "./index";

export default {
	id: "skills",
	title: "Skills",
	summary: "Saved instructions agents follow when a task calls for them.",
	text: `# Skills
A skill is a saved way of doing something: "how we write proposals". Agents see each skill's one-line description and read the full instructions only when needed.

## Making one
- In [Skills](#/settings/skills): New skill → name, a one-line description of when to use it, and the instructions in Markdown.
- Or tell Companybot "here's how we write proposals". It shows what it will save and asks you to confirm.
- Skills are **shared with the whole workspace**. Personal preferences belong in **help: memory** instead.

## Using one
Agents load skills themselves. To point at one, type **/** in the message box and pick it.

## Who can do what
Owners and members can make skills. The maker or an owner can edit or delete one. Deleted skills go to [Archive](#/settings/archive).
`,
} satisfies HelpPage;
