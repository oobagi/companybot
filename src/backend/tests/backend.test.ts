import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api } from "../convex/_generated/api";
import schema from "../convex/schema";

const modules = import.meta.glob(["../convex/**/*.ts", "../convex/_generated/*.js"]);

/** A signed-in person. Convex Auth reads the user id from the token subject. */
async function signIn(t: ReturnType<typeof convexTest>, email: string) {
	const userId = await t.run((ctx) => ctx.db.insert("users", { email }));
	const as = t.withIdentity({ subject: `${userId}|session` });
	await as.mutation(api.workspace.ensure);
	return as;
}

async function ownerAndMember() {
	const t = convexTest(schema, modules);
	const owner = await signIn(t, "owner@co.com");
	await owner.mutation(api.workspace.invite, { email: "Member@Co.com", role: "member" });
	const member = await signIn(t, "member@co.com");
	return { t, owner, member };
}

describe("workspaces", () => {
	it("makes the first person owner and lets invited people join as members", async () => {
		const { owner, member } = await ownerAndMember();
		expect((await owner.query(api.workspace.me))?.role).toBe("owner");
		expect((await member.query(api.workspace.me))?.role).toBe("member");
		expect((await owner.query(api.workspace.team))?.members).toHaveLength(2);
	});

	it("only lets owners invite", async () => {
		const { member } = await ownerAndMember();
		await expect(member.mutation(api.workspace.invite, { email: "x@co.com", role: "member" })).rejects.toThrow(
			"Only owners",
		);
	});
});

describe("memory", () => {
	it("enforces team vs personal permissions", async () => {
		const { t, owner, member } = await ownerAndMember();
		await owner.mutation(api.memory.create, { scope: "workspace", content: "We close at 5pm." });
		await expect(member.mutation(api.memory.create, { scope: "workspace", content: "x" })).rejects.toThrow(
			"Only owners",
		);
		await member.mutation(api.memory.create, { scope: "personal", content: "I like mornings." });

		const third = await (async () => {
			await owner.mutation(api.workspace.invite, { email: "third@co.com", role: "member" });
			return signIn(t, "third@co.com");
		})();

		const team = (await member.query(api.memory.list)).find((m) => m.scope === "workspace")!;
		expect(team.canEdit).toBe(false);
		expect((await third.query(api.memory.list)).map((m) => m.content)).toEqual(["We close at 5pm."]);
		expect(await owner.query(api.memory.list)).toHaveLength(2);
	});
});

describe("customize", () => {
	it("lets only owners install skills", async () => {
		const { owner, member } = await ownerAndMember();
		await expect(member.mutation(api.skills.setInstalled, { skillId: "meeting-notes", installed: true })).rejects.toThrow(
			"Only owners",
		);
		await owner.mutation(api.skills.setInstalled, { skillId: "meeting-notes", installed: true });
		expect((await member.query(api.skills.list)).find((s) => s.id === "meeting-notes")?.installed).toBe(true);
	});

	it("hides owner-only tools from members", async () => {
		const { owner, member } = await ownerAndMember();
		const tool = async (as: typeof owner) =>
			(await as.query(api.agents.list)).find((a) => a.id === "companybot")!.tools.find((x) => x.id === "memory.remember_for_team");
		expect((await tool(owner))?.visible).toBe(true);
		expect((await tool(member))?.visible).toBe(false);
	});
});

describe("chat", () => {
	it("allows one reply at a time per conversation", async () => {
		const { owner } = await ownerAndMember();
		await owner.mutation(api.chat.send, { agentId: "companybot", text: "hi" });
		await expect(owner.mutation(api.chat.send, { agentId: "companybot", text: "again" })).rejects.toThrow(
			"Still replying",
		);
		// Other agents have their own conversation.
		await owner.mutation(api.chat.send, { agentId: "scribe", text: "hi" });
		const messages = await owner.query(api.chat.messages, { agentId: "companybot" });
		expect(messages.map((m) => [m.role, m.status])).toEqual([
			["user", "done"],
			["assistant", "streaming"],
		]);
	});
});
