import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import type { FunctionReturnType } from "convex/server";
import { useMemo } from "react";
import { api } from "../../api";
import { useQuery } from "../../convex";

export type ChatList = NonNullable<FunctionReturnType<typeof api.chats.list>>;
type ChatItem = ChatList["channels"][number];
export type ChatDetails = NonNullable<FunctionReturnType<typeof api.chats.get>>;
export type Message = FunctionReturnType<typeof api.messages.list>[number];
export type Participant = Message["author"];
export type Mentions = { userIds: Id<"users">[]; agentIds: Id<"agents">[]; skillIds: string[] };

/** A channel the composer can name with #. `joined`: you're in it (public ones you aren't are offered too). */
export type ChannelRef = { id: Id<"chats">; name: string; topic: string | null; private: boolean; joined: boolean };
/** A skill the composer can invoke with /. */
export type SkillRef = { id: string; name: string; description: string };

/** What messages highlight as chips: @names, #channels (clickable), /skills. */
export type TokenNames = { names: string[]; channels: { name: string; id: Id<"chats"> }[]; skills: string[] };

/** People, agents, channels and skills you can mention or add. `people` leaves you out. */
export function useDirectory() {
	const team = useQuery(api.workspace.team);
	const chats = useQuery(api.chats.list);
	const browse = useQuery(api.chats.browse, {});
	const skillRows = useQuery(api.skills.list);
	const people: (Participant & { isYou: boolean })[] =
		team?.members.map((m) => ({ type: "user" as const, id: m.userId, name: m.name || m.email, image: m.image, isYou: m.isYou })) ?? [];
	const agents: Participant[] = chats?.agents.map((a) => ({ type: "agent" as const, id: a._id, name: a.name, image: a.image })) ?? [];
	const channels: ChannelRef[] = [
		...(chats?.channels ?? []).map((c) => ({ id: c._id, name: c.name ?? "", topic: c.topic, private: c.private, joined: true })),
		...(browse ?? []).map((c) => ({ id: c._id, name: c.name, topic: c.topic, private: false, joined: false })),
	].sort((a, b) => a.name.localeCompare(b.name));
	const skills: SkillRef[] = (skillRows ?? []).filter((s) => !s.trash).map((s) => ({ id: s.id, name: s.name, description: s.description }));
	// Stable while the lists are, so every message row doesn't rebuild its chip pattern per render.
	const tokens = useMemo(
		(): TokenNames => ({
			names: [...people, ...agents].map((p) => p.name).filter(Boolean),
			channels: channels.map((c) => ({ name: c.name, id: c.id })),
			skills: skills.map((s) => s.name),
		}),
		[team, chats, browse, skillRows],
	);
	return { people: people.filter((p) => !p.isYou), agents, channels, skills, tokens };
}

export const chatTitle = (chat: Pick<ChatItem, "kind" | "name" | "title">) =>
	chat.kind === "channel" ? `#${chat.name}` : chat.title;
