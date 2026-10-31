import { canEditMade, DEFAULT_CURRENCY, THREAD_HOURS_DEFAULT, isGranted, manageInputs, modelNote, normalizeCustomAutomation, pickAgentConfig, replyModeOf, searchModels } from "@companybot/core";
import { ConvexError, v } from "convex/values";
import type { Id, TableNames } from "./_generated/dataModel";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { addChannelMembers, markReadAs, createChannelAs, joinChannel, leaveChannel, openDirectMessage, removeChannelMember, updateChannelAs } from "./chats";
import { chatByRef, namer, requireChat, setChannelTrashed } from "./chatOps";
import { automationName, automationScope, canView, definitionOf, installOf } from "./automationOps";
import { removeAutomation, saveAutomation, updateAutomation } from "./automations";
import { installOf as skillInstallOf, removeSkill, saveSkill } from "./skills";
import { editMessage, hideMessagePreview, removeMessage, reactMessage, sendMessage } from "./messages";
import { cancelMemberInvite, imageSettings, inviteIn, inviteMember, removeWorkspaceMember, resendMemberInvite, updateWorkspaceSettings } from "./workspace";
import { asToolResult, checkPermission, type Member, nameOf, normalizeEmail, preferencesOf, requireAgent, skillOf, timeZoneOf } from "./lib";
import { createAgent, setAgentTrashed, updateAgent } from "./agents";
import { catalogModels } from "./modelCatalog";
import { setImage } from "./images";
import { updatePreferences } from "./preferences";
import { runNowAs } from "./automationRuns";
import { runningTurn } from "./turns";
import { usageReport } from "./usage";

const paging = (cursor?: string) => ({ cursor: cursor ?? null, numItems: 30 });
/** One page of the workspace's rows of `table` (every one's by_workspace index starts with workspaceId). */
const workspacePage = <T extends "invites" | "agents" | "members" | "automationInstalls" | "skillInstalls">(ctx: MutationCtx, table: T, member: Member, cursor?: string) =>
	ctx.db.query(table).withIndex("by_workspace", (q) => q.eq("workspaceId", member.workspaceId as never)).paginate(paging(cursor));
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
			switch (tool) {
				case "chat.manage": {
					const r = manageInputs[tool].parse(input).request;
					if (r.action === "find_people") {
						if (r.kind === "invites") {
							checkPermission(member, "members.manage");
							const result = await workspacePage(ctx, "invites", member, r.cursor);
							return { ...result, page: result.page.map((i) => ({ id: i._id, email: i.email, role: i.role })) };
						}
						if (r.kind === "agents") {
							const result = await workspacePage(ctx, "agents", member, r.cursor);
							return { ...result, page: result.page.filter((a) => !a.archived).map((a) => ({ id: a._id, name: a.name, description: a.description })) };
						}
						const result = await workspacePage(ctx, "members", member, r.cursor);
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
					if (r.action === "mark_read") {
						await markReadAs(ctx, member, await chatId(ctx, member, r.chat));
						return { done: r.action };
					}
					if (r.action === "edit" || r.action === "delete" || r.action === "react" || r.action === "hide_preview") {
						const id = rowId(ctx, "chatMessages", r.messageId);
						if (r.action === "edit") await editMessage(ctx, who, id, r.text);
						if (r.action === "delete") await removeMessage(ctx, who, id);
						if (r.action === "react") await reactMessage(ctx, who, id, r.emoji);
						if (r.action === "hide_preview") await hideMessagePreview(ctx, who, id, r.url);
						return { done: r.action, messageId: id };
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
							replies: chat.kind === "channel" ? replyModeOf(chat) : undefined,
							private: chat.private,
							isDefault: chat.isDefault,
							...result,
							page: await Promise.all(result.page.map((m) => namer(ctx).of(m))),
						};
					}
					if (r.action === "delete" || r.action === "restore") await setChannelTrashed(ctx, who, id, r.action === "delete");
					if (r.action === "rename") await updateChannelAs(ctx, member, { chatId: id, name: r.name });
					if (r.action === "set_topic") await updateChannelAs(ctx, member, { chatId: id, topic: r.topic });
					if (r.action === "set_replies") await updateChannelAs(ctx, member, { chatId: id, replyMode: r.replies });
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
						const result = await workspacePage(ctx, "automationInstalls", member, r.cursor);
						return {
							...result,
							page: result.page
								.filter((i) => canView(member, i) && !i.archived)
								.map((i) => ({ id: i.automationId, name: automationName(i), enabled: i.enabled, agentId: i.agentId, version: i.custom?.version ?? i.definition?.version })),
						};
					}

					const install = await installOf(ctx, member.workspaceId, r.id);
					if (!install || !canView(member, install)) throw new ConvexError("Automation not found.");
					if (r.action === "get")
						return {
							id: r.id,
							definition: await definitionOf(ctx, install),
							config: install.custom && { ...install.custom, trigger: normalizeCustomAutomation(install.custom).trigger },
							enabled: install.enabled,
							agentId: install.agentId,
							audience: install.audience,
							channelId: install.channelId,
							timeZone: install.timeZone,
							lastRunAt: install.lastRunAt,
							lastResult: install.lastResult,
						};
					if (r.action === "run") {
						if ((await automationScope(ctx, turn)).trigger?.automation) throw new ConvexError("An automation run cannot start another run.");
						await runNowAs(ctx, member, r.id);
					}
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
					await removeAutomation(ctx, who, r.id);
					return { deleted: r.id };
				}
				case "skills.manage": {
					const r = manageInputs[tool].parse(input).request;
					if (r.action === "list") {
						const result = await workspacePage(ctx, "skillInstalls", member, r.cursor);
						return {
							...result,
							page: result.page.filter((i) => !i.archived).map((i) => ({ id: i.skillId, name: skillOf(i)?.name, version: i.custom?.version ?? i.definition?.version })),
						};
					}
					const install = await skillInstallOf(ctx, member.workspaceId, r.id);
					const skill = install && skillOf(install);
					if (!skill) throw new ConvexError("Skill not found.");
					return { ...skill, id: r.id, version: install.custom?.version ?? skill.version, installed: true, canEdit: canEditMade(member, "skills.manage", install.custom?.createdBy) };
				}
				case "skills.edit": {
					const r = manageInputs[tool].parse(input).request;
					await saveSkill(ctx, member, { skillId: r.id, config: r.config, expectedVersion: r.expectedVersion });
					return { done: r.action, id: r.id };
				}
				case "skills.remove": {
					const r = manageInputs[tool].parse(input).request;
					await removeSkill(ctx, who, r.id);
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
				case "agents.manage": {
					const r = manageInputs[tool].parse(input).request;
					if (r.action === "list") {
						const result = await workspacePage(ctx, "agents", member, r.cursor);
						return { ...result, page: result.page.map((a) => ({ id: a._id, name: a.name, description: a.description, inTrash: a.archived, version: a.version })) };
					}
					if (r.action === "models") {
						const found = searchModels((await catalogModels(ctx)).models, r.search);
						return { total: found.length, models: found.slice(0, 50).map((m) => ({ id: m.id, name: m.name, note: modelNote(m) })), ...(found.length > 50 && { more: "Search to narrow the list." }) };
					}
					if (r.action === "create") return { id: await createAgent(ctx, member, true) };
					const id = rowId(ctx, "agents", r.id);
					const agent = await requireAgent(ctx, member, id);
					if (r.action === "get") return { id, ...pickAgentConfig(agent), version: agent.version, inTrash: agent.archived };
					if (r.action === "history") return ctx.db.query("agentVersions").withIndex("by_agent", (q) => q.eq("agentId", id)).order("desc").paginate(paging(r.cursor));
					if (r.action === "delete") await setAgentTrashed(ctx, who, id, true);
					if (r.action === "remove_image") await setImage(ctx, member, id, null);
					if (r.action === "update") {
						if (id === turn.agentId && (r.instructions !== undefined || r.model !== undefined || r.reasoning !== undefined)) throw new ConvexError("Only a person can change your instructions, model or reasoning.");
						const { action, id: _, expectedVersion, ...changes } = r;
						await updateAgent(ctx, member, id, expectedVersion, { ...pickAgentConfig(agent), ...changes });
					}
					return { done: r.action, id };
				}
				case "workspace.settings": {
					const r = manageInputs[tool].parse(input).request;
					if (r.action === "usage") return usageReport(ctx, member, r.month);
					if (r.action === "get_preferences") {
						const prefs = await preferencesOf(ctx, member.userId);
						return { displayName: prefs?.displayName ?? "", sendWith: prefs?.sendWith ?? "enter", notify: prefs?.notify ?? "all", timeZone: prefs?.timeZone ?? null };
					}
					if (r.action === "remove_image") {
						await setImage(ctx, member, r.of, null);
						return { done: r.action };
					}
					if (r.action === "update_preferences") {
						const { action, ...changes } = r;
						await updatePreferences(ctx, member.userId, changes);
						return { updated: true };
					}
					const w = (await ctx.db.get(member.workspaceId))!;
					if (r.action === "get") {
						const images = await imageSettings(ctx, member, w);
						return { name: w.name, currency: w.currency ?? DEFAULT_CURRENCY, memory: w.memory ?? true, ...images, imageModels: images.imageModels.map((m) => m.id), threadHours: w.threadHours ?? THREAD_HOURS_DEFAULT, version: w.version ?? 0 };
					}
					await updateWorkspaceSettings(ctx, member, { ...r, name: r.name ?? w.name });
					return { updated: true };
				}
			}
		});
	},
});
