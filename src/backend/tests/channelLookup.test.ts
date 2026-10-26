import { convexTest } from "convex-test";
import { expect, it } from "vitest";
import { api } from "../convex/_generated/api";
import { channelNamed, normalizeChannelName } from "../convex/chatOps";
import { memberOf } from "../convex/lib";
import schema from "../convex/schema";
import { person } from "./person";

const modules = import.meta.glob(["../convex/**/*.ts", "../convex/_generated/*.js"]);

it("looks up only active channels the person can see, in their workspace", async () => {
	const t = convexTest({ schema, modules, transactionLimits: true });
	const signIn = async (email: string) => {
		const userId = await t.run((ctx) => ctx.db.insert("users", { email }));
		const as = person(t.withIdentity({ subject: `${userId}|session` }));
		await as.mutation(api.workspace.ensure);
		return { as, userId };
	};
	const owner = await signIn("owner@co.com");
	await owner.as.mutation(api.workspace.invite, { email: "member@co.com", role: "member" });
	const member = await signIn("member@co.com");
	const stranger = await signIn("stranger@co.com");
	const workspaceId = (await owner.as.query(api.workspace.me))!.workspaceId!;
	const publicId = await owner.as.mutation(api.chats.createChannel, { name: "sales-team", private: false });
	const privateId = await member.as.mutation(api.chats.createChannel, { name: "private", private: true });
	const archivedId = await owner.as.mutation(api.chats.createChannel, { name: "archived", private: false });
	const dmId = await owner.as.mutation(api.chats.openDm, { userIds: [member.userId], agentIds: [] });
	await t.run(async (ctx) => {
		await ctx.db.patch(archivedId, { archived: true });
		// A named DM must never be returned by a channel lookup.
		await ctx.db.patch(dmId, { name: "named-dm" });
		const who = (await memberOf(ctx, owner.userId, workspaceId))!;
		expect((await channelNamed(ctx, who, " #SALES-TEAM "))?._id).toBe(publicId);
		expect(await channelNamed(ctx, who, "private")).toBeNull(); // Owners get no extra visibility.
		expect((await channelNamed(ctx, (await memberOf(ctx, member.userId, workspaceId))!, "private"))?._id).toBe(privateId);
		expect(await channelNamed(ctx, who, "archived")).toBeNull();
		expect(await channelNamed(ctx, who, "named-dm")).toBeNull();
		expect(await channelNamed(ctx, who, "missing")).toBeNull();
		const elsewhere = (await memberOf(ctx, stranger.userId, (await ctx.db.query("members").withIndex("by_user", (q) => q.eq("userId", stranger.userId)).first())!.workspaceId))!;
		expect(await channelNamed(ctx, elsewhere, "sales-team")).toBeNull();
	});
});

it("preserves the callers' existing channel-name handling", async () => {
	const t = convexTest({ schema, modules, transactionLimits: true });
	const userId = await t.run((ctx) => ctx.db.insert("users", { email: "owner@co.com" }));
	const as = person(t.withIdentity({ subject: `${userId}|session` }));
	await as.mutation(api.workspace.ensure);
	const workspaceId = (await as.query(api.workspace.me))!.workspaceId!;
	const id = await as.mutation(api.chats.createChannel, { name: "sales-team", private: false });
	await t.run(async (ctx) => {
		const member = (await memberOf(ctx, userId, workspaceId))!;
		// Chat tools accept creation-style normalization; automation tools accept literal names.
		expect((await channelNamed(ctx, member, normalizeChannelName("##Sales_Team")))?._id).toBe(id);
		expect(await channelNamed(ctx, member, "##Sales_Team")).toBeNull();
	});
});
