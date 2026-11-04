import { MAX_WEBHOOK_BYTES } from "@companybot/core";
import { httpRouter } from "convex/server";
import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
import { auth } from "./auth";
import { upload as uploadFile } from "./files";
import { upload, uploadOptions } from "./images";
import { callback } from "./oauth";

const http = httpRouter();
auth.addHttpRoutes(http);
http.route({ path: "/oauth/callback", method: "GET", handler: callback });
/** Pictures from the app (images.ts), signed in. */
http.route({ path: "/images/upload", method: "POST", handler: upload });
http.route({ path: "/images/upload", method: "OPTIONS", handler: uploadOptions });
/** Files for messages (files.ts), signed in. */
http.route({ path: "/files/upload", method: "POST", handler: uploadFile });
http.route({ path: "/files/upload", method: "OPTIONS", handler: uploadOptions });

/** Webhook automations' URLs: POST /automations/<token> (automationRuns.receive). */
http.route({
	pathPrefix: "/automations/",
	method: "POST",
	handler: httpAction(async (ctx, request) => {
		const reply = (status: number, ok: boolean, message: string) =>
			new Response(JSON.stringify({ ok, message }), { status, headers: { "Content-Type": "application/json" } });
		const tooBig = () => reply(413, false, `Body is over ${MAX_WEBHOOK_BYTES / 1000} KB.`);
		if (Number(request.headers.get("content-length") ?? 0) > MAX_WEBHOOK_BYTES) return tooBig();
		const body = await request.text();
		if (new TextEncoder().encode(body).length > MAX_WEBHOOK_BYTES) return tooBig();
		const token = new URL(request.url).pathname.slice("/automations/".length);
		const result = await ctx.runMutation(internal.automationRuns.receive, { token, body });
		return reply(result.status, result.ok, result.message);
	}),
});

export default http;
