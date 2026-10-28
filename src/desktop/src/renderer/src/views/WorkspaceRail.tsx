import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import { useEffect, useState } from "react";
import { api } from "../api";
import { useMutation, useQuery, useWorkspace } from "../convex";
import { PlusIcon } from "../icons";
import { navigate } from "../router";
import { Notice, compactControlClass, primaryButton, useRun } from "../ui";
import { Avatar, Popover } from "./chat/common";

/** Round until hovered or open, then a rounded square, as in Discord. */
const shape = "no-drag relative size-9 transition-all";

/** ⌘1–9 (Ctrl elsewhere) opens the workspace at that place in the rail. */
const mod = navigator.userAgent.includes("Mac") ? "⌘" : "Ctrl+";

/**
 * The strip at the far left: a logo per workspace you're in, then any invites, then + to start one.
 * Click one, or press ⌘ and its number, to switch. Others show what's waiting in them.
 */
export function WorkspaceRail() {
	const mine = useQuery(api.workspace.mine);
	const activity = useQuery(api.workspace.activity);
	const accept = useMutation(api.workspace.acceptInvite);
	const decline = useMutation(api.workspace.declineInvite);
	const create = useMutation(api.workspace.create);
	const [name, setName] = useState("");
	const { error, run } = useRun();
	const current = useWorkspace();
	// The name beside whatever's hovered, at once (a title waits a second and can't be styled).
	const [tip, setTip] = useState<{ label: string; hint?: string; top: number }>();
	const tipFor = (label: string, hint?: string) => ({
		onMouseEnter: (e: React.MouseEvent<HTMLElement>) => {
			const box = e.currentTarget.getBoundingClientRect();
			setTip({ label, hint, top: box.top + box.height / 2 });
		},
		onMouseLeave: () => setTip(undefined),
		onMouseDown: () => setTip(undefined),
	});
	// Chats and records belong to one workspace, so a switch starts from the chat list.
	const goTo = (workspaceId: Id<"workspaces">) => (setTip(undefined), current?.open(workspaceId), navigate("chat"));
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
			const w = mine?.workspaces[Number(e.key) - 1];
			if (!w) return;
			e.preventDefault();
			if (w.id !== current?.id) goTo(w.id);
		};
		window.addEventListener("keydown", key);
		return () => window.removeEventListener("keydown", key);
	}, [mine, current]);

	return (
		<nav className="drag flex w-[60px] shrink-0 flex-col items-center gap-2 border-r border-neutral-200 bg-neutral-100 pt-12 pb-3">
			{mine?.workspaces.map((w, i) => {
				const active = w.id === current?.id;
				const waiting = active ? undefined : activity?.find((a) => a.id === w.id);
				return (
					<div key={w.id} className="group relative flex w-full justify-center">
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
				<span key={i.id} className="flex" {...tipFor(`Invite to ${i.workspace}`)}>
					<Popover
						trigger={
							<>
								<span className="sr-only">Invite to {i.workspace}</span>
								<span className="flex size-full items-center justify-center rounded-[inherit] border-2 border-dashed border-neutral-300 text-xs font-medium text-neutral-500">
									{i.workspace.slice(0, 1).toUpperCase()}
								</span>
								<span className="absolute top-0 right-0 size-2.5 rounded-full border-2 border-neutral-100 bg-sky-500" />
							</>
						}
						className={`${shape} rounded-[18px] hover:rounded-xl`}
						panelClassName="flex w-56 flex-col gap-1.5 p-3"
					>
						<p className="text-xs text-neutral-700">
							{i.invitedBy ? `${i.invitedBy} invited you to ` : "You're invited to "}
							<span className="font-medium">{i.workspace}</span>
						</p>
						<div className="flex gap-3 text-xs font-medium">
							<button type="button" onClick={() => run(accept({ id: i.id }).then(setJoined))} className="text-sky-800 hover:underline">
								Join
							</button>
							<button type="button" onClick={() => run(decline({ id: i.id }))} className="text-neutral-500 hover:underline">
								Decline
							</button>
						</div>
						{error && <Notice>{error}</Notice>}
					</Popover>
				</span>
			))}
			<span className="flex" {...tipFor("Create a workspace")}>
				<Popover
					trigger={
						<>
							<span className="sr-only">Create a workspace</span>
							<PlusIcon size={18} />
						</>
					}
					className={`${shape} flex items-center justify-center rounded-[18px] bg-white text-neutral-500 hover:rounded-xl hover:bg-neutral-900 hover:text-white`}
					panelClassName="w-64 p-3"
				>
					{(close) => (
						<form
							className="flex flex-col gap-2"
							onSubmit={(e) => {
								e.preventDefault();
								run(create({ name }).then((id) => (setJoined(id), setName(""), close())));
							}}
						>
							<p className="font-medium">Create a workspace</p>
							<p className="text-xs text-neutral-500">For another business. You'll be its owner; invite people from Settings → Members.</p>
							<input
								autoFocus
								value={name}
								onChange={(e) => setName(e.target.value)}
								placeholder="Business name"
								className={compactControlClass}
							/>
							{error && <Notice>{error}</Notice>}
							<button type="submit" disabled={!name.trim()} className={`${primaryButton} self-end`}>
								Create
							</button>
						</form>
					)}
				</Popover>
			</span>
			{tip && (
				<div
					style={{ top: tip.top }}
					className="pointer-events-none fixed left-[64px] z-50 flex -translate-y-1/2 gap-2 rounded-md bg-neutral-900 px-2 py-1 text-xs font-medium whitespace-nowrap text-white shadow-lg"
				>
					{tip.label}
					{tip.hint && <span className="text-neutral-400">{tip.hint}</span>}
				</div>
			)}
		</nav>
	);
}
