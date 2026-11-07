import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import { useEffect, useRef } from "react";
import { api } from "./api";
import { type OpenWorkspace, useQuery, useWorkspace } from "./convex";
import { desktop } from "./desktop";
import { navigate } from "./router";

/**
 * Unread DMs and mentions (by your setting in Your preferences), and Inbox's notifications, reach
 * you outside the app: a desktop notification for each new one while the window isn't in front,
 * and a dock badge with how many there are (as the bell's tray lists them). Clicking a notification
 * opens its chat (or the thread, for a mention in one) or conversation, in its workspace, even if
 * this window has switched to another since.
 */
export function useAlerts() {
	const alerts = useQuery(api.chats.alerts);
	const inbox = useQuery(api.notifications.list);
	const seen = useRef<Set<string>>(null);
	const seenInbox = useRef<Set<string>>(null);
	const current = useWorkspace();
	const workspace = useRef(current);
	workspace.current = current;

	const count = (alerts?.length ?? 0) + (inbox?.filter((n) => n.popUp).length ?? 0);
	useEffect(() => desktop?.setBadge(count), [count]);
	// Signing out or switching workspaces clears it; the next workspace sets its own.
	useEffect(() => () => desktop?.setBadge(0), []);

	useEffect(() => {
		if (typeof Notification !== "undefined" && Notification.permission === "default") void Notification.requestPermission();
	}, []);

	useEffect(() => {
		if (!alerts) return;
		const known = seen.current;
		seen.current = new Set(alerts.map((a) => a.messageId));
		// What was already waiting when the app opened shows in the sidebar, not as a pop-up.
		if (!known || document.hasFocus() || typeof Notification === "undefined" || Notification.permission !== "granted") return;
		for (const alert of alerts) {
			if (known.has(alert.messageId)) continue;
			const notification = new Notification(alert.title, { body: alert.text, tag: alert.chatId });
			notification.onclick = () => {
				desktop?.focus();
				window.focus();
				openAlert(alert, workspace.current);
			};
		}
	}, [alerts]);

	useEffect(() => {
		if (!inbox) return;
		const known = seenInbox.current;
		seenInbox.current = new Set(inbox.map((n) => n.id));
		if (!known || document.hasFocus() || typeof Notification === "undefined" || Notification.permission !== "granted") return;
		for (const n of inbox) {
			if (known.has(n.id) || !n.popUp) continue;
			const notification = new Notification(n.contactName ?? n.contact, { body: n.text, tag: n.conversationId });
			notification.onclick = () => {
				desktop?.focus();
				window.focus();
				if (workspace.current) navigate("inbox", n.conversationId);
			};
		}
	}, [inbox]);
}

/**
 * Opens the alert's workspace, then its chat. Always through `open` (App.tsx's gate, which
 * outlives workspace switches and checks you're still in it): a notification can outlive the
 * screen that showed it, so its idea of which workspace is open may be stale.
 */
export function openAlert(alert: { workspaceId: Id<"workspaces">; chatId: Id<"chats">; threadId?: Id<"chatMessages"> }, workspace: OpenWorkspace | null) {
	if (!workspace?.open(alert.workspaceId)) return;
	if (alert.threadId) navigate("chat", alert.chatId, "thread", alert.threadId);
	else navigate("chat", alert.chatId);
}
