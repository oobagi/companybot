import { afterEach, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import { newTest } from "./helpers";

// `localCode` is a public query that hands back sign-in codes, so `pnpm dev` can sign in without
// email. Anywhere but a loopback backend it must never store or reveal one: that would let anyone
// sign in as anyone.

afterEach(() => void vi.unstubAllEnvs());

it.each(["https://happy-otter-123.convex.cloud", "http://localhost.evil.com", undefined])("never stores or shows a sign-in code on %s", async (url) => {
	vi.stubEnv("CONVEX_CLOUD_URL", url);
	const t = newTest();
	await t.mutation(internal.auth.saveLocalCode, { email: "ada@co.com", code: "123456" });
	expect(await t.run((ctx) => ctx.db.query("localSignInCodes").collect())).toEqual([]);
	await t.run((ctx) => ctx.db.insert("localSignInCodes", { email: "ada@co.com", code: "123456" }));
	expect(await t.query(api.auth.localCode, { email: "ada@co.com" })).toBeNull();
});

it("lets a local backend read back the latest code for that email only", async () => {
	vi.stubEnv("CONVEX_CLOUD_URL", "http://127.0.0.1:3210");
	const t = newTest();
	await t.mutation(internal.auth.saveLocalCode, { email: "ada@co.com", code: "111111" });
	await t.mutation(internal.auth.saveLocalCode, { email: "ada@co.com", code: "222222" });
	expect(await t.query(api.auth.localCode, { email: "ada@co.com" })).toBe("222222");
	expect(await t.query(api.auth.localCode, { email: "ben@co.com" })).toBeNull();
});
