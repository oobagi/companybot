import type { HelpPage } from "./index";

export default {
	id: "memory",
	title: "Memory",
	summary: "What agents remember: team memories, personal memories, and the on/off switch.",
	text: `# Memory
Agents remember facts so people don't repeat themselves. Each agent has its own memory. Manage it in [Memory](#/settings/memory).

## Two kinds
- **Team memories** are shared with the workspace. Like a wiki, anyone (owner or member) can add, fix or delete one. Each shows who saved it, keeps its last 20 versions you can restore, and goes to [Trash](#/settings/trash) when deleted.
- **Personal memories** belong to one person. Only they can see, edit or delete them, owners included. Agents read them only in a DM with that one person, never in a chat with others.

## How memories get made
Ask an agent to remember something, or add one yourself in Memory. Whenever an agent saves one, its tool line says what it saved. Say "forget that" to delete one.

## The switch
Owners can turn memory off for the workspace in [General](#/settings/general). Agents then read and save nothing; existing memories are kept, and you can still edit them.

## Removing people
Someone's personal memories are deleted when they leave or are removed.
`,
} satisfies HelpPage;
