import { connectorCatalog, defineConnector } from "@companybot/core";

// A test connector, so connector flows can run without a real connector in the catalog.
const notes = defineConnector({
	id: "notes",
	name: "Notes",
	description: "Test connector",
	version: "1.0.0",
	publisher: "Test",
	mcp: { url: "https://example.com/mcp", transport: "http" },
	connection: "personal",
	auth: { type: "api_key", header: "Authorization", prefix: "Bearer ", label: "API key" },
});
const crm = defineConnector({ ...notes, id: "crm", name: "CRM", connection: "workspace" });
connectorCatalog.push(notes, crm);
process.env.CONNECTIONS_KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));

