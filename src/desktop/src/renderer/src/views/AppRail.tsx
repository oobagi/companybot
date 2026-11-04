import { useEffect } from "react";
import { ChatIcon, CustomizeIcon, DatabaseIcon, DriveIcon } from "../icons";
import { useSortable } from "../sortable";
import { useTip } from "../ui";

/** The rail's tabs, top to bottom. `key` is the letter after G that opens it. */
export const appTabs = [
	{ id: "chat", label: "Chat", key: "c", icon: ChatIcon },
	{ id: "drive", label: "Drive", key: "f", icon: DriveIcon },
	{ id: "databases", label: "Databases", key: "d", icon: DatabaseIcon },
	{ id: "customize", label: "Customize", key: "x", icon: CustomizeIcon },
] as const;
export type AppTab = (typeof appTabs)[number]["id"];

/** What's waiting in a tab: a red count of chats with a mention or DM, else a dot for unread. */
export type TabBadge = { mentions: number; unread: boolean };

const tabId = (t: (typeof appTabs)[number]) => t.id;

/** How long G waits for its letter. */
const LEADER_MS = 1500;

/** Typing, G is a letter, not a shortcut. */
const typing = (target: EventTarget | null) =>
	target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));

/**
 * The strip at the far left: one button per part of the app (Chat, Drive, Databases, Customize),
 * centered, as in Macro and Linear. The sidebar beside it lists the open tab's things.
 * Press G then the tab's letter to open it. `workspace` (the workspace switcher, named
 * `workspaceName`) sits at the top and `youMenu` (your avatar and its menu, named `you`) at the
 * bottom. `below` (pins and recents) goes under the tabs, with the rail's tips. Drag a tab to
 * reorder them; the order syncs with your account in this workspace. In Settings no tab is lit.
 */
export function AppRail({
	tab,
	onOpen,
	badges = {},
	workspace,
	workspaceName,
	below,
	you,
	youMenu,
}: {
	tab: AppTab | undefined;
	onOpen: (tab: AppTab) => void;
	badges?: Partial<Record<AppTab, TabBadge>>;
	workspace?: React.ReactNode;
	workspaceName?: string;
	below?: (tipFor: ReturnType<typeof useTip>["tipFor"], hideTip: () => void) => React.ReactNode;
	you?: string;
	youMenu?: React.ReactNode;
}) {
	const { tipFor, tip, hideTip } = useTip("right");
	const { sorted: tabs, drag } = useSortable("rail.tabs", appTabs, tabId);

	useEffect(() => {
		let leader: ReturnType<typeof setTimeout> | undefined;
		const key = (e: KeyboardEvent) => {
			if (e.metaKey || e.ctrlKey || e.altKey || e.repeat || typing(e.target)) return;
			const letter = e.key.toLowerCase();
			if (leader) {
				clearTimeout(leader);
				leader = undefined;
				const to = appTabs.find((t) => t.key === letter);
				if (!to) return;
				e.preventDefault();
				// A rail button clicked earlier would show its keyboard focus ring once keys are pressed.
				if (document.activeElement instanceof HTMLElement && document.activeElement.closest("nav[aria-label='App']")) document.activeElement.blur();
				onOpen(to.id);
				return;
			}
			if (letter === "g" && !e.shiftKey) leader = setTimeout(() => (leader = undefined), LEADER_MS);
		};
		window.addEventListener("keydown", key);
		return () => (clearTimeout(leader), window.removeEventListener("keydown", key));
	}, [onOpen]);

	return (
		<nav aria-label="App" className="drag flex w-[60px] shrink-0 flex-col items-center pt-2 pb-3">
			{workspace && (
				<span className="flex" {...tipFor(workspaceName ?? "")}>
					{workspace}
				</span>
			)}
			{/* Centered while it fits; with many pins it scrolls (my-auto keeps a short list in the middle). */}
			<div onScroll={hideTip} className="no-drag flex min-h-0 w-full flex-1 flex-col items-center overflow-y-auto py-2 [scrollbar-width:none]">
				<div className="my-auto flex flex-col items-center gap-1">
					{tabs.map((t) => {
						const active = t.id === tab;
						const badge = badges[t.id];
						const d = drag(t.id);
						return (
							<span key={t.id} {...d} onDragStart={(e) => (hideTip(), d.onDragStart(e))} className={`relative flex ${d.className}`}>
								<span className="relative flex" {...tipFor(t.label, `G ${t.key.toUpperCase()}`)}>
									<button
										type="button"
										aria-label={badge?.mentions ? `${t.label}, ${badge.mentions} unread mentions` : t.label}
										aria-current={active ? "page" : undefined}
										onClick={() => (hideTip(), onOpen(t.id))}
										className={`no-drag flex size-9 items-center justify-center rounded-lg transition-colors ${active ? "bg-neutral-200/90 text-neutral-900" : "text-neutral-500 hover:bg-neutral-200/60 hover:text-neutral-900"}`}
									>
										<t.icon size={20} weight={active ? "fill" : "regular"} />
									</button>
									{badge?.mentions ? (
										<span className="pointer-events-none absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full border-2 border-neutral-100 bg-red-500 px-0.5 text-[10px] leading-none font-semibold text-white">
											{badge.mentions > 9 ? "9+" : badge.mentions}
										</span>
									) : (
										badge?.unread && <span className="pointer-events-none absolute top-1 right-1 size-2 rounded-full border-2 border-neutral-100 bg-sky-500" />
									)}
								</span>
							</span>
						);
					})}
					{below?.(tipFor, hideTip)}
				</div>
			</div>
			{youMenu && (
				// Hovered, it names you, as the rail names each tab.
				<span className="flex" {...tipFor(you ?? "")}>
					{youMenu}
				</span>
			)}
			{tip}
		</nav>
	);
}
