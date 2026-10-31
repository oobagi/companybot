import type { HelpPage } from "./index";

export default {
	id: "agents",
	title: "Agents",
	summary: "What agents are, how to work with them, and how owners set them up.",
	text: `# Agents
Agents are AI teammates. They live in your sidebar as DMs, join channels when mentioned, and use tools to read and change things for the person who asked. See **help: chat** for when they reply.

## Companybot
The main agent, in every workspace. It can search and save memory, work with databases and pages, set up skills and automations, and help owners with members, channels and settings, as the person it is helping.

## Setting agents up
[Agents](#/settings/agents) (Workspace settings → Customize). Everyone can look; **only owners** create, edit or delete.
- **Picture, name and description**: the description shows in the agent switcher.
- **Model**: the AI model it runs on. The default is the recommended one.
- **Reasoning**: how hard it thinks before answering: Off, Low, Medium (the default) or High. More is slower and costs more, but handles hard or many-step work better.
- **Tools**: what it may do, as groups (memory, chat, records, pages and more). A tool also needs the person's role to allow it. Help is its own group; grant it to let an agent answer "how do I…" questions.
- **Instructions**: who the agent is and how it works. Changes apply from its next reply.
- **History**: every save is kept. Restore an old version from there.
- Deleting an agent moves it to [Archive](#/settings/archive). The last agent can't be deleted.

## Tips
- Ask Companybot to do things in plain words: "add a deal for Acme", "remind the team every Monday".
- Agents can't change their own tools or instructions; an owner does that here.
`,
} satisfies HelpPage;
