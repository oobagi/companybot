import type { PinKey } from "../pins";
import { useTip } from "../ui";
import { type AppTab, RailPins, type TabBadge } from "./RailPins";

/**
 * The strip at the far left: the workspace switcher (`workspace`, named `workspaceName`) at the top,
 * your avatar and its menu (`youMenu`, named `you`) at the bottom, and between them, centered, one group
 * of tabs (Chat, Drive, Databases, Customize) and pins in your order, then recents (`RailPins`). The
 * sidebar beside it lists the open tab's things. `tab` and `open` (a pin) are what's on screen; in
 * Settings nothing is lit.
 */
export function AppRail({
	tab,
	onOpen,
	badges = {},
	open,
	workspace,
	workspaceName,
	you,
	youMenu,
}: {
	tab: AppTab | undefined;
	onOpen: (tab: AppTab) => void;
	badges?: Partial<Record<AppTab, TabBadge>>;
	open?: PinKey;
	workspace?: React.ReactNode;
	workspaceName?: string;
	you?: string;
	youMenu?: React.ReactNode;
}) {
	const { tipFor, tip, hideTip } = useTip("right");
	return (
		<nav aria-label="App" className="drag flex w-[60px] shrink-0 flex-col items-center pt-2 pb-3 select-none">
			{workspace && (
				<span className="flex" {...tipFor(workspaceName ?? "")}>
					{workspace}
				</span>
			)}
			{/* Centered while it fits; with many pins it scrolls (my-auto keeps a short list in the middle). Pinning a
			    recent or unpinning a pin keeps the count, so nothing shifts. */}
			<div onScroll={hideTip} className="no-drag flex min-h-0 w-full flex-1 flex-col items-center overflow-y-auto py-2 [scrollbar-width:none]">
				<div className="my-auto flex flex-col items-center gap-1">
					<RailPins tab={tab} onOpenTab={onOpen} badges={badges} open={open} tipFor={tipFor} hideTip={hideTip} />
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
