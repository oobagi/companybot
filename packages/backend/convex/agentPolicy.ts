import { replyModeOf } from "@companybot/core";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";

/** Older workspaces keep their behavior until someone changes the switches. */
export async function autonomyAllowed(ctx: QueryCtx, workspaceId: Id<"workspaces">, handoff = false) {
	const workspace = await ctx.db.get(workspaceId);
	return !!workspace && !workspace.deleting && !workspace.resetting && workspace.agentAutonomy !== false && (!handoff || workspace.agentHandoffs !== false);
}

/** Kept on follow-ups too, so a queued handoff cannot outlive a workspace's off switch. */
export const isHandoff = (turn: Pick<Doc<"agentTurns">, "handoff" | "ask" | "chain">) =>
	!!turn.handoff || !!turn.ask || (turn.chain?.path.length ?? 0) > 1;

/** Used at start, before tools, during streaming, and at finish. Direct human requests still work. */
export async function autonomyProblem(ctx: QueryCtx, turn: Doc<"agentTurns">): Promise<string | null> {
	const handoff = isHandoff(turn);
	if (!turn.routed && !handoff) return null;
	if (!(await autonomyAllowed(ctx, turn.workspaceId, handoff))) return "Automatic agent activity or handoffs were turned off in workspace settings.";
	if (turn.routed && !handoff) {
		const chat = await ctx.db.get(turn.chatId);
		if (!chat || replyModeOf(chat) !== "relevant") return "This channel now allows mentions only.";
	}
	return null;
}
