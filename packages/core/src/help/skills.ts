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
- Choose **Just me** or **Team**. Just me is visible only to you, including in Archive, and agents use it only when acting for you. Just me is the default. Agents create or edit personal skills only in your DM; use Settings from anywhere.
- **Share with team** publishes a personal skill after you confirm, if your role can edit team skills and the team can open every source it used. A wider audience is refused; confirming cannot bypass a source’s privacy.

## Using one
Agents load skills themselves. To point at one, type **/** in the message box and pick it.

Using a personal skill (an agent loading its instructions) counts as just that person: a reply in a channel that used it is private to you. Having one doesn’t: outside your DM with agents, agents don’t see your personal skills unless you point at one with **/**, so other replies stay public. A turn may write only for people who can open all its sources, including its own private or role-limited chat. Only your own turn in your 1:1 DM with agents may publish your own one-person data. Foreign automations, foreign wakeups and shared-chat turns keep the full rule. Personal sources still count for display privacy and other people’s turns. Skills retain those sources across edits and later turns, so a private fact cannot become team instructions by saving it personally first.

## Who can do what
Anyone can make, edit and delete their own personal skills. They are deleted when you leave the workspace or delete your account. Team skills need a role that can make and change team skills (not Member, to start; an owner can turn it on). Deleted skills go to [Archive](#/settings/archive).
`,
} satisfies HelpPage;
