import { asSchema } from "ai";
import { describe, expect, it } from "vitest";
import { builtinTools } from "./builtin-tools";
import { actionOf, resolveTools, toolApprovalPolicy } from "./agents";
import { toolRisk } from "./action-rules";
import { platformGuide } from "./guide";
import { manageInputs, manageTools } from "./manage-tools";
import { modelToolName } from "./tools";

describe("grouped tools", () => {
	it("asks for exact invitations and locks irreversible removal tools", async () => {
		for (const id of ["members.invite", "members.remove", "skills.remove", "automations.remove"] as const) {
			const tool = manageTools.find((t) => t.id === id)!;
			expect(toolRisk(tool)).toBe(id === "members.invite" ? "outside" : "locked");
			const input =
				id === "members.invite"
					? { request: { action: "invite", email: "next@co.com" } }
					: id === "members.remove"
						? { request: { action: "remove", email: "dana@co.com" } }
						: { request: { action: "delete", id: "exact-id" } };
			expect(await actionOf(modelToolName(id), input, [tool])).toEqual({ tool, input });
			expect(await toolApprovalPolicy([tool])({ toolCall: { toolCallId: "call", toolName: modelToolName(id), input } })).toBe("user-approval");
		}
	});

	it("refuses authority escalation, unrelated action fields and invalid parameter combinations", () => {
		expect(manageInputs["members.invite"].safeParse({ request: { action: "invite", email: "next@co.com", role: "owner" } }).success).toBe(false);
		expect(manageInputs["channels.manage"].safeParse({ request: { action: "rename", chat: "chat", topic: "missing name" } }).success).toBe(false);
		expect(manageInputs["channels.manage"].safeParse({ request: { action: "remove_member", chat: "chat", userId: "one", agentId: "two" } }).success).toBe(
			false,
		);
		expect(manageInputs["chat.manage"].safeParse({ request: { action: "send", chat: "chat", text: "hi", userIds: Array(51).fill("id") } }).success).toBe(false);
	});

	it("hides owner member tools by role while allowing maker-managed operations", () => {
		const tools = resolveTools({ tools: ["members.*", "channels.*", "skills.manage", "automations.manage"] }, { userId: "member", role: "member" });
		expect(tools.map((t) => t.id).sort()).toEqual(["automations.manage", "channels.manage", "skills.manage"]);
	});

	it("never advertises an unprovided tool, even with a single-tool grant or a role gate", async () => {
		for (const role of ["owner", "member"] as const)
			for (const tool of builtinTools) {
				const agent = { tools: [tool.id] };
				const usable = resolveTools(agent, { userId: "person", role });
				const guide = platformGuide(agent, usable);
				for (const other of builtinTools) {
					if (usable.some((t) => t.id === other.id)) continue;
					expect(guide, `${role}: ${tool.id} advertises ${other.id}`).not.toMatch(new RegExp(`\\b${modelToolName(other.id)}\\b`));
				}
			}
		for (const tool of manageTools) expect((await asSchema(tool.input).jsonSchema).type).toBe("object");
	});
});
