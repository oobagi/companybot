import type { HelpPage } from "./index";

export default {
	id: "connectors",
	title: "Connectors",
	summary: "Linking outside services, such as Gmail or Calendar, for agents to use.",
	text: `# Connectors
A connector links an outside service so agents can use it for you. They live in [Connectors](#/settings/connectors).

## Adding your own (custom connectors)
People whose role can install connectors add any service with an **MCP server**: **New connector** in the Connectors top bar. Fill in:
- **Name** and an optional description.
- **Server URL**: the server's https address. It must use Streamable HTTP, which most MCP servers do; servers that only speak the older SSE transport can't be added. Local and private addresses (localhost, 10.x, 192.168.x, cloud metadata) are refused, when you save and again before every connection. Each connection goes only to the address that was checked, and redirects aren't followed.
- **Account**: one shared account, or each person's own.
- **Sign-in**: none, an API key (which header it goes in, an optional prefix such as "Bearer ", and what to call the key), or OAuth (sign in through the browser).

Anyone with Member can use it once it's connected; change who can on its page. On its page, **Edit** changes it and **Remove** deletes it. Changing its server, account type or sign-in disconnects everyone and resets its Ask / Always / Never settings, since the old ones were for a different server. Removing it deletes its connections and settings, and agents granted it lose its tools. Agents can't add, change or remove connectors.

## How they work
- People whose role can install connectors pick which roles can use each one (owners always can).
- A connector uses either **one shared account** for the workspace (someone who can install connectors sets it) or **each person's own account** (everyone connects theirs with **Connect** on its page; an agent uses the account of the person it is helping).
- Grant the connector to an agent in [Agents](#/settings/agents) for it to use it. Its tools are read from the server each time the agent works.
- Anything the server doesn't mark read-only **asks first**, and anything it marks destructive always asks. On the connector's page, set each action to Ask, Always or Never for yourself. See **help: permissions**.
`,
} satisfies HelpPage;
