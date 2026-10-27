import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { agentTurn, agentsOf, generalOf, noMentions, settle, setup, signIn } from "./helpers";

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

type T = Awaited<ReturnType<typeof setup>>["t"];
/** A file as the app would upload it. */
const store = (t: T, type = "image/png", bytes = 10) => t.run((ctx) => ctx.storage.store(new Blob([new Uint8Array(bytes)], { type })));
const exists = (t: T, id: Id<"_storage">) => t.run(async (ctx) => !!(await ctx.db.system.get(id)));

describe("pictures", () => {
	it("sets, replaces and removes the workspace logo, deleting old files; only owners", async () => {
		const { t, owner, member } = await setup();
		const first = await store(t);
		await expect(member.mutation(api.images.set, { of: "workspace", file: first })).rejects.toThrow("permission");
		expect(await owner.mutation(api.images.set, { of: "workspace", file: first })).toEqual({});
		const url = (await owner.query(api.workspace.settings))!.image;
		expect(url).toBeTruthy();
		expect((await member.query(api.workspace.me))!.workspaceImage).toBe(url);
		expect((await member.query(api.workspace.mine))!.workspaces[0]!.image).toBe(url);

		const second = await store(t);
		await owner.mutation(api.images.set, { of: "workspace", file: second });
		expect(await exists(t, first)).toBe(false);
		await owner.mutation(api.images.set, { of: "workspace", file: null });
		expect(await exists(t, second)).toBe(false);
		expect((await owner.query(api.workspace.settings))!.image).toBeNull();
	});

	it("deletes a file that isn't a fit picture, and refuses one already in use", async () => {
		const { t, owner, member } = await setup();
		for (const [type, bytes] of [["image/svg+xml", 10], ["text/html", 10], ["image/png", 2 * 1024 * 1024 + 1]] as const) {
			const file = await store(t, type, bytes);
			expect((await member.mutation(api.images.set, { of: "me", file })).error).toMatch(/PNG|2 MB/);
			expect(await exists(t, file)).toBe(false);
		}
		const logo = await store(t);
		await owner.mutation(api.images.set, { of: "workspace", file: logo });
		await expect(member.mutation(api.images.set, { of: "me", file: logo })).rejects.toThrow("already in use");
		expect(await exists(t, logo)).toBe(true);
	});

	it("shows people's photos and agents' pictures wherever they're listed", async () => {
		const { t, owner, member } = await setup();
		const { scribe } = await agentsOf(owner);
		await member.mutation(api.images.set, { of: "me", file: await store(t) });
		await owner.mutation(api.images.set, { of: scribe._id, file: await store(t) });
		const photo = (await member.query(api.preferences.get)).image;
		const picture = (await agentsOf(owner)).scribe.image;
		expect(photo && picture).toBeTruthy();

		expect((await owner.query(api.workspace.team))!.members.find((m) => !m.isYou)!.image).toBe(photo);
		expect((await owner.query(api.chats.list))!.agents.find((a) => a._id === scribe._id)!.image).toBe(picture);
		const general = await generalOf(member);
		expect((await member.query(api.chats.get, { chatId: general._id }))!.members.find((m) => m.type === "user" && m.image)!.image).toBe(photo);
		await member.mutation(api.messages.send, { chatId: general._id, text: "hi", mentions: noMentions });
		expect((await owner.query(api.messages.list, { chatId: general._id }))[0]!.author.image).toBe(photo);
	});

	it("lets owners change agents' pictures, not in Trash; agents can reset them and photos", async () => {
		const { t, owner, member } = await setup();
		const { scribe, companybot } = await agentsOf(owner);
		const file = await store(t);
		await expect(member.mutation(api.images.set, { of: scribe._id, file })).rejects.toThrow("permission");
		await owner.mutation(api.images.set, { of: scribe._id, file });

		const dm = await owner.mutation(api.chats.openDm, { userIds: [], agentIds: [companybot._id] });
		const turnId = await agentTurn(t, owner, dm, companybot._id);
		const call = (request: unknown, tool: "agents.manage" | "workspace.settings" = "agents.manage") =>
			t.mutation(internal.manageTools.runFor, { turnId, tool, input: { request } });
		await call({ action: "remove_image", id: scribe._id });
		expect(await exists(t, file)).toBe(false);
		const photo = await store(t);
		await owner.mutation(api.images.set, { of: "me", file: photo });
		await call({ action: "remove_image", of: "me" }, "workspace.settings");
		expect(await exists(t, photo)).toBe(false);

		await owner.mutation(api.trash.move, { kind: "agent", id: scribe._id });
		await expect(owner.mutation(api.images.set, { of: scribe._id, file: await store(t) })).rejects.toThrow("in Trash");
	});

	it("keeps an agent's picture in Trash and deletes it with the agent", async () => {
		const { t, owner } = await setup();
		const { scribe } = await agentsOf(owner);
		const file = await store(t);
		await owner.mutation(api.images.set, { of: scribe._id, file });
		await owner.mutation(api.trash.move, { kind: "agent", id: scribe._id });
		expect(await exists(t, file)).toBe(true);
		await owner.mutation(api.trash.purge, { id: scribe._id });
		await settle(t);
		expect(await exists(t, file)).toBe(false);
	});

	it("deletes the logo and agents' pictures with the workspace, and a photo with its account", async () => {
		const { t, owner, member } = await setup();
		const { scribe } = await agentsOf(owner);
		const [logo, picture, photo] = [await store(t), await store(t), await store(t)];
		await owner.mutation(api.images.set, { of: "workspace", file: logo });
		await owner.mutation(api.images.set, { of: scribe._id, file: picture });
		await member.mutation(api.images.set, { of: "me", file: photo });
		await member.mutation(api.workspace.eraseAccount);
		await settle(t);
		expect(await exists(t, photo)).toBe(false);
		expect(await exists(t, logo)).toBe(true);
		await owner.mutation(api.workspace.deleteWorkspace, { name: "My company" });
		await settle(t);
		expect(await exists(t, logo)).toBe(false);
		expect(await exists(t, picture)).toBe(false);
	});
});

it("refuses cross-workspace targets and member agent resets", async () => {
	const { t, owner, member } = await setup();
	const { scribe, companybot } = await agentsOf(owner);
	const outsider = await signIn(t, "outsider@elsewhere.com");
	const file = await store(t);
	await owner.mutation(api.images.set, { of: scribe._id, file });
	await expect(outsider.mutation(api.images.set, { of: scribe._id, file: null })).rejects.toThrow("not found");
	const dm = await member.mutation(api.chats.openDm, { userIds: [], agentIds: [companybot._id] });
	const turnId = await agentTurn(t, member, dm, companybot._id);
	expect(await t.mutation(internal.manageTools.runFor, { turnId, tool: "agents.manage", input: { request: { action: "remove_image", id: scribe._id } } })).toMatchObject({ error: expect.stringMatching(/permission/) });
	expect(await exists(t, file)).toBe(true);
});

it("resolves each picture URL once across chat and message lists", async () => {
	const { t, owner } = await setup();
	const { companybot } = await agentsOf(owner);
	const file = await store(t);
	await owner.mutation(api.images.set, { of: companybot._id, file });
	await owner.mutation(api.chats.openDm, { userIds: [], agentIds: [companybot._id] });
	// convex-test exposes the active test runtime through a getter. Count real storage calls.
	const convex = (globalThis as unknown as { Convex: { readonly asyncSyscall: unknown } }).Convex;
	const getter = Object.getOwnPropertyDescriptor(convex, "asyncSyscall")!.get!;
	const calls = vi.fn<(op: string, args: string) => void>();
	vi.spyOn(convex, "asyncSyscall", "get").mockImplementation(() => {
		const syscall = getter.call(convex);
		return (op: string, args: string) => {
			calls(op, args);
			return syscall(op, args);
		};
	});
	await owner.query(api.chats.list);
	const resolutions = calls.mock.calls.filter(([op, args]) => op === "1.0/storageGetUrl" && JSON.parse(args).storageId === file).length;
	expect(resolutions).toBe(1);
	calls.mockClear();
	const general = await generalOf(owner);
	await owner.mutation(api.images.set, { of: "me", file: await store(t) });
	for (let i = 0; i < 20; i++) await owner.mutation(api.messages.send, { chatId: general._id, text: "hi", mentions: noMentions });
	calls.mockClear();
	await owner.query(api.messages.list, { chatId: general._id });
	expect(calls.mock.calls.filter(([op]) => op === "1.0/storageGetUrl")).toHaveLength(1);
});
