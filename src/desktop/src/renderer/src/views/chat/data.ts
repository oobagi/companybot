import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import type { FunctionReturnType } from "convex/server";
import { useQuery } from "convex-helpers/react/cache";
import { api } from "../../api";

export type ChatList = NonNullable<FunctionReturnType<typeof api.chats.list>>;
type ChatItem = ChatList["channels"][number];
export type ChatDetails = NonNullable<FunctionReturnType<typeof api.chats.get>>;
export type Message = FunctionReturnType<typeof api.messages.list>[number];
export type Participant = Message["author"];
export type Mentions = { userIds: Id<"users">[]; agentIds: Id<"agents">[] };

/** People and agents you can mention or add. `me` is you; `others` leaves you out. */
export function useDirectory() {
	const team = useQuery(api.workspace.team);
	const chats = useQuery(api.chats.list);
	const people: (Participant & { isYou: boolean })[] =
		team?.members.map((m) => ({ type: "user" as const, id: m.userId, name: m.name || m.email, isYou: m.isYou })) ?? [];
	const agents: Participant[] = chats?.agents.map((a) => ({ type: "agent" as const, id: a._id, name: a.name })) ?? [];
	return {
		people: people.filter((p) => !p.isYou),
		agents,
		/** Everyone's names, for highlighting @mentions in text. */
		names: [...people, ...agents].map((p) => p.name).filter(Boolean),
	};
}

export const chatTitle = (chat: Pick<ChatItem, "kind" | "name" | "title">) =>
	chat.kind === "channel" ? `#${chat.name}` : chat.title;
