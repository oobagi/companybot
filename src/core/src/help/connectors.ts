import type { HelpPage } from "./index";

export default {
	id: "connectors",
	title: "Connectors",
	summary: "Connecting official services and custom MCP servers for agents to use.",
	text: `# Connectors
A connector links an outside service so agents can use it for you. They live in [Connectors](#/settings/connectors).

## Official services
The catalog includes **GitHub, Notion, Linear, Sentry, Atlassian (Jira and Confluence), Stripe, Slack, and Asana**. These connect directly to servers operated by those providers. Nothing is installed or connected automatically.

Open a service, read its setup instructions, then **Install**. New catalog installs start **Owners only**; select other roles under **Who can use it** if needed. Each person connects their own provider account. Grant the connector to an agent in [Agents](#/settings/agents).

- **GitHub** uses your personal access token. Limit it to the repositories and permissions you need; your organization may need to approve it.
- **Notion, Linear, Sentry, Atlassian, and Stripe** open the provider's sign-in and consent page. The provider may require administrator approval. For Stripe, start with sandbox and read-only access.
- **Slack and Asana** require an app you register with the provider first. Connect shows the redirect URL, provider setup instructions, and fields for your client ID and secret. The provider's issuer is fixed. Slack requests public-channel search and history, user lookup, posting, and reactions; it does not request private-channel or direct-message history.

The provider's permissions and plan determine which tools you get. Saved credentials are not proof that every tool is usable. **Refresh list** on the connector's Actions section discovers its tools without asking an agent to run them. Connection errors are shown on its page. Connecting does not change your provider data.

## Adding your own (custom connectors)
People whose role can install connectors add any service with an **MCP server**: **New connector** in the Connectors top bar. Fill in:
- **Name** and an optional description.
- **Server URL**: the server's https address. **Streamable HTTP only**, which most MCP servers use (often a URL ending in /mcp). The older SSE transport is deprecated in MCP and can't be added. Local and private addresses (localhost, 10.x, 192.168.x, cloud metadata) are refused, when you save and again before every connection. Each connection goes only to the address that was checked, and redirects aren't followed.
- **Account**: one shared account, or each person's own.
- **Sign-in**: none, an API key (which header it goes in, an optional prefix such as "Bearer ", and what to call the key), or OAuth (sign in through the browser).

**Who can use it** starts with Owners only. Select any other roles during creation, or change them on its page later. Existing connectors keep their audience. On its page, **Edit** changes it and **Remove** deletes it. Changing its server, account type or sign-in disconnects everyone and resets its Ask / Always / Never settings, since the old ones were for a different server. Removing it deletes its connections and settings, and agents granted it lose its tools. Agents can't add, change or remove connectors.

## OAuth sign-in
For a custom OAuth connector, **Connect** lets you register automatically or **Use a registered app**. If the provider requires a registered app, register the displayed redirect URL with that provider, then enter its client ID, OAuth issuer URL and, if required, client secret. These credentials belong to this connection and are stored encrypted with its tokens. They are not saved in form drafts or shown to other members. The issuer must match the provider discovered by the server. Reconnecting requires entering the app credentials again.

MCP access does not install a Slack bot in Companybot. Slack's official MCP server also requires a suitable registered Slack app and scopes. A server still needs to support the transport and OAuth flow Companybot uses.

## How they work
- People whose role can install connectors pick which roles can use each one (owners always can).
- A connector uses either **one shared account** for the workspace (someone who can install connectors sets it) or **each person's own account** (everyone connects theirs with **Connect** on its page; an agent uses the account of the person it is helping).
- Grant the connector to an agent in [Agents](#/settings/agents) for it to use it. Its tools are read from the server each time the agent works.
- Custom servers' actions **ask first**, even if the server calls them read-only. Only built-in catalog connectors may use read-only hints to skip asking. Anything a server marks destructive always asks. On the connector's page, set each action to Ask, Always or Never for yourself. See **help: permissions**.
`,
} satisfies HelpPage;
