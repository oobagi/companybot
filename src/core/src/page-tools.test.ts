import { describe, expect, it } from "vitest";
import { builtinTools } from "./builtin-tools";
import { PAGE_READ_MAX, type PageStore } from "./page-tools";
import { actionOf, toolApprovalPolicy } from "./agents";
import { permissionFor, toolRisk } from "./action-rules";
import { ctx, member } from "../test/helpers";

describe("pages tools", () => {
	const tool = (id: string) => builtinTools.find((t) => t.id === id)!;
	const page = { id: "p1", title: "SOP", markdown: "x".repeat(PAGE_READ_MAX + 10), versions: [] };
	const c = { ...ctx(member), pages: { read: async () => page } as unknown as PageStore };

	it("hand a long page to the model a part at a time", async () => {
		const first = (await tool("pages.read").execute({ page: "SOP" }, c)) as { markdown: string; more?: boolean; next?: number };
		expect(first).toMatchObject({ more: true, next: PAGE_READ_MAX });
		expect(first.markdown).toHaveLength(PAGE_READ_MAX);
		const rest = (await tool("pages.read").execute({ page: "SOP", start: first.next }, c)) as { markdown: string; more?: boolean };
		expect(rest.markdown).toHaveLength(10);
		expect(rest.more).toBeUndefined();
	});

	it("chunks structured blocks without altering their properties", async () => {
		const blocks = JSON.stringify([{ type: "blockContainer", attrs: { id: "stable" }, content: [{ type: "paragraph", attrs: { textAlignment: "center", textColor: "red" }, content: [{ type: "text", text: "x".repeat(PAGE_READ_MAX) }] }] }]);
		const c = { ...ctx(member), pages: { read: async () => ({ ...page, markdown: "", blocks }) } as unknown as PageStore };
		const first: any = await tool("pages.read").execute({ page: "p1", format: "blocks" }, c);
		const rest: any = await tool("pages.read").execute({ page: "p1", format: "blocks", start: first.next }, c);
		expect(first.blocks + rest.blocks).toBe(blocks);
		expect(rest.more).toBeUndefined();
	});

	// Page writes act as the person, like record writes: rules, Never, owner locks and others' automations all reach them.
	it("treats creating, replacing, moving and restoring pages as acting for the person, and always asks before archiving", async () => {
		const tools = [tool("pages.write")];
		const writes = [{ title: "Guide", parent: "p1" }, { page: "p1", markdown: "New", mode: "replace" }, { action: "move", page: "p1", parent: "p2" }, { page: "p1", trash: false }, { restore: "v1" }];
		for (const input of writes) {
			const call = await actionOf("pages_write", input, tools);
			expect(toolRisk(call!.tool)).toBe("inside");
			expect(permissionFor({ risk: toolRisk(call!.tool) })).toEqual({ type: "run" });
			expect(permissionFor({ risk: toolRisk(call!.tool), foreign: true })).toEqual({ type: "ask", canAlways: true });
			expect(permissionFor({ risk: toolRisk(call!.tool), rule: "never" })).toMatchObject({ type: "deny" });
			// Checked on every call now, so a Never rule or an owner lock stops it.
			expect(await toolApprovalPolicy(tools, async () => ({ type: "deny", by: "rule" }))({ toolCall: { toolCallId: "page", toolName: "pages_write", input } })).toMatchObject({ type: "denied" });
		}
		expect(toolRisk((await actionOf("pages_write", { page: "p1", trash: true }, tools))!.tool)).toBe("locked");
	});

	it("binds what an overwrite or archive depends on, and nothing else", () => {
		const binds = (input: object) => tool("pages.write").binds!(input);
		expect(binds({ page: "p1", trash: true })).toEqual([{ kind: "page", id: "p1" }]);
		expect(binds({ page: "p1", markdown: "x", mode: "replace" })).toEqual([{ kind: "page", id: "p1" }]);
		expect(binds({ record: "r1", markdown: "x", mode: "replace" })).toEqual([{ kind: "recordPage", id: "r1" }]);
		expect(binds({ restore: "v1" })).toEqual([{ kind: "pageVersion", id: "v1" }]);
		for (const input of [{ page: "p1", markdown: "x" }, { page: "p1", title: "New" }, { action: "move", page: "p1", parent: null }, { title: "New" }]) expect(binds(input)).toEqual([]);
	});
});
