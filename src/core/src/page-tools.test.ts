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

	it("keeps moves inside workspace consent and requires exact consent for subtree deletion", async () => {
		const tools = [tool("pages.write")];
		const input = { action: "move", page: "p1", parent: "p2" };
		const move = await actionOf("pages_write", input, tools);
		expect(toolRisk(move!.tool)).toBe("inside");
		expect(permissionFor({ risk: toolRisk(move!.tool), foreign: true })).toEqual({ type: "ask", canAlways: true });
		expect(await toolApprovalPolicy(tools)({ toolCall: { toolCallId: "move", toolName: "pages_write", input } })).toBeUndefined();
		expect(await toolApprovalPolicy(tools)({ toolCall: { toolCallId: "delete", toolName: "pages_write", input: { page: "p1", trash: true } } })).toBe("user-approval");
	});

	it("say what each write did", () => {
		const label = (input: object, output: object) => tool("pages.write").label!(input, output);
		expect(label({ action: "move", page: "p1", parent: "p2" }, { title: "SOP" })).toBe("Move page SOP");
		expect(label({ title: "SOP" }, { title: "SOP" })).toBe("Create page SOP");
		expect(label({ page: "p1", markdown: "hi" }, { title: "SOP" })).toBe("Write page SOP");
		expect(label({ record: "r1", markdown: "hi" }, { title: "Acme" })).toBe("Write page Acme");
		expect(label({ page: "p1", trash: true }, { title: "SOP" })).toBe("Delete page SOP");
		expect(label({ restore: "v1" }, { title: "SOP" })).toBe("Restore a version of SOP");
		expect(label({ page: "p1", markdown: "hi" }, { error: "nope" })).toBeUndefined();
	});
});
