import { serve } from "@hono/node-server";
import { createApp } from "./app";

const port = Number(process.env.PORT ?? 8787);

if (!process.env.AI_GATEWAY_API_KEY) {
	console.warn("AI_GATEWAY_API_KEY is not set — chat will fail. Add it to .env.local.");
}

serve({ fetch: createApp().fetch, port }, () => {
	console.log(`Companybot server on http://localhost:${port}`);
});
