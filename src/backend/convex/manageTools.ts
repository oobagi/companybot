import { canEditMade, DEFAULT_CURRENCY, isGranted, manageInputs, skillCatalog } from "@companybot/core";
import { ConvexError, v } from "convex/values";
import type { Id, TableNames } from "./_generated/dataModel";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { addChannelMembers, createChannelAs, joinChannel, leaveChannel, openDirectMessage, removeChannelMember, updateChannelAs } from "./chats";
import { chatByRef, namer, requireChat } from "./chatOps";
import { canView, definitionOf, installOf } from "./automationOps";
import { removeAutomation, saveAutomation, updateAutomation } from "./automations";
import { installSkill, removeSkill, saveSkill } from "./skills";
import { sendMessage } from "./messages";
import { cancelMemberInvite, inviteIn, inviteMember, removeWorkspaceMember, resendMemberInvite, updateWorkspaceSettings } from "./workspace";
import { asToolResult, checkPermission, type Member, nameOf, normalizeEmail, timeZoneOf } from "./lib";
import { automationOfTurn } from "./permissions";
import { runningTurn } from "./turns";

const paging = (cursor?: string) => ({ cursor: cursor ?? null, numItems: 30 });
function rowId<T extends TableNames>(ctx: MutationCtx, table: T, raw: string): Id<T> {
	const id = ctx.db.normalizeId(table, raw);
	if (!id) throw new ConvexError("Invalid id.");
	return id;
}
async function chatId(ctx: MutationCtx, member: Member, ref: string) {
	const chat = await chatByRef(ctx, member, ref);
	if (!chat) throw new ConvexError("Chat not found.");
	return chat._id;
}
const participants = (ctx: MutationCtx, r: { userIds?: string[]; agentIds?: string[] }) => ({
	userIds: (r.userIds ?? []).map((i) => rowId(ctx, "users", i)),
	agentIds: (r.agentIds ?? []).map((i) => rowId(ctx, "agents", i)),
});

export const runFor = internalMutation({
	args: { turnId: v.id("agentTurns"), tool: v.string(), input: v.any() },
	handler: async (ctx, { turnId, tool, input }): Promise<unknown> => {
		const { who, turn } = await runningTurn(ctx, turnId);
		const { member } = who;
		const agent = await ctx.db.get(turn.agentId);
		if (!agent || agent.archived || !isGranted(agent.tools, tool)) throw new ConvexError("This agent no longer has that tool.");
		return asToolResult(async () => {
			if (!(tool in manageInputs)) throw new ConvexError("Unknown tool.");
			// A run acts with this person's rights but follows its prompt: only the prompt's author can have it manage the workspace.
			const automation = await automationOfTurn(ctx, turn);
			if (automation?.custom && automation.custom.updatedBy !== member.userId)
				throw new ConvexError(`${await nameOf(ctx, automation.custom.updatedBy)} last edited this automation, so it can't manage the workspace for you.`);
			switch (tool) {
				case "chat.manage": {
					const r = manageInputs[tool].parse(input).request;
					if (r.action === "find_people") {
						if (r.kind === "invites") {
							checkPermission(member, "members.manage");
							const result = await ctx.db
								.query("invites")
								.withIndex("by_workspace", (q) => q.eq("workspaceId", member.workspaceId))
								.paginate(paging(r.cursor));
							return { ...result, page: result.page.map((i) => ({ id: i._id, email: i.email, role: i.role })) };
						}
						if (r.kind === "agents") {
							const result = await ctx.db
								.query("agents")
								.withIndex("by_workspace", (q) => q.eq("workspaceId", member.workspaceId))
								.paginate(paging(r.cursor));
							return { ...result, page: result.page.filter((a) => !a.archived).map((a) => ({ id: a._id, name: a.name, description: a.description })) };
						}
						const result = await ctx.db
							.query("members")
							.withIndex("by_workspace", (q) => q.eq("workspaceId", member.workspaceId))
							.paginate(paging(r.cursor));
						return {
							...result,
							page: await Promise.all(
								result.page.map(async (m) => ({
									userId: m.userId,
									name: await nameOf(ctx, m.userId),
									email: (await ctx.db.get(m.userId))?.email,
									role: m.role,
									timeZone: await timeZoneOf(ctx, m.userId),
								})),
							),
						};
					}
					if (r.action === "list_chats") {
						const result = await ctx.db
							.query("chatMembers")
							.withIndex("by_workspace", (q) => q.eq("workspaceId", member.workspaceId).eq("userId", member.userId))
							.paginate(paging(r.cursor));
						return {
							...result,
							page: (await Promise.all(result.page.map((m) => ctx.db.get(m.chatId))))
								.filter((c) => c && !c.archived)
								.map((c) => ({ id: c!._id, name: c!.name, kind: c!.kind, private: c!.private })),
						};
					}
					if (r.action === "open_dm")
						return {
							chatId: await openDirectMessage(ctx, member, participants(ctx, r)),
						};
					return {
						messageId: await sendMessage(ctx, who, {
							chatId: await chatId(ctx, member, r.chat),
							threadId: r.threadId ? rowId(ctx, "chatMessages", r.threadId) : undefined,
							text: r.text,
							mentions: participants(ctx, r),
						}),
					};
				}
				case "channels.manage": {
					const r = manageInputs[tool].parse(input).request;
					if (r.action === "list") {
						const result = await ctx.db
							.query("chats")
							.withIndex("by_workspace", (q) => q.eq("workspaceId", member.workspaceId).eq("kind", "channel"))
							.paginate(paging(r.cursor));
						return { ...result, page: result.page.filter((c) => !c.private && !c.archived).map((c) => ({ id: c._id, name: c.name, topic: c.topic })) };
					}
					if (r.action === "create") return { chatId: await createChannelAs(ctx, member, r) };
					const id = await chatId(ctx, member, r.chat);
					if (r.action === "get") {
						const chat = await requireChat(ctx, member, id);
						const result = await ctx.db
							.query("chatMembers")
							.withIndex("by_chat", (q) => q.eq("chatId", id))
							.paginate(paging(r.cursor));
						return {
							id,
							name: chat.name,
							topic: chat.topic,
							private: chat.private,
							isDefault: chat.isDefault,
							...result,
							page: await Promise.all(result.page.map((m) => namer(ctx).of(m))),
						};
					}
					if (r.action === "rename") await updateChannelAs(ctx, member, { chatId: id, name: r.name });
					if (r.action === "set_topic") await updateChannelAs(ctx, member, { chatId: id, topic: r.topic });
					if (r.action === "join") await joinChannel(ctx, member, { chatId: id });
					if (r.action === "leave") await leaveChannel(ctx, member, { chatId: id });
					if (r.action === "add_members")
						await addChannelMembers(ctx, member, { chatId: id, ...participants(ctx, r) });
					if (r.action === "remove_member")
						await removeChannelMember(ctx, member, {
							chatId: id,
							userId: r.userId ? rowId(ctx, "users", r.userId) : undefined,
							agentId: r.agentId ? rowId(ctx, "agents", r.agentId) : undefined,
						});
					return { done: r.action, chatId: id };
				}
				case "automations.manage": {
					const r = manageInputs[tool].parse(input).request;
					if (r.action === "list") {
						const result = await ctx.db
							.query("automationInstalls")
							.withIndex("by_workspace", (q) => q.eq("workspaceId", member.workspaceId))
							.paginate(paging(r.cursor));
						return {
							...result,
							page: result.page
								.filter((i) => canView(member, i))
								.map((i) => ({ id: i.automationId, name: i.custom?.name, enabled: i.enabled, agentId: i.agentId, version: i.custom?.version })),
						};
					}
					const install = await installOf(ctx, member.workspaceId, r.id);
					if (!install || !canView(member, install)) throw new ConvexError("Automation not found.");
					if (r.action === "get")
						return {
							id: r.id,
							definition: await definitionOf(ctx, install),
							config: install.custom,
							enabled: install.enabled,
							agentId: install.agentId,
							audience: install.audience,
							channelId: install.channelId,
							timeZone: install.timeZone,
							lastRunAt: install.lastRunAt,
							lastResult: install.lastResult,
						};
					if (r.action === "edit") await saveAutomation(ctx, member, { automationId: r.id, config: r.config, expectedVersion: r.expectedVersion });
					if (r.action === "pause" || r.action === "resume") await updateAutomation(ctx, member, { automationId: r.id, enabled: r.action === "resume" });
					if (r.action === "set_agent") await updateAutomation(ctx, member, { automationId: r.id, agentId: rowId(ctx, "agents", r.agentId) });
					if (r.action === "set_audience")
						await updateAutomation(ctx, member, {
							automationId: r.id,
							audience: r.audience,
							channelId: r.channelId ? rowId(ctx, "chats", r.channelId) : undefined,
						});
					return { done: r.action, id: r.id };
				}
				case "automations.remove": {
					const r = manageInputs[tool].parse(input).request;
					await removeAutomation(ctx, member, r.id);
					return { deleted: r.id };
				}
				case "skills.manage": {
					const r = manageInputs[tool].parse(input).request;
					if (r.action === "list") {
						const result = await ctx.db
							.query("skillInstalls")
							.withIndex("by_workspace", (q) => q.eq("workspaceId", member.workspaceId))
							.paginate(paging(r.cursor));
						return {
							...result,
							page: result.page.map((i) => ({ id: i.skillId, name: i.custom?.name, version: i.custom?.version })),
							library: skillCatalog.map((s) => ({ id: s.id, name: s.name, description: s.description })),
						};
					}
					const install = await ctx.db
						.query("skillInstalls")
						.withIndex("by_workspace", (q) => q.eq("workspaceId", member.workspaceId).eq("skillId", r.id))
						.first();
					if (r.action === "get") {
						const skill = install?.custom ?? skillCatalog.find((s) => s.id === r.id);
						if (!skill) throw new ConvexError("Skill not found.");
						return { ...skill, id: r.id, installed: !!install, canEdit: canEditMade(member, "skills.manage", install?.custom?.createdBy) };
					}
					if (r.action === "edit") await saveSkill(ctx, member, { skillId: r.id, config: r.config, expectedVersion: r.expectedVersion });
					if (r.action === "install") await installSkill(ctx, member, { skillId: r.id, installed: true });
					return { done: r.action, id: r.id };
				}
				case "skills.remove": {
					const r = manageInputs[tool].parse(input).request;
					await removeSkill(ctx, member, r.id);
					return { deleted: r.id };
				}
				case "members.invite": {
					const r = manageInputs[tool].parse(input).request;
					if (r.action === "invite") return inviteMember(ctx, member, { email: r.email, role: "member" });
					const invite = await inviteIn(ctx, member.workspaceId, normalizeEmail(r.email));
					if (!invite) throw new ConvexError("No invitation for that email.");
					if (r.action === "resend") {
						if (invite.role !== "member") throw new ConvexError("Owner invitations require a person directly.");
						await resendMemberInvite(ctx, member, { id: invite._id });
					}
					if (r.action === "cancel") await cancelMemberInvite(ctx, member, { id: invite._id });
					return { done: r.action, email: invite.email };
				}
				case "members.remove": {
					const r = manageInputs[tool].parse(input).request;
					const row = await ctx.db
						.query("members")
						.withIndex("by_email", (q) => q.eq("workspaceId", member.workspaceId).eq("email", normalizeEmail(r.email)))
						.first();
					if (!row) throw new ConvexError("No member with that email.");
					await removeWorkspaceMember(ctx, member, { id: row._id });
					return { removed: r.email };
				}
				case "workspace.settings": {
					const r = manageInputs[tool].parse(input).request;
					const w = (await ctx.db.get(member.workspaceId))!;
					if (r.action === "get") return { name: w.name, currency: w.currency ?? DEFAULT_CURRENCY, memory: w.memory ?? true, version: w.version ?? 0 };
					await updateWorkspaceSettings(ctx, member, { ...r, name: r.name ?? w.name });
					return { updated: true };
				}
			}
		});
	},
});
