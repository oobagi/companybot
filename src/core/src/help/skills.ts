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
- Choose **Just me** or **Team**. Just me is visible only to you, including in Archive, and agents use it only when acting for you. Team is the default if your role can edit team skills; otherwise Just me is the default.
- **Share with team** publishes a personal skill after you confirm, if your role can edit team skills.

## Using one
Agents load skills themselves. To point at one, type **/** in the message box and pick it.

## Who can do what
Anyone can make, edit and delete their own personal skills. They are deleted when you leave the workspace or delete your account. Team skills need the skills edit switch (Member, to start). Deleted skills go to [Archive](#/settings/archive).
`,
} satisfies HelpPage;
