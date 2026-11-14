import { expect, it } from "vitest";
import { actionOf, toolApprovalPolicy } from "./agents";
import { permissionFor, toolRisk } from "./action-rules";
import { modelToolName } from "./tools";
import { builtinTools } from "./builtin-tools";

it.each([
	["pages.write", { page: "p1", trash: true }],
	["records.save", { id: "r1", trash: true }],
	["records.save_field", { type: "client", field: "status", trash: true }],
	["records.save_database", { type: "client", trash: true }],
	["records.save_view", { type: "client", id: "v1", version: 1, remove: true }],
	["records.undo", { change: "h1" }],
	["memory.forget", { id: "memory1" }],
] as const)("asks before %s can archive or delete, even with an existing Always rule", async (id, input) => {
	const toolName = modelToolName(id);
	const call = await actionOf(toolName, input, builtinTools);
	expect(call).not.toBeNull();
	expect(toolRisk(call!.tool)).toBe("locked");
	expect(permissionFor({ risk: toolRisk(call!.tool), rule: "always" })).toEqual({ type: "ask", canAlways: false });
	expect(await toolApprovalPolicy(builtinTools)({ toolCall: { toolCallId: "archive", toolName, input } })).toBe("user-approval");
});
