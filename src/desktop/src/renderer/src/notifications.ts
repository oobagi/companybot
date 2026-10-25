import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import { useQuery } from "convex-helpers/react/cache";
import { useEffect, useRef } from "react";
import { api } from "./api";
import { desktop } from "./desktop";

/**
 * Unread DMs and mentions (by your setting in Your preferences) reach you outside the app:
 * a desktop notification for each new one while the window isn't in front, and a dock badge
 * with how many chats have one. Clicking a notification opens its chat.
 */
export function useAlerts(onOpen: (chatId: Id<"chats">) => void) {
	const alerts = useQuery(api.chats.alerts);
	const seen = useRef<Set<string>>(null);
	const open = useRef(onOpen);
	open.current = onOpen;

	const count = alerts?.length ?? 0;
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
				open.current(alert.chatId);
			};
		}
	}, [alerts]);
}
