import type { HelpPage } from "./index";

export default {
	id: "memory",
	title: "Memory",
	summary: "What agents remember: team memories, personal memories, and the on/off switch.",
	text: `# Memory
Agents remember facts so people don't repeat themselves. Each agent has its own memory. Manage it in [Memory](#/settings/memory).

## Two kinds
- **Team memories** are shared with the workspace. Like a wiki, anyone whose role can change team memories (Member, to start) can add, fix or delete one. Each shows who saved it, keeps its last 20 versions you can restore, and goes to [Archive](#/settings/archive) when deleted.
- **Personal memories** belong to one person. Only they can see, edit or delete them, owners included. Agents read them only in a DM with that one person, never in a chat with others.

## How memories get made
Ask an agent to remember something, or add one yourself in Memory. Whenever an agent saves one, its tool line says what it saved. Say "forget that" to delete one.

A turn keeps every restricted source it read, including its own private or role-limited chat. A save can reach only people who can open all those sources. Reading a personal memory counts as just that person, even for Owners. Personal memories keep their saved sources across edits and pass them into later agent turns. Losing a source hides that memory; a team save with a wider audience is refused, naming who can see it.

## The switch
People who can change workspace settings can turn memory off for the workspace in [General](#/settings/general). Agents then read and save nothing; existing memories are kept, and you can still edit them.

## Removing people
Someone's personal memories are deleted when they leave or are removed.
`,
} satisfies HelpPage;
