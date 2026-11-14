"use node";
import { lookup } from "node:dns/promises";
import { createHmac } from "node:crypto";
import { fetch } from "undici";
import { isPublicAddress } from "@companybot/core/safe-fetch";
import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { pinnedAgent } from "./connectorNetwork";
import { decrypt } from "./crypto";

export const deliver = internalAction({ args: { id: v.id("integrationWebhooks") }, handler: async (ctx, { id }) => {
	const send = await ctx.runMutation(internal.integrationWebhooks.prepare, { id });
	if (!send) return;
	let status = 0;
	try {
		const url = new URL(send.url);
		const addresses = (await lookup(url.hostname, { all: true })).map(a => a.address);
		if (url.protocol !== "https:" || !addresses.length || !addresses.every(isPublicAddress)) throw new Error("Private destination.");
		const dispatcher = pinnedAgent(addresses);
		try {
			const time = String(Math.floor(Date.now() / 1000));
			const signature = createHmac("sha256", await decrypt<string>(send.secret)).update(`${time}.${send.body}`).digest("hex");
			const response = await fetch(url, { method: "POST", body: send.body, headers: { "Content-Type": "application/json", "Companybot-Signature": `t=${time},v1=${signature}`, "Companybot-Delivery": send.deliveryId }, redirect: "manual", dispatcher, signal: AbortSignal.timeout(10000) });
			status = response.status;
			await response.body?.cancel();
		} finally { void dispatcher.close(); }
	} catch { /* Do not persist response bodies, DNS errors or destination details. */ }
	await ctx.runMutation(internal.integrationWebhooks.complete, { id, deliveryId: send.deliveryId, status });
} });

/** URL-based MCP client identity. No credentials, redirects, private addresses, or unbounded documents. */
export const resolveClient = internalAction({ args: { clientId: v.string() }, handler: async (ctx, { clientId }) => {
	const url = new URL(clientId);
	if (clientId.length > 2048 || url.protocol !== "https:" || url.pathname === "/" || url.username || url.password || url.hash || url.search) throw new Error("Invalid client metadata URL.");
	const addresses = (await lookup(url.hostname, { all: true })).map(a => a.address);
	if (!addresses.length || !addresses.every(isPublicAddress)) throw new Error("Private client metadata address.");
	const dispatcher = pinnedAgent(addresses);
	try {
		const response = await fetch(url, { headers: { Accept: "application/json" }, redirect: "manual", dispatcher, signal: AbortSignal.timeout(10000) });
		if (response.status !== 200 || response.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") { await response.body?.cancel(); throw new Error("Invalid client metadata response."); }
		const chunks: Uint8Array[] = [];
		let size = 0;
		for await (const chunk of response.body ?? []) { size += chunk.length; if (size > 16384) throw new Error("Client metadata exceeds 16 KiB."); chunks.push(chunk); }
		const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		if (body.client_id !== clientId || typeof body.client_name !== "string" || !Array.isArray(body.redirect_uris) || body.redirect_uris.some((s: unknown) => typeof s !== "string") || body.token_endpoint_auth_method && body.token_endpoint_auth_method !== "none") throw new Error("Invalid client metadata.");
		const control = response.headers.get("cache-control") ?? "";
		// No-cache documents are fetched for every authorization start; the validated registration still backs the consent and issued grant.
		const maxAge = /no-store|no-cache/.test(control) ? 0 : Number(/max-age=(\d+)/.exec(control)?.[1] ?? 300);
		await ctx.runMutation(internal.integrationOAuth.rememberMetadata, { clientId, name: body.client_name, redirects: body.redirect_uris, maxAge });
	} finally { void dispatcher.close(); }
} });
