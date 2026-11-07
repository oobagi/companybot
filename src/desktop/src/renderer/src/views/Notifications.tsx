import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import { formatPhone } from "@companybot/core/inbox";
import { api } from "../api";
import { useMutation, useQuery, useWorkspace } from "../convex";
import { ChatIcon, CloseIcon, NotificationsIcon } from "../icons";
import { openAlert } from "../notifications";
import { navigate } from "../router";
import { compactButton, rowButton, smallIconButton, timeAgo, titleBarButton } from "../ui";
import { Avatar, Popover } from "./chat/common";

// The bell in the title bar: what needs you, newest first. Inbox's (assigned to you, a customer
// wrote, the agent needs staff; backend notifications.ts) and unread DMs and mentions (chats.alerts),
// in one list. Opening one goes there and clears it; × clears it; Clear all clears them all.

type Entry = {
	key: string;
	at: number;
	title: string;
	text: string;
	icon: React.ReactNode;
	open: () => void;
	clear: () => void;
};

export function NotificationTray() {
	const inbox = useQuery(api.notifications.list);
	const alerts = useQuery(api.chats.alerts);
	const clear = useMutation(api.notifications.clear);
	const clearAll = useMutation(api.notifications.clearAll);
	const markRead = useMutation(api.chats.markRead);
	const workspace = useWorkspace();
	if (inbox === null || alerts === null) return null;

	const entries: Entry[] = [
		...(inbox ?? []).map((n) => {
			const them = n.contactName ?? (n.channel === "sms" ? formatPhone(n.contact) : n.contact);
			return {
				key: n.id,
				at: n.at,
				title: them,
				text: n.text,
				icon: n.actor ? <Avatar name={n.actor.name} image={n.actor.image} agent={n.actor.type === "agent"} size="sm" /> : <Avatar name={them} size="sm" />,
				open: () => (navigate("inbox", n.conversationId), void clear({ id: n.id })),
				clear: () => void clear({ id: n.id }),
			};
		}),
		...(alerts ?? []).map((a) => ({
			key: a.messageId,
			at: a.at,
			title: a.title,
			text: a.text,
			icon: (
				<span className="flex size-6 items-center justify-center rounded-full bg-neutral-100 text-neutral-500">
					<ChatIcon />
				</span>
			),
			open: () => openAlert(a, workspace),
			clear: () => void markRead({ chatId: a.chatId as Id<"chats"> }),
		})),
	].sort((a, b) => b.at - a.at);

	return (
		<Popover
			label="Notifications"
			trigger={
				<>
					<span className="sr-only">Notifications</span>
					<NotificationsIcon />
					{entries.length > 0 && <span className="absolute top-1 right-1 size-2 rounded-full bg-red-500 ring-2 ring-neutral-50" />}
				</>
			}
			className={`relative ${titleBarButton}`}
			panelClassName="flex max-h-[min(32rem,80vh)] w-96 flex-col text-sm outline-none"
		>
			{(close) => (
				<>
					<div className="flex items-center justify-between gap-2 border-b border-neutral-100 px-3 py-2">
						<h2 className="font-medium">Notifications</h2>
						{entries.length > 0 && (
							<button
								type="button"
								className={compactButton}
								onClick={() => {
									void clearAll();
									for (const a of alerts ?? []) void markRead({ chatId: a.chatId as Id<"chats"> });
								}}
							>
								Clear all
							</button>
						)}
					</div>
					{entries.length === 0 ? (
						<p className="px-3 py-8 text-center text-neutral-400">You're all caught up.</p>
					) : (
						<ul className="flex flex-col overflow-y-auto p-1">
							{entries.map((e) => (
								<li key={e.key} className="group/row relative">
									<button type="button" className={`${rowButton} items-start gap-2.5 py-2 pr-8`} onClick={() => (close(), e.open())}>
										<span className="pt-0.5">{e.icon}</span>
										<span className="flex min-w-0 flex-1 flex-col">
											<span className="flex items-baseline gap-2">
												<span className="min-w-0 flex-1 truncate font-medium text-neutral-900">{e.title}</span>
												<span className="shrink-0 text-xs text-neutral-400">{timeAgo(e.at)}</span>
											</span>
											<span className="line-clamp-2 text-neutral-600">{e.text}</span>
										</span>
									</button>
									<button type="button" aria-label="Clear" title="Clear" className={`absolute top-2 right-1.5 opacity-0 group-hover/row:opacity-100 focus:opacity-100 ${smallIconButton}`} onClick={e.clear}>
										<CloseIcon />
									</button>
								</li>
							))}
						</ul>
					)}
				</>
			)}
		</Popover>
	);
}
