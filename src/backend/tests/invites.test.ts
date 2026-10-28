import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../convex/_generated/api";
import { DOWNLOAD_URL, INVITE_EMAILS_PER_DAY, inviteEmail } from "@companybot/core";

import { signIn, workspaceOf, inWorkspace, sideWorkspace, ownerAndMember, noMentions, settle, newTest } from "./helpers";

afterEach(() => void vi.useRealTimers());

describe("invites", () => {
	const sent = (t: ReturnType<typeof convexTest>) => t.run((ctx) => ctx.db.query("inviteEmails").collect());

	it("emails the invite, saying who invited them, and lets owners resend or cancel it", async () => {
		const { t, owner, member } = await ownerAndMember();
		await owner.mutation(api.preferences.update, { displayName: "Jaden" });
		await owner.mutation(api.workspace.updateSettings, { name: "Acme", expectedVersion: 1 });
		await owner.mutation(api.workspace.invite, { email: "Pal@Co.com", role: "member" });
		expect((await sent(t)).map((e) => e.email)).toEqual(["member@co.com", "pal@co.com"]);
		const invite = (await owner.query(api.workspace.team))!.invites[0]!;
		await expect(member.mutation(api.workspace.resendInvite, { id: invite.id })).rejects.toThrow("permission");

		// The same address can't be emailed again right away.
		await expect(owner.mutation(api.workspace.resendInvite, { id: invite.id })).rejects.toThrow("a moment ago");
		vi.useFakeTimers({ now: Date.now() + 11 * 60_000, toFake: ["Date"] });
		await owner.mutation(api.workspace.resendInvite, { id: invite.id });
		vi.useRealTimers();
		expect(await sent(t)).toHaveLength(3);

		await owner.mutation(api.workspace.cancelInvite, { id: invite.id });
		expect((await owner.query(api.workspace.team))!.invites).toEqual([]);
		// Cancelling and inviting again doesn't get around the wait: the invite is saved, the email isn't sent.
		expect(await owner.mutation(api.workspace.invite, { email: "pal@co.com", role: "member" })).toEqual({ emailed: false });
		expect(await sent(t)).toHaveLength(3);
		expect(inviteEmail({ inviter: "Eve\r\nBcc: x@evil.com", workspace: "Acme\n", email: "pal@co.com" }).subject).toBe(
			"Eve Bcc: x@evil.com invited you to Acme on Companybot",
		);
		expect(inviteEmail({ inviter: "Jaden", workspace: "Acme", email: "pal@co.com" })).toMatchObject({
			subject: "Jaden invited you to Acme on Companybot",
			text: expect.stringContaining(DOWNLOAD_URL),
		});
	});

	it("caps invite emails per workspace per day", async () => {
		const { t, owner } = await ownerAndMember();
		for (let i = 1; i < INVITE_EMAILS_PER_DAY; i++) await owner.mutation(api.workspace.invite, { email: `p${i}@co.com`, role: "member" });
		await expect(owner.mutation(api.workspace.invite, { email: "one-more@co.com", role: "member" })).rejects.toThrow("Try again tomorrow");
		// Refused invites aren't saved half-done.
		expect((await owner.query(api.workspace.team))!.invites).toHaveLength(INVITE_EMAILS_PER_DAY - 1);
		expect(await sent(t)).toHaveLength(INVITE_EMAILS_PER_DAY);
	});

	it("lets someone who already has a workspace accept, then switch between both", async () => {
		const t = newTest();
		const owner = await signIn(t, "owner@co.com");
		await owner.mutation(api.workspace.updateSettings, { name: "Acme", expectedVersion: 1 });
		const pal = await signIn(t, "pal@co.com");
		const palsOwn = await workspaceOf(pal);
		await owner.mutation(api.workspace.invite, { email: "pal@co.com", role: "member" });
		// Another workspace inviting the same email doesn't block this one.
		const other = await signIn(t, "other@co.com");
		await other.mutation(api.workspace.invite, { email: "pal@co.com", role: "owner" });

		const mine = (await pal.query(api.workspace.mine))!;
		expect(mine.workspaces.map((w) => w.name)).toEqual(["My company"]);
		expect(mine.invitations.map((i) => i.workspace).sort()).toEqual(["Acme", "My company"]);
		const acme = mine.invitations.find((i) => i.workspace === "Acme")!;
		// Only the person invited can use it.
		await expect(other.mutation(api.workspace.acceptInvite, { id: acme.id })).rejects.toThrow("isn't available");

		const acmeId = await pal.mutation(api.workspace.acceptInvite, { id: acme.id });
		expect((await pal.query(api.workspace.mine))!.lastUsed).toBe(acmeId);
		const inAcme = inWorkspace(pal, acmeId);
		expect(await inAcme.query(api.workspace.me)).toMatchObject({ workspace: "Acme", role: "member" });
		// The owner, Companybot (it welcomed the owner there) and Pal.
		expect((await inAcme.query(api.chats.list))!.channels[0]!.members).toHaveLength(3);
		await pal.mutation(api.workspace.declineInvite, { id: mine.invitations.find((i) => i.workspace !== "Acme")!.id });
		expect((await pal.query(api.workspace.mine))!.invitations).toEqual([]);

		await pal.mutation(api.workspace.switchTo, { to: palsOwn });
		expect((await pal.query(api.workspace.mine))!.lastUsed).toBe(palsOwn);
		expect(await inWorkspace(pal, palsOwn).query(api.workspace.me)).toMatchObject({ workspace: "My company", role: "owner" });
		await expect(pal.mutation(api.workspace.switchTo, { to: await workspaceOf(other) })).rejects.toThrow("not in that workspace");
	});

	it("joins every workspace that invited someone new", async () => {
		const t = newTest();
		const a = await signIn(t, "a@co.com");
		const b = await signIn(t, "b@co.com");
		await a.mutation(api.workspace.invite, { email: "new@co.com", role: "member" });
		await b.mutation(api.workspace.invite, { email: "new@co.com", role: "member" });
		const fresh = await signIn(t, "new@co.com");
		expect((await fresh.query(api.workspace.mine))!.workspaces).toHaveLength(2);
		expect((await a.query(api.workspace.team))!.members).toHaveLength(2);
	});

	it("acts in the workspace each request names, whatever another device has open", async () => {
		const { t, owner } = await ownerAndMember();
		const acme = await workspaceOf(owner);
		const side = (await sideWorkspace(t, "owner@co.com")).workspaceId;
		// Another device switches to the side workspace...
		await owner.mutation(api.workspace.switchTo, { to: side });
		// ...while this one, with Acme open, saves settings and invites someone.
		const here = inWorkspace(owner, acme);
		const { version } = (await here.query(api.workspace.settings))!;
		await here.mutation(api.workspace.updateSettings, { name: "Acme", expectedVersion: version });
		await here.mutation(api.workspace.invite, { email: "new@co.com", role: "owner" });
		const names = await t.run(async (ctx) => [(await ctx.db.get(acme))!.name, (await ctx.db.get(side))!.name]);
		expect(names).toEqual(["Acme", "Side gig"]);
		const invites = await t.run((ctx) => ctx.db.query("invites").filter((q) => q.eq(q.field("email"), "new@co.com")).collect());
		expect(invites.map((i) => i.workspaceId)).toEqual([acme]);
		expect((await inWorkspace(owner, side).query(api.workspace.team))!.invites).toEqual([]);
	});

	it("refuses a request for a workspace the person isn't in", async () => {
		const { t, member } = await ownerAndMember();
		const stranger = await signIn(t, "stranger@co.com");
		const theirs = inWorkspace(member, await workspaceOf(stranger));
		expect(await theirs.query(api.workspace.me)).toMatchObject({ role: null });
		expect(await theirs.query(api.chats.list)).toBeNull();
		expect(await theirs.query(api.workspace.team)).toBeNull();
		await expect(theirs.mutation(api.chats.createChannel, { name: "mine-now", private: false })).rejects.toThrow("Sign in to a workspace");
		await expect(theirs.mutation(api.workspace.updateSettings, { name: "Taken", expectedVersion: 1 })).rejects.toThrow();
	});

	it("acts where each request says, whichever workspace another device switched to", async () => {
		const { t, member } = await ownerAndMember();
		const acme = await workspaceOf(member);
		const side = (await sideWorkspace(t, "member@co.com")).workspaceId;
		await member.mutation(api.workspace.switchTo, { to: side });
		expect(await member.query(api.workspace.me)).toMatchObject({ workspaceId: acme, role: "member" });
		await member.mutation(api.workspace.switchTo, { to: acme });
		await member.mutation(api.workspace.switchTo, { to: side });
		expect((await member.query(api.workspace.me))!.workspaceId).toBe(acme);
	});

	it("lets people leave, but not the last owner, and removal ends access at once", async () => {
		const { t, owner, member } = await ownerAndMember();
		await expect(owner.mutation(api.workspace.leave)).rejects.toThrow("only owner");
		const secret = await owner.mutation(api.chats.createChannel, { name: "board", private: true });
		const memberId = member.userId;
		await owner.mutation(api.chats.addMembers, { chatId: secret, userIds: [memberId], agentIds: [] });
		const dm = await owner.mutation(api.chats.openDm, { userIds: [memberId], agentIds: [] });
		expect(await member.query(api.chats.get, { chatId: secret })).not.toBeNull();

		const row = (await owner.query(api.workspace.team))!.members.find((m) => !m.isYou)!;
		await owner.mutation(api.workspace.removeMember, { id: row.id });
		expect(await member.query(api.chats.get, { chatId: secret })).toBeNull();
		await expect(member.mutation(api.messages.send, { chatId: dm, text: "still here?", mentions: noMentions })).rejects.toThrow();
		// Rejoining waits until what was theirs is gone.
		await owner.mutation(api.workspace.invite, { email: "member@co.com", role: "member" });
		await expect(member.mutation(api.workspace.ensure)).rejects.toThrow("still being cleaned up");
		await settle(t);
		// Their seat in channels is gone, so rejoining doesn't bring back private ones; DMs keep them listed.
		expect((await owner.query(api.chats.get, { chatId: secret }))!.members).toHaveLength(1);
		expect((await owner.query(api.chats.get, { chatId: dm }))!.members).toHaveLength(2);
		await member.mutation(api.workspace.ensure);
		expect(await member.query(api.chats.get, { chatId: secret })).toBeNull();

		await member.mutation(api.workspace.leave);
		expect((await owner.query(api.workspace.team))!.members).toHaveLength(1);
	});
});
