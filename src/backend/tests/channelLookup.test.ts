import { setup, signIn } from "./helpers";
import { expect, it } from "vitest";
import { api } from "../convex/_generated/api";
import { channelNamed, normalizeChannelName } from "../convex/chatOps";
import { memberOf } from "../convex/lib";

it("looks up only active channels the person can see, in their workspace", async () => {
	const { t, owner, member } = await setup();
	const stranger = await signIn(t, "stranger@co.com");
	const workspaceId = (await owner.query(api.workspace.me))!.workspaceId!;
	const elsewhereId = (await stranger.query(api.workspace.me))!.workspaceId!;
	const publicId = await owner.mutation(api.chats.createChannel, { name: "sales-team", private: false });
	const privateId = await member.mutation(api.chats.createChannel, { name: "private", private: true });
	const archivedId = await owner.mutation(api.chats.createChannel, { name: "archived", private: false });
	const dmId = await owner.mutation(api.chats.openDm, { userIds: [member.userId], agentIds: [] });
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
		const elsewhere = (await memberOf(ctx, stranger.userId, elsewhereId))!;
		expect(await channelNamed(ctx, elsewhere, "sales-team")).toBeNull();
	});
});

it("preserves the callers' existing channel-name handling", async () => {
	const { t, owner: as } = await setup();
	const userId = as.userId;
	const workspaceId = (await as.query(api.workspace.me))!.workspaceId!;
	const id = await as.mutation(api.chats.createChannel, { name: "sales-team", private: false });
	await t.run(async (ctx) => {
		const member = (await memberOf(ctx, userId, workspaceId))!;
		// Chat tools accept creation-style normalization; automation tools accept literal names.
		expect((await channelNamed(ctx, member, normalizeChannelName("##Sales_Team")))?._id).toBe(id);
		expect(await channelNamed(ctx, member, "##Sales_Team")).toBeNull();
	});
});
