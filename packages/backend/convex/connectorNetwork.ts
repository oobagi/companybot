"use node";

import { lookup } from "node:dns/promises";
import type { LookupFunction } from "node:net";
import { customUrlProblem } from "@companybot/core";
import { isPublicAddress } from "@companybot/core/safe-fetch";
import { v } from "convex/values";
import { Agent, fetch } from "undici";
import { internalAction } from "./_generated/server";

// The network custom connectors reach their servers through (core `PinnedNetwork`, `connectorFetch`).
// The agent runner and sign-in run in Convex's default runtime, whose fetch looks hosts up itself,
// so it can't be held to an address that was checked. These run in Node: `addresses` looks a host up
// once, the caller checks every answer is public, and `request` connects only to those addresses.

/** Every address `hostname` resolves to; none if it doesn't resolve. */
export const addresses = internalAction({
	args: { hostname: v.string() },
	handler: async (_ctx, { hostname }): Promise<string[]> => {
		try {
			return (await lookup(hostname, { all: true })).map((a) => a.address);
		} catch {
			return [];
		}
	},
});

/**
 * A dispatcher that connects only to `addresses`, whatever the URL's host resolves to now. The URL keeps
 * its hostname, so the Host header and the TLS server name (and certificate check) are the host's own.
 */
export function pinnedAgent(addresses: string[]) {
	const pinned: LookupFunction = (_host, options, callback) => {
		const all = addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
		if (options.all) callback(null, all);
		else callback(null, all[0]!.address, all[0]!.family);
	};
	return new Agent({ connect: { lookup: pinned } });
}

/** The most a response may be: it comes back to the runner whole. */
const MAX_BYTES = 8 * 1024 * 1024;
/** A tool call may take a while; past this it's cut off. */
const TIMEOUT_MS = 5 * 60_000;

/**
 * One request to a custom connector's server, connecting only to `addresses` (checked public by the
 * caller, and again here). Never looks the host up and never follows a redirect: a 3xx comes back as is.
 */
export const request = internalAction({
	args: {
		url: v.string(),
		addresses: v.array(v.string()),
		method: v.string(),
		headers: v.array(v.array(v.string())),
		body: v.optional(v.bytes()),
	},
	handler: async (_ctx, { url, addresses, method, headers, body }) => {
		const problem = customUrlProblem(url);
		if (problem) throw new Error(problem);
		if (addresses.length === 0 || !addresses.every(isPublicAddress)) throw new Error(`${new URL(url).hostname} is a private or local address, so it can't be reached.`);
		const dispatcher = pinnedAgent(addresses);
		try {
			const response = await fetch(url, {
				method,
				headers: headers as [string, string][],
				body: body === undefined ? undefined : new Uint8Array(body),
				redirect: "manual",
				dispatcher,
				signal: AbortSignal.timeout(TIMEOUT_MS),
			});
			const chunks: Uint8Array[] = [];
			let size = 0;
			for await (const chunk of response.body ?? []) {
				size += chunk.byteLength;
				if (size > MAX_BYTES) throw new Error(`The server's answer is over ${MAX_BYTES / 1024 / 1024} MB.`);
				chunks.push(chunk);
			}
			const bytes = new Uint8Array(size);
			let at = 0;
			for (const chunk of chunks) (bytes.set(chunk, at), (at += chunk.byteLength));
			return { status: response.status, statusText: response.statusText, headers: [...response.headers] as string[][], body: bytes.buffer };
		} finally {
			void dispatcher.close();
		}
	},
});
