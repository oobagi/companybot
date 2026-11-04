import { useEffect, useReducer } from "react";
import { useUpdates } from "../desktop";
import { ArrowLeftIcon, ArrowRightIcon, BugIcon, HelpIcon, SidebarIcon, SparkleIcon } from "../icons";
import { MenuDivider, useTip } from "../ui";
import { MenuItem, Popover } from "./chat/common";

const mod = navigator.userAgent.includes("Mac") ? "⌘" : "Ctrl+";
const repo = "https://github.com/oobagi/companybot";

// Chromium's Navigation API knows whether there's a screen to go back or forward to; TypeScript
// doesn't describe it yet. Missing (older browsers), the arrows just stay enabled.
type Navigation = EventTarget & { canGoBack: boolean; canGoForward: boolean };
const navigation = (globalThis as { navigation?: Navigation }).navigation;

const button =
	"no-drag flex size-6 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-200/70 hover:text-neutral-900 disabled:text-neutral-300 disabled:hover:bg-transparent";

/**
 * The strip across the top of the window, beside its buttons: hide the sidebar, step back and
 * forward through screens, and Help. Empty space in it drags the window.
 */
export function TitleBar({ sidebar, onSidebar }: { sidebar: boolean; onSidebar: () => void }) {
	const [, changed] = useReducer((n: number) => n + 1, 0);
	const { tipFor, tip } = useTip("below");
	useEffect(() => {
		navigation?.addEventListener("currententrychange", changed);
		return () => navigation?.removeEventListener("currententrychange", changed);
	}, []);

	useEffect(() => {
		const key = (e: KeyboardEvent) => {
			if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
			const act = { "\\": onSidebar, "[": () => history.back(), "]": () => history.forward() }[e.key];
			if (!act) return;
			e.preventDefault();
			act();
		};
		window.addEventListener("keydown", key);
		return () => window.removeEventListener("keydown", key);
	}, [onSidebar]);

	return (
		// Starts past the window's buttons (macOS puts them at the top left).
		<div className="drag flex h-8 shrink-0 items-center gap-0.5 pr-2 pl-[84px] text-base">
			{/* Tips go on a wrapper: a disabled button gets no mouse events. */}
			<span className="flex" {...tipFor(`${sidebar ? "Hide" : "Show"} sidebar`, `${mod}\\`)}>
				<button type="button" aria-label={`${sidebar ? "Hide" : "Show"} sidebar`} onClick={onSidebar} className={button}>
					<SidebarIcon />
				</button>
			</span>
			<span className="flex" {...tipFor("Back", `${mod}[`)}>
				<button type="button" aria-label="Back" disabled={navigation && !navigation.canGoBack} onClick={() => history.back()} className={button}>
					<ArrowLeftIcon />
				</button>
			</span>
			<span className="flex" {...tipFor("Forward", `${mod}]`)}>
				<button type="button" aria-label="Forward" disabled={navigation && !navigation.canGoForward} onClick={() => history.forward()} className={button}>
					<ArrowRightIcon />
				</button>
			</span>
			<span className="ml-auto flex" {...tipFor("Help")}>
				<Help />
			</span>
			{tip}
		</div>
	);
}

/** Top right, as in Slack: what changed lately, and where to report a problem. */
function Help() {
	const { version } = useUpdates();
	return (
		<Popover
			trigger={
				<>
					<span className="sr-only">Help</span>
					<HelpIcon />
				</>
			}
			className={button} panelClassName="w-56 p-1 text-sm">
			{(close) => (
				<>
					<MenuItem onClick={() => (close(), window.open(`${repo}/releases`))}>
						<SparkleIcon className="text-neutral-500" /> What's new
					</MenuItem>
					<MenuItem onClick={() => (close(), window.open(`${repo}/issues/new`))}>
						<BugIcon className="text-neutral-500" /> Report a problem
					</MenuItem>
					{version && (
						<>
							<MenuDivider />
							<p className="px-2 py-1 text-xs text-neutral-500">Companybot {version}</p>
						</>
					)}
				</>
			)}
		</Popover>
	);
}
