import { asSchema } from "ai";
import { describe, expect, it } from "vitest";
import { builtinTools } from "./builtin-tools";
import { actionOf, resolveTools, toolApprovalPolicy } from "./agents";
import { toolRisk } from "./action-rules";
import { platformGuide } from "./guide";
import { manageInputs, manageTools } from "./manage-tools";
import { modelToolName } from "./tools";

describe("grouped tools", () => {
	it("asks for exact invitations and skill edits, and locks irreversible removal tools", async () => {
		for (const id of ["members.invite", "skills.edit", "members.remove", "skills.remove", "automations.remove"] as const) {
			const tool = manageTools.find((t) => t.id === id)!;
			expect(toolRisk(tool)).toBe(id === "members.invite" || id === "skills.edit" ? "outside" : "locked");
			const input =
				id === "members.invite"
					? { request: { action: "invite", email: "next@co.com" } }
					: id === "members.remove"
						? { request: { action: "remove", email: "dana@co.com" } }
						: id === "skills.edit"
							? { request: { action: "edit", id: "custom-1", expectedVersion: 1, config: { name: "Tone", description: "d", instructions: "i" } } }
							: { request: { action: "delete", id: "exact-id" } };
			expect(await actionOf(modelToolName(id), input, [tool])).toEqual({ tool, input });
			expect(await toolApprovalPolicy([tool])({ toolCall: { toolCallId: "call", toolName: modelToolName(id), input } })).toBe("user-approval");
		}
	});

	it("locks message deletion without applying an Always for other chat actions", async () => {
		const tool = manageTools.find((t) => t.id === "chat.manage")!;
		const request = { action: "delete", messageId: "exact-message" };
		const action = await actionOf("chat_manage", { request }, [tool]);
		expect(toolRisk(action!.tool)).toBe("locked");
		expect(await toolApprovalPolicy([tool])({ toolCall: { toolCallId: "delete", toolName: "chat_manage", input: { request } } })).toBe("user-approval");
		for (const request of [{ action: "edit", messageId: "m", text: "fixed" }, { action: "react", messageId: "m", emoji: "✅" }, { action: "mark_read", chat: "c" }])
			expect(await toolApprovalPolicy([tool])({ toolCall: { toolCallId: "safe", toolName: "chat_manage", input: { request } } })).toBeUndefined();
	});

	it("locks agent archiving and instruction/model rewrites, not metadata edits", async () => {
		const tool = manageTools.find((t) => t.id === "agents.manage")!;
		const ask = (request: object) => toolApprovalPolicy([tool])({ toolCall: { toolCallId: "a", toolName: "agents_manage", input: { request } } });
		for (const request of [{ action: "archive", id: "a" }, { action: "update", id: "a", expectedVersion: 1, instructions: "x" }, { action: "update", id: "a", expectedVersion: 1, model: "m" }])
			expect(await ask(request)).toBe("user-approval");
		for (const request of [{ action: "update", id: "a", expectedVersion: 1, name: "n" }, { action: "create" }, { action: "list" }])
			expect(await ask(request)).toBeUndefined();
	});

	it("keeps grants, self-reactivation and device measurements out of management schemas", () => {
		for (const request of [{ action: "update", id: "a", expectedVersion: 1, tools: ["*"] }, { action: "restore", id: "a" }, { action: "create", tools: ["chat.*"] }])
			expect(manageInputs["agents.manage"].safeParse({ request }).success).toBe(false);
		expect(manageInputs["workspace.settings"].safeParse({ request: { action: "update_preferences", deviceTimeZone: "UTC" } }).success).toBe(false);
	});

	it("asks for exact channel deletion without prompting for channel reads or edits", async () => {
		const tool = manageTools.find((t) => t.id === "channels.manage")!;
		const input = { request: { action: "delete", chat: "exact-channel" } };
		const action = await actionOf("channels_manage", input, [tool]);
		expect(toolRisk(action!.tool)).toBe("locked");
		expect(action!.input).toEqual(input);
		expect(await toolApprovalPolicy([tool])({ toolCall: { toolCallId: "delete", toolName: "channels_manage", input } })).toBe("user-approval");
		for (const request of [{ action: "get", chat: "exact-channel" }, { action: "rename", chat: "exact-channel", name: "renamed" }])
			expect(await toolApprovalPolicy([tool])({ toolCall: { toolCallId: "safe", toolName: "channels_manage", input: { request } } })).toBeUndefined();
	});

	it("names who a call is about, so the card says it", () => {
		const label = (id: string, request: object) => manageTools.find((t) => t.id === id)!.label!({ request });
		expect(label("members.remove", { action: "remove", email: "ben@acme.com" })).toBe("Remove ben@acme.com from the workspace");
		expect(label("members.invite", { action: "invite", email: "ben@acme.com" })).toBe("Invite ben@acme.com to the workspace");
		expect(label("members.invite", { action: "resend", email: "ben@acme.com" })).toBe("Resend the invitation to ben@acme.com");
		expect(label("members.invite", { action: "cancel", email: "ben@acme.com" })).toBe("Cancel the invitation for ben@acme.com");
		expect(label("chat.manage", { action: "send", chat: "general", text: "hi" })).toBe("Post in #general");
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
