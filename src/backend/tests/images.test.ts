import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { UPLOAD_TTL_MS } from "../convex/images";
import { type As, agentTurn, agentsOf, generalOf, noMentions, settle, setup, signIn, workspaceOf } from "./helpers";

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

type T = Awaited<ReturnType<typeof setup>>["t"];
const png = (size = 16) => Object.assign(new Uint8Array(size), { 0: 0x89, 1: 0x50, 2: 0x4e, 3: 0x47, 4: 0x0d, 5: 0x0a, 6: 0x1a, 7: 0x0a });
/** POSTs bytes to the upload endpoint as `as`, as the app does. */
const post = (as: As, body: Uint8Array<ArrayBuffer>, type: string, workspaceId?: Id<"workspaces">) =>
	as.fetch(`/images/upload${workspaceId ? `?workspaceId=${workspaceId}` : ""}`, { method: "POST", headers: { "Content-Type": type }, body });
/** Uploads a picture as `as`, in their workspace, and returns its storage id. */
const upload = async (as: As) => {
	const response = await post(as, png(), "image/png", await workspaceOf(as));
	expect(response.status).toBe(200);
	return ((await response.json()) as { storageId: Id<"_storage"> }).storageId;
};
const exists = (t: T, id: Id<"_storage">) => t.run(async (ctx) => !!(await ctx.db.system.get(id)));
const files = (t: T) => t.run(async (ctx) => (await ctx.db.system.query("_storage").collect()).length);

describe("pictures", () => {
	it("sets, replaces and removes the workspace logo, deleting old files; only owners", async () => {
		const { t, owner, member } = await setup();
		const first = await upload(owner);
		await expect(member.mutation(api.images.set, { of: "workspace", file: first })).rejects.toThrow("permission");
		await owner.mutation(api.images.set, { of: "workspace", file: first });
		const url = (await owner.query(api.workspace.settings))!.image;
		expect(url).toBeTruthy();
		expect((await member.query(api.workspace.me))!.workspaceImage).toBe(url);
		expect((await member.query(api.workspace.mine))!.workspaces[0]!.image).toBe(url);

		const second = await upload(owner);
		await owner.mutation(api.images.set, { of: "workspace", file: second });
		expect(await exists(t, first)).toBe(false);
		await owner.mutation(api.images.set, { of: "workspace", file: null });
		expect(await exists(t, second)).toBe(false);
		expect((await owner.query(api.workspace.settings))!.image).toBeNull();
	});

	it("takes only real pictures, by their bytes, from someone signed in and in the workspace", async () => {
		const { t, owner, member } = await setup();
		const workspaceId = await workspaceOf(owner);
		const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
		const before = await files(t);
		// Labeled a PNG, but its bytes are SVG: refused whatever the header says.
		expect((await post(owner, svg, "image/png", workspaceId)).status).toBe(415);
		expect((await post(owner, new TextEncoder().encode("<html></html>"), "image/gif", workspaceId)).status).toBe(415);
		expect((await post(owner, png(2 * 1024 * 1024 + 1), "image/png", workspaceId)).status).toBe(413);
		expect((await t.fetch("/images/upload", { method: "POST", body: png() })).status).toBe(401);
		const outsider = await signIn(t, "outsider@elsewhere.com");
		expect((await post(outsider, png(), "image/png", workspaceId)).status).toBe(403);
		expect(await files(t)).toBe(before);
		// Stored with the type its bytes say; the app's origin gets a CORS preflight.
		const id = await upload(member);
		expect((await t.run((ctx) => ctx.db.system.get(id)))!.contentType).toBe("image/png");
		expect((await t.fetch("/images/upload", { method: "OPTIONS" })).headers.get("Access-Control-Allow-Headers")).toContain("Authorization");
	});

	it("attaches only the caller's own unclaimed upload", async () => {
		const { t, owner, member } = await setup();
		const theirs = await upload(owner);
		// Someone else who learns the id can't take it, or block its uploader.
		await expect(member.mutation(api.images.set, { of: "me", file: theirs })).rejects.toThrow("isn't available");
		await owner.mutation(api.images.set, { of: "workspace", file: theirs });
		// Used up: it can't be attached again, by anyone.
		await expect(owner.mutation(api.images.set, { of: "me", file: theirs })).rejects.toThrow("isn't available");
		// A file stored any other way was never an upload.
		const raw = await t.run((ctx) => ctx.storage.store(new Blob([png()], { type: "image/png" })));
		await expect(owner.mutation(api.images.set, { of: "me", file: raw })).rejects.toThrow("isn't available");
		expect(await exists(t, theirs)).toBe(true);
	});

	it.each([undefined, "1"])("stops reading an oversized stream with Content-Length %s", async (length) => {
		const { t, owner } = await setup();
		let reads = 0;
		const cancel = vi.fn();
		const body = new ReadableStream({
			pull(controller) {
				reads++;
				if (reads <= 8) controller.enqueue(png(1024 * 1024));
				else controller.close();
			},
			cancel,
		});
		const response = await owner.fetch("/images/upload", {
			method: "POST",
			headers: length ? { "Content-Length": length } : {},
			body,
			duplex: "half",
		} as RequestInit & { duplex: "half" });
		expect(response.status).toBe(413);
		expect(cancel).toHaveBeenCalledOnce();
		expect(reads).toBeLessThan(8);
		expect(await files(t)).toBe(0);
	});

	it("accepts the exact limit and signatures split across chunks, using the sniffed type", async () => {
		const { t, owner } = await setup();
		const bytes = png(2 * 1024 * 1024);
		const response = await owner.fetch("/images/upload", {
			method: "POST",
			headers: { "Content-Type": "text/html" },
			body: new ReadableStream({
				start(controller) {
					controller.enqueue(bytes.subarray(0, 2));
					controller.enqueue(bytes.subarray(2));
					controller.close();
				},
			}),
			duplex: "half",
		} as RequestInit & { duplex: "half" });
		expect(response.status).toBe(200);
		const { storageId } = await response.json() as { storageId: Id<"_storage"> };
		expect(await t.run((ctx) => ctx.db.system.get(storageId))).toMatchObject({ contentType: "image/png", size: bytes.length });
	});

	it("enforces the per-user cap across simultaneous uploads and frees a slot on claim", async () => {
		const { t, owner, member } = await setup();
		const workspaceId = await workspaceOf(owner);
		// Race the cap mutations. convex-test's action storage writes share whichever test
		// transaction is active, so store first rather than racing that fake storage layer.
		const stored = await t.run(async (ctx) => {
			const ids: Id<"_storage">[] = [];
			for (let i = 0; i < 24; i++) ids.push(await ctx.storage.store(new Blob([png()])));
			return ids;
		});
		const as = t.withIdentity({ subject: `${owner.userId}|session` });
		const results = await Promise.allSettled(stored.map((storageId) => as.mutation(internal.images.saveUpload, { storageId, workspaceId })));
		expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(20);
		expect(results.filter((r) => r.status === "rejected")).toHaveLength(4);
		await t.run(async (ctx) => {
			for (const [i, result] of results.entries()) if (result.status === "rejected") await ctx.storage.delete(stored[i]!);
		});
		// The HTTP path deletes its file when the cap refuses it.
		expect((await post(owner, png(), "image/png", workspaceId)).status).toBe(403);
		expect(await files(t)).toBe(20);
		await owner.mutation(api.images.set, { of: "me", file: stored[results.findIndex((r) => r.status === "fulfilled")]! });
		await upload(owner);
		await upload(member);
		expect(await t.run((ctx) => ctx.db.query("uploads").collect())).toHaveLength(21);
	});

	it("lets only one of two simultaneous targets claim an upload", async () => {
		const { t, owner } = await setup();
		const file = await upload(owner);
		const results = await Promise.allSettled([
			owner.mutation(api.images.set, { of: "workspace", file }),
			owner.mutation(api.images.set, { of: "me", file }),
		]);
		expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
		expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
		expect(await exists(t, file)).toBe(true);
		expect(await t.run((ctx) => ctx.db.query("uploads").collect())).toHaveLength(0);
	});

	it("keeps attachment and sweeping atomic when both try to consume a stale upload", async () => {
		const { t, owner } = await setup();
		const file = await upload(owner);
		await t.run(async (ctx) => {
			const row = await ctx.db.query("uploads").first();
			await ctx.db.patch(row!._id, { createdAt: Date.now() - UPLOAD_TTL_MS - 1 });
		});
		const [attached, swept] = await Promise.allSettled([
			owner.mutation(api.images.set, { of: "me", file }),
			t.mutation(internal.images.sweepUploads),
		]);
		expect(swept.status).toBe("fulfilled");
		expect(await exists(t, file)).toBe(attached.status === "fulfilled");
		expect(!!(await owner.query(api.preferences.get)).image).toBe(attached.status === "fulfilled");
		expect(await t.run((ctx) => ctx.db.query("uploads").collect())).toHaveLength(0);
	});

	it("sweeps 100 rows at a time and schedules the remainder", async () => {
		const { t, owner } = await setup();
		vi.useFakeTimers();
		const userId = (await owner.query(api.workspace.me))!.userId;
		await t.run(async (ctx) => {
			for (let i = 0; i < 105; i++) {
				const storageId = await ctx.storage.store(new Blob([png()]));
				await ctx.db.insert("uploads", { storageId, userId, createdAt: Date.now() - UPLOAD_TTL_MS - 1 });
			}
		});
		await t.mutation(internal.images.sweepUploads);
		expect(await files(t)).toBe(5);
		await settle(t);
		expect(await files(t)).toBe(0);
		expect(await t.run((ctx) => ctx.db.query("uploads").collect())).toHaveLength(0);
	});

	it("deletes uploads nobody attached within a day", async () => {
		const { t, owner } = await setup();
		vi.useFakeTimers();
		const stale = await upload(owner);
		const attached = await upload(owner);
		await owner.mutation(api.images.set, { of: "me", file: attached });
		vi.setSystemTime(Date.now() + UPLOAD_TTL_MS + 1);
		const fresh = await upload(owner);
		await t.mutation(internal.images.sweepUploads);
		expect(await exists(t, stale)).toBe(false);
		expect(await exists(t, attached)).toBe(true);
		expect((await t.run((ctx) => ctx.db.query("uploads").collect())).map((u) => u.storageId)).toEqual([fresh]);
		await owner.mutation(api.images.set, { of: "workspace", file: fresh });
	});

	it("shows people's photos and agents' pictures wherever they're listed", async () => {
		const { owner, member } = await setup();
		const { scribe } = await agentsOf(owner);
		await member.mutation(api.images.set, { of: "me", file: await upload(member) });
		await owner.mutation(api.images.set, { of: scribe._id, file: await upload(owner) });
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
		const file = await upload(owner);
		await expect(member.mutation(api.images.set, { of: scribe._id, file })).rejects.toThrow("permission");
		await owner.mutation(api.images.set, { of: scribe._id, file });

		const dm = await owner.mutation(api.chats.openDm, { userIds: [], agentIds: [companybot._id] });
		const turnId = await agentTurn(t, owner, dm, companybot._id);
		const call = (request: unknown, tool: "agents.manage" | "workspace.settings" = "agents.manage") =>
			t.mutation(internal.manageTools.runFor, { turnId, tool, input: { request } });
		await call({ action: "remove_image", id: scribe._id });
		expect(await exists(t, file)).toBe(false);
		const photo = await upload(owner);
		await owner.mutation(api.images.set, { of: "me", file: photo });
		await call({ action: "remove_image", of: "me" }, "workspace.settings");
		expect(await exists(t, photo)).toBe(false);

		await owner.mutation(api.trash.move, { kind: "agent", id: scribe._id });
		await expect(owner.mutation(api.images.set, { of: scribe._id, file: await upload(owner) })).rejects.toThrow("in Trash");
	});

	it("keeps an agent's picture in Trash and deletes it with the agent", async () => {
		const { t, owner } = await setup();
		const { scribe } = await agentsOf(owner);
		const file = await upload(owner);
		await owner.mutation(api.images.set, { of: scribe._id, file });
		await owner.mutation(api.trash.move, { kind: "agent", id: scribe._id });
		expect(await exists(t, file)).toBe(true);
		await owner.mutation(api.trash.purge, { id: scribe._id });
		await settle(t);
		expect(await exists(t, file)).toBe(false);
	});

	it("puts pictures in pages anyone who can edit them can change, kept through Trash, deleted with the page", async () => {
		const { t, owner, member } = await setup();
		vi.useFakeTimers();
		const pageId = await member.mutation(api.pages.create, { title: "Wiki" });
		const file = await upload(member);
		await expect(owner.mutation(api.pages.addImage, { pageId, file })).rejects.toThrow("isn't available");
		expect(await member.mutation(api.pages.addImage, { pageId, file })).toBe(await t.run((ctx) => ctx.storage.getUrl(file)));
		// Claimed: the sweep leaves it, and a page in Trash keeps it.
		vi.setSystemTime(Date.now() + UPLOAD_TTL_MS + 1);
		await t.mutation(internal.images.sweepUploads);
		await member.mutation(api.trash.move, { kind: "page", id: pageId });
		await expect(member.mutation(api.pages.addImage, { pageId, file: await upload(member) })).rejects.toThrow("in Trash");
		await member.mutation(api.trash.restore, { kind: "page", id: pageId });
		expect(await exists(t, file)).toBe(true);
		await member.mutation(api.trash.move, { kind: "page", id: pageId });
		await owner.mutation(api.trash.purge, { id: pageId });
		await settle(t);
		expect(await exists(t, file)).toBe(false);
	});

	it("deletes pictures and unclaimed uploads with the workspace, and a photo with its account", async () => {
		const { t, owner, member } = await setup();
		const workspaceId = await workspaceOf(owner);
		const { scribe } = await agentsOf(owner);
		const [logo, picture, photo, pending, memberPending] = [await upload(owner), await upload(owner), await upload(member), await upload(owner), await upload(member)];
		await owner.mutation(api.images.set, { of: "workspace", file: logo });
		await owner.mutation(api.images.set, { of: scribe._id, file: picture });
		await member.mutation(api.images.set, { of: "me", file: photo });
		await member.mutation(api.workspace.eraseAccount);
		await settle(t);
		expect(await exists(t, photo)).toBe(false);
		expect(await exists(t, memberPending)).toBe(false);
		expect((await post(member, png(), "image/png")).status).toBe(403);
		expect(await files(t)).toBe(3);
		expect(await exists(t, logo)).toBe(true);
		await owner.mutation(api.workspace.deleteWorkspace, { name: "My company" });
		expect((await post(owner, png(), "image/png", workspaceId)).status).toBe(403);
		await settle(t);
		for (const file of [logo, picture, pending]) expect(await exists(t, file)).toBe(false);
	});
});

it("refuses cross-workspace targets and member agent resets", async () => {
	const { t, owner, member } = await setup();
	const { scribe, companybot } = await agentsOf(owner);
	const outsider = await signIn(t, "outsider@elsewhere.com");
	const file = await upload(owner);
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
	const file = await upload(owner);
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
	await owner.mutation(api.images.set, { of: "me", file: await upload(owner) });
	for (let i = 0; i < 20; i++) await owner.mutation(api.messages.send, { chatId: general._id, text: "hi", mentions: noMentions });
	calls.mockClear();
	await owner.query(api.messages.list, { chatId: general._id });
	expect(calls.mock.calls.filter(([op]) => op === "1.0/storageGetUrl")).toHaveLength(1);
});
