import type { HelpPage } from "./index";

export default {
	id: "connectors",
	title: "Connectors",
	summary: "Linking outside services, such as Gmail or Calendar, for agents to use.",
	text: `# Connectors
A connector links an outside service so agents can use it for you. They live in [Connectors](#/settings/connectors). **None are available yet**; the list is empty until services are added.

## How they work when available
- People whose role can install connectors add one and pick which roles can use it (owners always can).
- A connector uses either **one shared account** for the workspace (someone who can install connectors sets it) or **each person's own account** (everyone connects theirs; an agent uses the account of the person it is helping).
- Grant the connector to an agent in [Agents](#/settings/agents) for it to use it.
- Anything that changes something in the other service **asks first**. On the connector's page, set each action to Ask, Always or Never for yourself. See **help: permissions**.
`,
} satisfies HelpPage;
