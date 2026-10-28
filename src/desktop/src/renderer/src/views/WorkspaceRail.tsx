import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { useMutation, useQuery, useWorkspace } from "../convex";
import { PlusIcon } from "../icons";
import { navigate } from "../router";
import { useSortable } from "../sortable";
import { Notice, Scroll, compactControlClass, primaryButton, useRun, useTip } from "../ui";
import { Avatar, Popover } from "./chat/common";

const none: never[] = [];
const workspaceKey = (w: { id: string }) => w.id;

/** Round until hovered or open, then a rounded square, as in Discord. */
const shape = "no-drag relative size-9 transition-all";

/** ⌘1–9 (Ctrl elsewhere) opens the workspace at that place in the rail. */
const mod = navigator.userAgent.includes("Mac") ? "⌘" : "Ctrl+";

/**
 * The strip at the far left: a logo per workspace you're in, then any invites, then + to start one.
 * Click one, or press ⌘ and its number, to switch. Others show what's waiting in them. `youMenu`
 * (your avatar and its menu, named `you`) sits at the bottom.
 */
export function WorkspaceRail({ you, youMenu }: { you?: string; youMenu?: React.ReactNode }) {
	const mine = useQuery(api.workspace.mine);
	const activity = useQuery(api.workspace.activity);
	const current = useWorkspace();
	const { tipFor, tip, hideTip } = useTip("right");
	// Drag to reorder; ⌘1–9 follow your order.
	const { sorted: workspaces, drag } = useSortable("rail.order", mine?.workspaces ?? none, workspaceKey);
	// Chats and records belong to one workspace, so a switch starts from the chat list.
	const goTo = (workspaceId: Id<"workspaces">) => (hideTip(), current?.open(workspaceId), navigate("chat"));
	// A join or create resolves before the list shows the workspace, and opening one you're not in is
	// refused, so it opens once it's listed.
	const [joined, setJoined] = useState<Id<"workspaces">>();
	useEffect(() => {
		if (joined && mine?.workspaces.some((w) => w.id === joined)) {
			setJoined(undefined);
			goTo(joined);
		}
	}, [joined, mine]);

	useEffect(() => {
		const key = (e: KeyboardEvent) => {
			if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey || !/^[1-9]$/.test(e.key)) return;
			const w = workspaces[Number(e.key) - 1];
			if (!w) return;
			e.preventDefault();
			if (w.id !== current?.id) goTo(w.id);
		};
		window.addEventListener("keydown", key);
		return () => window.removeEventListener("keydown", key);
	}, [workspaces, current]);

	return (
		<nav className="flex w-[60px] shrink-0 flex-col [--scrim:var(--color-neutral-100)]">
			{/* Workspaces and invites scroll under the title bar, fading out like the sidebar. */}
			<Scroll
				className="no-drag [scrollbar-width:none]"
				onScroll={hideTip}
				header={<div className="drag pt-3" />}
				footer={
					youMenu && (
						// Hovered, it names you, as the rail names each workspace.
						<div className="flex justify-center pt-2 pb-3">
							<span className="flex" {...tipFor(you ?? "")}>
								{youMenu}
							</span>
						</div>
					)
				}
			>
				<div className="flex flex-col items-center gap-2 pb-3">
					{workspaces.map((w, i) => {
						const active = w.id === current?.id;
						const waiting = active ? undefined : activity?.find((a) => a.id === w.id);
						const d = drag(w.id);
						return (
							<div key={w.id} {...d} onDragStart={(e) => (hideTip(), d.onDragStart(e))} className={`group relative flex w-full shrink-0 justify-center ${d.className}`}>
								<span
									className={`absolute top-1/2 left-0 w-1 -translate-y-1/2 rounded-r-full bg-neutral-900 transition-all ${active ? "h-7" : waiting?.unread ? "h-2 group-hover:h-3.5" : "h-0 group-hover:h-3.5"}`}
								/>
								<span className="relative" {...tipFor(w.name, i < 9 ? `${mod}${i + 1}` : undefined)}>
									<button
										type="button"
										aria-label={waiting?.mentions ? `${w.name}, ${waiting.mentions} unread mentions` : w.name}
										aria-current={active}
										onClick={() => !active && goTo(w.id)}
										className={`${shape} overflow-hidden ${active ? "rounded-xl" : "rounded-[18px] hover:rounded-xl"}`}
									>
										<Avatar name={w.name} image={w.image} agent className="pointer-events-none" />
									</button>
									{!!waiting?.mentions && (
										<span className="pointer-events-none absolute -right-1 -bottom-1 flex h-4 min-w-4 items-center justify-center rounded-full border-2 border-neutral-100 bg-red-500 px-0.5 text-[10px] leading-none font-semibold text-white">
											{waiting.mentions > 9 ? "9+" : waiting.mentions}
										</span>
									)}
								</span>
							</div>
						);
					})}
					{mine?.invitations.map((i) => (
						<span key={i.id} className="flex shrink-0" {...tipFor(`Invite to ${i.workspace}`)}>
							<Invite invite={i} onJoined={setJoined} />
						</span>
					))}
					<span className="flex shrink-0" {...tipFor("Create a workspace")}>
						<CreateWorkspace onCreated={setJoined} />
					</span>
				</div>
			</Scroll>
			{tip}
		</nav>
	);
}

type Invitation = { id: Id<"invites">; workspace: string; invitedBy: string | null };

/** An invite waits in the rail, dashed, until you join or decline it. Its errors stay in its own popover. */
function Invite({ invite, onJoined }: { invite: Invitation; onJoined: (id: Id<"workspaces">) => void }) {
	const accept = useMutation(api.workspace.acceptInvite);
	const decline = useMutation(api.workspace.declineInvite);
	const { error, run } = useRun();
	return (
		<Popover
			trigger={
				<>
					<span className="sr-only">Invite to {invite.workspace}</span>
					<span className="flex size-full items-center justify-center rounded-[inherit] border-2 border-dashed border-neutral-300 text-xs font-medium text-neutral-500">
						{invite.workspace.slice(0, 1).toUpperCase()}
					</span>
					<span className="absolute top-0 right-0 size-2.5 rounded-full border-2 border-neutral-100 bg-sky-500" />
				</>
			}
			className={`${shape} rounded-[18px] hover:rounded-xl`}
			panelClassName="flex w-56 flex-col gap-1.5 p-3"
		>
			<p className="text-xs text-neutral-700">
				{invite.invitedBy ? `${invite.invitedBy} invited you to ` : "You're invited to "}
				<span className="font-medium">{invite.workspace}</span>
			</p>
			<div className="flex gap-3 text-xs font-medium">
				<button type="button" onClick={() => run(accept({ id: invite.id }).then(onJoined))} className="text-sky-800 hover:underline">
					Join
				</button>
				<button type="button" onClick={() => run(decline({ id: invite.id }))} className="text-neutral-500 hover:underline">
					Decline
				</button>
			</div>
			{error && <Notice>{error}</Notice>}
		</Popover>
	);
}

/** + just under the workspaces: name a new workspace, which you'll own. */
function CreateWorkspace({ onCreated }: { onCreated: (id: Id<"workspaces">) => void }) {
	const create = useMutation(api.workspace.create);
	const [name, setName] = useState("");
	const { error, busy, run } = useRun();
	// A second Enter or click before the first answer would start a second workspace (and welcome);
	// `busy` only stops it once React has re-rendered.
	const sending = useRef(false);
	return (
		<Popover
			trigger={
				<>
					<span className="sr-only">Create a workspace</span>
					<PlusIcon size={18} />
				</>
			}
			className={`${shape} flex items-center justify-center rounded-[18px] border border-neutral-300 bg-white text-neutral-700 hover:rounded-xl hover:border-neutral-900 hover:bg-neutral-900 hover:text-white`}
			panelClassName="w-64 p-3"
		>
			{(close) => (
				<form
					className="flex flex-col gap-2"
					onSubmit={(e) => {
						e.preventDefault();
						if (sending.current || !name.trim()) return;
						sending.current = true;
						void run(create({ name }).then((id) => (onCreated(id), setName(""), close()))).finally(() => (sending.current = false));
					}}
				>
					<p className="font-medium">Create a workspace</p>
					<p className="text-xs text-neutral-500">For another business. You'll be its owner; invite people from Settings → Members.</p>
					<input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Business name" className={compactControlClass} />
					{error && <Notice>{error}</Notice>}
					<button type="submit" disabled={!name.trim() || busy} className={`${primaryButton} self-end`}>
						Create
					</button>
				</form>
			)}
		</Popover>
	);
}
