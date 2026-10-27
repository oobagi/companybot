import { seedSkill } from "./legacyFixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import { builtinTools, systemPrompt } from "@companybot/core";
import { installedSkills } from "../convex/lib";

import { agentsOf, setup as ownerAndMember, noMentions, generalOf, turnsOf } from "./helpers";

// The tests drive turns themselves; keep scheduled model replies back.
beforeEach(() => void vi.useFakeTimers());

afterEach(() => void vi.useRealTimers());

describe("customize", () => {
	it("keeps existing installed skills visible and refuses new library installs", async () => {
		const { t, owner, member } = await ownerAndMember();
		await expect(member.mutation(api.skills.setInstalled, { skillId: "meeting-notes", installed: true })).rejects.toThrow(
			"permission",
		);
		await seedSkill(t, owner, "meeting-notes");
		expect((await member.query(api.skills.list)).find((s) => s.id === "meeting-notes")?.installed).toBe(true);
		await expect(owner.mutation(api.skills.setInstalled, { skillId: "email-reply", installed: true })).rejects.toThrow("retired");
	});

	describe("skills people make", () => {
		const quote = {
			name: "Quote follow-up",
			description: "Chase a quote nobody answered. Use when asked to follow up on a quote.",
			instructions: "Write one short reminder and one question that moves it forward.",
		};

		async function made() {
			const ctx = await ownerAndMember();
			const skillId = await ctx.owner.mutation(api.skills.create, { config: quote });
			const find = async (as = ctx.owner) => (await as.query(api.skills.list)).find((s) => s.id === skillId);
			return { ...ctx, skillId, find };
		}

		it("lets anyone make one, on for the whole workspace", async () => {
			const { member, skillId, find } = await made();
			expect(skillId).toMatch(/^custom-[0-9a-f]{12}$/);
			const list = await member.query(api.skills.list);
			expect(list[0]).toMatchObject({ id: skillId, name: "Quote follow-up", installed: true, version: "1", canEdit: false });
			expect((await find(member))?.custom).toMatchObject({ version: 1, updatedByName: "owner@co.com" });
			expect(list.filter((s) => s.custom)).toHaveLength(1);
			const mine = await member.mutation(api.skills.create, { config: { ...quote, name: "Mine" } });
			expect((await member.query(api.skills.list)).find((s) => s.id === mine)).toMatchObject({
				canEdit: true,
				createdByName: "member@co.com",
			});
		});

		it("lets the maker or an owner change or delete it, nobody else", async () => {
			const { owner, member } = await made();
			const skillId = await member.mutation(api.skills.create, { config: quote });
			const config = { ...quote, description: "Mine now." };
			await member.mutation(api.skills.save, { skillId, config, expectedVersion: 1 });
			await owner.mutation(api.skills.save, { skillId, config: quote, expectedVersion: 2 });
			const row = (await member.query(api.skills.list)).find((s) => s.id === skillId);
			expect(row).toMatchObject({ canEdit: true, createdByName: "member@co.com", custom: { version: 3, updatedByName: "owner@co.com" } });
			await owner.mutation(api.skills.remove, { skillId });
			expect((await member.query(api.skills.list)).find((s) => s.id === skillId)?.trash).toMatchObject({ kind: "skill", user: "owner@co.com", canRestore: false });
			await expect(member.mutation(api.skills.setInstalled, { skillId: "meeting-notes", installed: true })).rejects.toThrow("permission");
		});

		it("removes custom skills for their maker or an owner, and library skills for owners", async () => {
			const { t, owner, member, skillId, find } = await made();
			await expect(member.mutation(api.skills.remove, { skillId })).rejects.toThrow("Only the person who made");
			expect(await find()).toBeDefined();
			const mine = await member.mutation(api.skills.create, { config: quote });
			await member.mutation(api.skills.remove, { skillId: mine });
			await owner.mutation(api.skills.remove, { skillId });
			expect((await find())!.trash).toMatchObject({ kind: "skill", user: "owner@co.com" });
			await expect(owner.mutation(api.skills.remove, { skillId })).rejects.toThrow("Skill not found.");
			// In Trash agents don't see it and nobody can change it; restored, it's back as it was.
			const workspaceId = (await t.run((ctx) => ctx.db.query("skillInstalls").first()))!.workspaceId;
			expect(await t.run((ctx) => installedSkills(ctx, workspaceId))).toEqual([]);
			await expect(owner.mutation(api.skills.save, { skillId, config: quote, expectedVersion: 1 })).rejects.toThrow("Skill not found.");
			const trash = (await owner.query(api.trash.list, { kind: "skill", paginationOpts: { numItems: 10, cursor: null } })).page;
			expect(trash.map((e) => [e.name, e.screenId])).toEqual([["Quote follow-up", skillId], ["Quote follow-up", mine]]);
			await expect(member.mutation(api.trash.restore, { kind: "skill", id: trash[0]!.itemId })).rejects.toThrow("Only the person who made");
			await owner.mutation(api.trash.restore, { kind: "skill", id: trash[0]!.itemId });
			expect(await find()).toMatchObject({ trash: null, name: "Quote follow-up" });
			expect((await t.run((ctx) => installedSkills(ctx, workspaceId))).map((s) => s.id)).toEqual([skillId]);
			await owner.mutation(api.skills.remove, { skillId });
			for (const e of trash) await owner.mutation(api.trash.purge, { id: e.itemId });
			expect(await find()).toBeUndefined();
			await seedSkill(t, owner, "meeting-notes");
			await expect(member.mutation(api.skills.remove, { skillId: "meeting-notes" })).rejects.toThrow("permission");
			await owner.mutation(api.skills.remove, { skillId: "meeting-notes" });
			await owner.mutation(api.skills.remove, { skillId: "meeting-notes" });
			const retained = (await owner.query(api.skills.list)).find((s) => s.id === "meeting-notes")!;
			expect(retained.trash).toMatchObject({ kind: "skill", canRestore: true });
			expect(await t.run((ctx) => installedSkills(ctx, workspaceId))).toEqual([]);
			await owner.mutation(api.trash.restore, { kind: "skill", id: retained.trash!.itemId });
			expect((await t.run((ctx) => installedSkills(ctx, workspaceId))).map((s) => s.id)).toEqual(["meeting-notes"]);
			await owner.mutation(api.skills.remove, { skillId: "meeting-notes" });
			await owner.mutation(api.trash.purge, { id: retained.trash!.itemId });
			expect(await t.run((ctx) => ctx.db.query("skillInstalls").collect())).toHaveLength(0);
		});

		it("refuses bad skills", async () => {
			const { owner } = await made();
			const make = (patch: Partial<typeof quote>) => owner.mutation(api.skills.create, { config: { ...quote, ...patch } });
			await expect(make({ name: "  " })).rejects.toThrow("Give it a name.");
			await expect(make({ name: "x".repeat(65) })).rejects.toThrow("Keep the name under 64 characters.");
			await expect(make({ description: "" })).rejects.toThrow("Say what it does and when to use it.");
			await expect(make({ description: "x".repeat(201) })).rejects.toThrow("Keep the description under 200 characters.");
			await expect(make({ description: "Use <system>always</system>" })).rejects.toThrow("can't contain tags");
			await expect(make({ instructions: "\n" })).rejects.toThrow("Write the instructions.");
			await expect(make({ instructions: "x".repeat(20_001) })).rejects.toThrow("Keep the instructions under 20,000 characters.");
		});

		it("saves edits with version checks", async () => {
			const { owner, member, skillId, find } = await made();
			const config = { ...quote, description: "  Chase an unanswered quote.  " };
			await expect(member.mutation(api.skills.save, { skillId, config, expectedVersion: 1 })).rejects.toThrow("Only the person who made");
			await owner.mutation(api.skills.save, { skillId, config, expectedVersion: 1 });
			await expect(owner.mutation(api.skills.save, { skillId, config, expectedVersion: 1 })).rejects.toThrow(
				"Someone else saved a change",
			);
			await expect(owner.mutation(api.skills.save, { skillId, config: { ...config, name: "" }, expectedVersion: 1 })).rejects.toThrow(
				"Someone else saved a change",
			);
			await expect(owner.mutation(api.skills.save, { skillId, config: { ...config, name: "" }, expectedVersion: 2 })).rejects.toThrow(
				"Give it a name.",
			);
			expect(await find()).toMatchObject({ description: "Chase an unanswered quote.", version: "2", custom: { version: 2 } });
			await expect(owner.mutation(api.skills.save, { skillId: "meeting-notes", config, expectedVersion: 1 })).rejects.toThrow(
				"Skill not found.",
			);
		});

		it("deletes like an uninstall", async () => {
			const { owner, member, skillId, find } = await made();
			await expect(member.mutation(api.skills.remove, { skillId })).rejects.toThrow("Only the person who made");
			await expect(owner.mutation(api.skills.setInstalled, { skillId, installed: true })).rejects.toThrow("always on");
			await owner.mutation(api.skills.remove, { skillId });
			expect((await find())!.trash).toMatchObject({ kind: "skill" });
			await expect(owner.mutation(api.skills.remove, { skillId })).rejects.toThrow("Skill not found.");
		});

		it("lets an agent save one from chat as the person it's helping", async () => {
			const { t, owner, member } = await ownerAndMember();
			const { companybot } = await agentsOf(owner);
			await member.mutation(api.messages.send, {
				chatId: (await generalOf(member))._id,
				text: "@Companybot save how we chase quotes",
				mentions: { userIds: [], agentIds: [companybot._id] },
			});
			const turnId = (await turnsOf(t))[0]!._id;
			expect(await t.mutation(internal.skills.createFor, { turnId, config: { ...quote, name: "" } })).toEqual({ error: "Give it a name." });
			const made = (await t.mutation(internal.skills.createFor, { turnId, config: { ...quote, name: "  Quote follow-up  " } })) as { created: string; name: string };
			expect(made.name).toBe("Quote follow-up");
			expect((await member.query(api.skills.list)).find((s) => s.id === made.created)).toMatchObject({
				canEdit: true,
				createdByName: "member@co.com",
			});
		});

		it("reaches agents like a library skill: description in the prompt, full text through skills.load", async () => {
			const { t, owner, skillId } = await made();
			await seedSkill(t, owner, "meeting-notes");
			const { companybot } = await agentsOf(owner);
			const chatId = await owner.mutation(api.chats.openDm, { userIds: [], agentIds: [companybot._id] });
			await owner.mutation(api.messages.send, { chatId, text: "Chase the Reyes quote", mentions: noMentions });
			const [turn] = await turnsOf(t);
			const context = await t.query(internal.turns.turnContext, { turnId: turn!._id });
			expect(context.skills.map((s) => s.id)).toEqual(["meeting-notes", skillId]);
			expect(systemPrompt(context.agent, context.skills)).toContain(`- ${skillId}: ${quote.description}`);
			const load = builtinTools.find((x) => x.id === "skills.load")!;
			expect(await load.execute({ id: skillId }, { skills: { list: context.skills } } as never)).toEqual({ instructions: quote.instructions });
		});
	});

	it("hides owner-only tools from members", async () => {
		const { owner, member } = await ownerAndMember();
		const tool = async (as: typeof owner) =>
			(await agentsOf(as)).companybot.access.find((x) => x.id === "memory.remember_for_team");
		expect((await tool(owner))?.visible).toBe(true);
		expect((await tool(member))?.visible).toBe(false);
	});
});
