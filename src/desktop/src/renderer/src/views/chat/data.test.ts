import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import type { OptimisticLocalStore } from "convex/browser";
import { getFunctionName } from "convex/server";
import { convexToJson } from "convex/values";
import { describe, expect, it } from "vitest";
import { api } from "../../api";
import { type Message, inOrder, showSending } from "./data";

const workspaceId = "w1" as Id<"workspaces">;
const chatId = "c1" as Id<"chats">;
const threadId = "m0" as Id<"chatMessages">;
const me = { userId: "u1", name: "Ada", email: "ada@x.co", image: null, isYou: true };

/** Convex's local store, keyed the way it keys queries (args sorted, undefined dropped). */
const store = (queries: (readonly [unknown, Record<string, unknown>, unknown])[]) => {
	const key = (q: unknown, args: Record<string, unknown>) => getFunctionName(q as never) + JSON.stringify(convexToJson(args as never));
	const data = new Map(queries.map(([q, args, value]) => [key(q, args), { name: getFunctionName(q as never), args, value }]));
	return {
		getQuery: (q: unknown, args: Record<string, unknown>) => data.get(key(q, args))?.value,
		setQuery: (q: unknown, args: Record<string, unknown>, value: unknown) => void data.set(key(q, args), { name: getFunctionName(q as never), args, value }),
		getAllQueries: (q: unknown) => [...data.values()].filter((e) => e.name === getFunctionName(q as never)).map(({ args, value }) => ({ args, value })),
	} as unknown as OptimisticLocalStore;
};
const team = [api.workspace.team, { workspaceId }, { members: [{ ...me, userId: "u2", name: "Sam", isYou: false }, me] }] as const;
const send = { workspaceId, chatId, text: " hi @Sam ", mentions: { userIds: [], agentIds: [] } };
/** A list page as usePaginatedQuery asks for it: the newest (no cursor), or an older one. */
const pageArgs = (args: Record<string, unknown>, cursor: string | null = null) => ({ workspaceId, chatId, ...args, paginationOpts: { numItems: 50, cursor, id: 1 } });
const pageOf = (page: unknown[]) => ({ page, isDone: false, continueCursor: "next" });
const shownIn = (local: OptimisticLocalStore, args: Record<string, unknown>, cursor: string | null = null) =>
	(local.getQuery(api.messages.page, pageArgs(args, cursor) as never)?.page ?? []) as Message[];

describe("showSending", () => {
 it("keeps each send distinct and its identity stable when replayed", () => {
 const first = showSending();
 const second = showSending();
 const fresh = () => store([[api.messages.page, pageArgs({}), pageOf([])], team]);
 const local = fresh();
 first(local, send);
 second(local, send);
 const ids = shownIn(local, {}).map((m) => m._id);
 expect(new Set(ids).size).toBe(2);
 const replay = fresh();
 first(replay, send);
 second(replay, send);
 expect(shownIn(replay, {}).map((m) => m._id)).toEqual(ids);
 });

	it("adds your message, marked sending, to the end of the chat's newest page", () => {
		const local = store([[api.messages.page, pageArgs({}), pageOf([{ _id: "m1" }])], [api.messages.page, pageArgs({}, "older"), pageOf([{ _id: "m0" }])], team]);
		showSending()(local, send);
		const list = shownIn(local, {});
		expect(list).toHaveLength(2);
		expect(list[1]).toMatchObject({ text: "hi @Sam", mine: true, author: { type: "user", id: "u1", name: "Ada" }, sending: { files: 0 } });
		expect(shownIn(local, {}, "older")).toHaveLength(1);
	});

	it("adds it to every copy of the newest page, so a page split since still shows it", () => {
		const split = { ...pageArgs({}), paginationOpts: { numItems: 50, cursor: null, endCursor: "mid", id: 1 } };
		const local = store([[api.messages.page, pageArgs({}), pageOf([{ _id: "m1" }])], [api.messages.page, split, pageOf([{ _id: "m1" }])], team]);
		showSending()(local, send);
		expect(shownIn(local, {})).toHaveLength(2);
		expect((local.getQuery(api.messages.page, split as never)!.page as Message[]).at(-1)).toMatchObject({ text: "hi @Sam", sending: { files: 0 } });
	});

	it("goes in the thread's list, not the chat's, and counts its files", () => {
		const local = store([[api.messages.page, pageArgs({}), pageOf([])], [api.messages.page, pageArgs({ threadId }), pageOf([{ _id: threadId }])], team]);
		showSending()(local, { ...send, threadId, attachments: ["s1" as Id<"_storage">, "s2" as Id<"_storage">] });
		expect(shownIn(local, {})).toEqual([]);
		expect(shownIn(local, { threadId })[1]).toMatchObject({ threadId, sending: { files: 2 } });
	});

	it("does nothing for a list that isn't loaded", () => {
		const local = store([team]);
		showSending()(local, send);
		expect(local.getAllQueries(api.messages.page)).toEqual([]);
	});
});

describe("inOrder", () => {
	it("puts pages together in the order shown, a thread's parent first", () => {
		const m = (id: string, shownAt: number) => ({ _id: id, shownAt }) as unknown as Message;
		// Newest page first, as they load; a reply that took in later messages shows below them.
		const pages = [m("m3", 30), m("m5", 25), m("m4", 40), m("m1", 10), m("m2", 20), m("m0", 50)];
		expect(inOrder(pages).map((x) => x._id)).toEqual(["m1", "m2", "m5", "m3", "m4", "m0"]);
		expect(inOrder(pages, "m0" as Id<"chatMessages">).map((x) => x._id)).toEqual(["m0", "m1", "m2", "m5", "m3", "m4"]);
	});
});
