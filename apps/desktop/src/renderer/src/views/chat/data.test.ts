import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import type { OptimisticLocalStore } from "convex/browser";
import { getFunctionName } from "convex/server";
import { convexToJson } from "convex/values";
import { describe, expect, it } from "vitest";
import { api } from "../../api";
import { type Message, showSending } from "./data";

const workspaceId = "w1" as Id<"workspaces">;
const chatId = "c1" as Id<"chats">;
const threadId = "m0" as Id<"chatMessages">;
const me = { userId: "u1", name: "Ada", email: "ada@x.co", image: null, isYou: true };

/** Convex's local store, keyed the way it keys queries (args sorted, undefined dropped). */
const store = (queries: (readonly [unknown, Record<string, unknown>, unknown])[]) => {
	const key = (q: unknown, args: Record<string, unknown>) => getFunctionName(q as never) + JSON.stringify(convexToJson(args as never));
	const data = new Map(queries.map(([q, args, value]) => [key(q, args), value]));
	return {
		getQuery: (q: unknown, args: Record<string, unknown>) => data.get(key(q, args)),
		setQuery: (q: unknown, args: Record<string, unknown>, value: unknown) => void data.set(key(q, args), value),
		getAllQueries: () => [],
	} as unknown as OptimisticLocalStore;
};
const team = [api.workspace.team, { workspaceId }, { members: [{ ...me, userId: "u2", name: "Sam", isYou: false }, me] }] as const;
const send = { workspaceId, chatId, text: " hi @Sam ", mentions: { userIds: [], agentIds: [] } };

describe("showSending", () => {
	it("adds your message, marked sending, to the end of the chat", () => {
		const local = store([[api.messages.list, { chatId, workspaceId }, [{ _id: "m1" }]], team]);
		showSending(local, send);
		const list = local.getQuery(api.messages.list, { workspaceId, chatId, threadId: undefined }) as Message[];
		expect(list).toHaveLength(2);
		expect(list[1]).toMatchObject({ text: "hi @Sam", mine: true, author: { type: "user", id: "u1", name: "Ada" }, sending: { files: 0 } });
	});

	it("goes in the thread's list, not the chat's, and counts its files", () => {
		const local = store([[api.messages.list, { chatId, workspaceId }, []], [api.messages.list, { chatId, threadId, workspaceId }, [{ _id: threadId }]], team]);
		showSending(local, { ...send, threadId, attachments: ["s1" as Id<"_storage">, "s2" as Id<"_storage">] });
		expect(local.getQuery(api.messages.list, { workspaceId, chatId })).toEqual([]);
		const thread = local.getQuery(api.messages.list, { workspaceId, chatId, threadId }) as Message[];
		expect(thread[1]).toMatchObject({ threadId, sending: { files: 2 } });
	});

	it("does nothing for a list that isn't loaded", () => {
		const local = store([team]);
		showSending(local, send);
		expect(local.getQuery(api.messages.list, { workspaceId, chatId })).toBeUndefined();
	});
});
