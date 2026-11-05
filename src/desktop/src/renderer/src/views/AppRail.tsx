import { ChatIcon, CustomizeIcon, DatabaseIcon, DriveIcon } from "../icons";
import { blurActiveEditable, shortcutLabel, useJump } from "../shortcuts";
import { useSortable } from "../sortable";
import { CountBadge, useTip } from "../ui";

/** The rail's tabs, top to bottom until you drag them into your order. */
export const appTabs = [
	{ id: "chat", label: "Chat", icon: ChatIcon },
	{ id: "drive", label: "Drive", icon: DriveIcon },
	{ id: "databases", label: "Databases", icon: DatabaseIcon },
	{ id: "customize", label: "Customize", icon: CustomizeIcon },
] as const;
export type AppTab = (typeof appTabs)[number]["id"];

/** What's waiting in a tab: a red count of chats with a mention or DM, else a dot for unread. */
export type TabBadge = { mentions: number; unread: boolean };

const tabId = (t: (typeof appTabs)[number]) => t.id;

/**
 * The strip at the far left: one button per part of the app (Chat, Drive, Databases, Customize),
 * centered, as in Macro and Linear. The sidebar beside it lists the open tab's things.
 * ⌘1–9 open them in the order shown (`shortcuts.ts`). `workspace` (the workspace switcher, named
 * `workspaceName`) sits at the top and `youMenu` (your avatar and its menu, named `you`) at the
 * bottom. `below` (pins and recents) goes under the tabs, with the rail's tips. Drag a tab to
 * reorder them; the order syncs with your account in this workspace. In Settings no tab is lit.
 */
/** A rail button (a tab or a pin): a 40px square, filled while it's the open one. */
export const railButton = (active: boolean) =>
	`no-drag flex size-10 items-center justify-center rounded-lg transition-colors ${active ? "bg-neutral-200/90 text-neutral-900" : "text-neutral-500 hover:bg-neutral-200/60 hover:text-neutral-900"}`;

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
	const { sorted: tabs, drag } = useSortable("tabs", appTabs, tabId);

	useJump("tab", (n) => {
		const to = tabs[n - 1];
		if (!to || to.id === tab) return false;
		blurActiveEditable();
		// A rail button clicked earlier would show its keyboard focus ring once keys are pressed.
		if (document.activeElement instanceof HTMLElement && document.activeElement.closest("nav[aria-label='App']")) document.activeElement.blur();
		onOpen(to.id);
	});

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
					{tabs.map((t, i) => {
						const active = t.id === tab;
						const badge = badges[t.id];
						const d = drag(t.id);
						return (
							<span key={t.id} {...d} onDragStart={(e) => (hideTip(), d.onDragStart(e))} className={`relative flex ${d.className}`}>
								<span className="relative flex" {...tipFor(t.label, i < 9 ? shortcutLabel("tab", i + 1) : undefined)}>
									{/* oxlint-disable-next-line ui/button-class -- railButton is the rail's own button look (tabs and pins); it belongs in ui.tsx */}
									<button
										type="button"
										aria-label={badge?.mentions ? `${t.label}, ${badge.mentions} unread ${badge.mentions === 1 ? "mention or DM" : "mentions or DMs"}` : t.label}
										aria-current={active ? "page" : undefined}
										onClick={() => (t.id !== tab && blurActiveEditable(), hideTip(), onOpen(t.id))}
										className={railButton(active)}
									>
										<t.icon size={22} weight={active ? "fill" : "regular"} />
									</button>
									{badge?.mentions ? (
										<CountBadge count={badge.mentions} ring className="pointer-events-none absolute -top-1 -right-1" />
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
