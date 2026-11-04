import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { useMutation, useQuery, useWorkspace } from "../convex";
import { CaretDownIcon, CheckIcon, PlusIcon, SettingsIcon, SignOutIcon } from "../icons";
import { navigate } from "../router";
import { useSortable } from "../sortable";
import { Field, Form, MenuDivider, Notice, inputClass, primaryButton, useRun } from "../ui";
import { Avatar, MenuItem, Modal, Popover, useConfirm } from "./chat/common";

const none: never[] = [];
const workspaceKey = (w: { id: string }) => w.id;

/** ⌘1–9 (Ctrl elsewhere) opens the workspace at that place in the list. */
const mod = navigator.userAgent.includes("Mac") ? "⌘" : "Ctrl+";

/** A red count of chats with an unread @mention or DM. */
function Mentions({ count }: { count: number }) {
	return (
		<span className="flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] leading-none font-semibold text-white">
			{count > 9 ? "9+" : count}
		</span>
	);
}

/** Every row's leading picture or icon sits in the same 22px slot as the sidebar's (`Item`), so labels line up. */
function Slot({ danger, children }: { danger?: boolean; children: React.ReactNode }) {
	return <span className={`flex size-[22px] shrink-0 items-center justify-center text-lg ${danger ? "" : "text-neutral-500"}`}>{children}</span>;
}

/** Something new: an unread chat or an invite. */
const dot = <span className="size-1.5 shrink-0 rounded-full bg-sky-500" />;

/**
 * The open workspace, in the title bar beside Back and Forward. Its menu lists every workspace you're
 * in, in your order (drag to reorder; ⌘1–9 follow it), with what's waiting in each, then invites to
 * join or decline, + New workspace, and this workspace's settings or Leave. While closed it shows a
 * red count when other workspaces have mentions or DMs, else a dot when one is unread or invites wait.
 */
export function WorkspaceSwitcher({ name, onSettings }: { name: string; onSettings: () => void }) {
	const mine = useQuery(api.workspace.mine);
	const activity = useQuery(api.workspace.activity);
	const current = useWorkspace();
	const leave = useMutation(api.workspace.leave);
	const { confirm, dialog } = useConfirm();
	const { sorted: workspaces, drag } = useSortable("rail.order", mine?.workspaces ?? none, workspaceKey);
	// Chats and records belong to one workspace, so a switch starts from the chat list.
	const goTo = (workspaceId: Id<"workspaces">) => (current?.open(workspaceId), navigate("chat"));
	// A join or create resolves before the list shows the workspace, and opening one you're not in is
	// refused, so it opens once it's listed.
	const [joined, setJoined] = useState<Id<"workspaces">>();
	const [creating, setCreating] = useState(false);
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

	const others = activity?.filter((a) => a.id !== current?.id) ?? [];
	const mentions = others.reduce((n, a) => n + a.mentions, 0);
	const news = others.some((a) => a.unread) || !!mine?.invitations.length;
	const image = mine?.workspaces.find((w) => w.id === current?.id)?.image;

	return (
		<>
			<Popover
				trigger={
					<>
						<Avatar name={name} image={image} agent size="xs" className="pointer-events-none" />
						<span className="truncate">{name}</span>
						{mentions > 0 ? <Mentions count={mentions} /> : news && dot}
						<CaretDownIcon className="shrink-0 text-neutral-400" />
					</>
				}
				className="no-drag ml-1.5 flex min-w-0 items-center gap-1.5 rounded-md py-0.5 pr-1.5 pl-0.5 text-sm font-semibold hover:bg-neutral-200/70 aria-expanded:bg-neutral-200/70"
				panelClassName="flex w-64 flex-col gap-px p-1"
			>
				{(close) => (
					<>
						{workspaces.map((w, i) => {
							const active = w.id === current?.id;
							const waiting = active ? undefined : activity?.find((a) => a.id === w.id);
							const d = drag(w.id);
							return (
								<div key={w.id} {...d} className={`relative ${d.className}`}>
									<button
										type="button"
										aria-current={active}
										aria-label={waiting?.mentions ? `${w.name}, ${waiting.mentions} unread mentions` : w.name}
										onClick={() => (close(), !active && goTo(w.id))}
										className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-neutral-100"
									>
										<Slot>
											<Avatar name={w.name} image={w.image} agent size="row" className="pointer-events-none" />
										</Slot>
										<span className={`min-w-0 flex-1 truncate ${active ? "font-medium" : ""}`}>{w.name}</span>
										{waiting?.mentions ? <Mentions count={waiting.mentions} /> : waiting?.unread && dot}
										{active ? <CheckIcon className="shrink-0 text-neutral-500" /> : i < 9 && <span className="shrink-0 text-xs text-neutral-400">{`${mod}${i + 1}`}</span>}
									</button>
								</div>
							);
						})}
						{mine?.invitations.map((i) => <Invite key={i.id} invite={i} onJoined={setJoined} />)}
						<MenuItem onClick={() => (close(), setCreating(true))}>
							<Slot>
								<PlusIcon />
							</Slot>
							New workspace
						</MenuItem>
						<MenuDivider />
						<MenuItem onClick={() => (close(), onSettings())}>
							<Slot>
								<SettingsIcon />
							</Slot>
							Workspace settings
						</MenuItem>
						<MenuItem
							danger
							onClick={() => (
								close(),
								confirm({ title: `Leave ${name}?`, action: "Leave", body: "You'll need a new invite to come back.", onConfirm: () => leave().then(() => navigate("chat")) })
							)}
						>
							<Slot danger>
								<SignOutIcon />
							</Slot>
							Leave {name}
						</MenuItem>
					</>
				)}
			</Popover>
			{dialog}
			{creating && <NewWorkspace onClose={() => setCreating(false)} onCreated={setJoined} />}
		</>
	);
}

type Invitation = { id: Id<"invites">; workspace: string; invitedBy: string | null };

/** An invite waits in the menu, dashed, until you join or decline it. Its errors show under it. */
function Invite({ invite, onJoined }: { invite: Invitation; onJoined: (id: Id<"workspaces">) => void }) {
	const accept = useMutation(api.workspace.acceptInvite);
	const decline = useMutation(api.workspace.declineInvite);
	const { error, run } = useRun();
	return (
		<div className="flex flex-col gap-1 rounded-lg px-2 py-1.5">
			<div className="flex items-center gap-2">
				<Slot>
					<span className="flex size-[22px] items-center justify-center rounded-md border border-dashed border-neutral-300 text-[10px] font-medium">
						{invite.workspace.slice(0, 1).toUpperCase()}
					</span>
				</Slot>
				<span className="min-w-0 flex-1 truncate text-neutral-700">
					{invite.invitedBy ? `${invite.invitedBy} invited you to ` : "You're invited to "}
					<span className="font-medium">{invite.workspace}</span>
				</span>
				{dot}
			</div>
			<div className="flex gap-3 pl-[30px] text-xs font-medium">
				<button type="button" onClick={() => run(accept({ id: invite.id }).then(onJoined))} className="text-sky-800 hover:underline">
					Join
				</button>
				<button type="button" onClick={() => run(decline({ id: invite.id }))} className="text-neutral-500 hover:underline">
					Decline
				</button>
			</div>
			{error && <Notice>{error}</Notice>}
		</div>
	);
}

/** From New workspace: name a new workspace, which you'll own. Like New database. */
function NewWorkspace({ onClose, onCreated }: { onClose: () => void; onCreated: (id: Id<"workspaces">) => void }) {
	const create = useMutation(api.workspace.create);
	const [name, setName] = useState("");
	const { error, busy, run } = useRun();
	// A second Enter or click before the first answer would start a second workspace (and welcome);
	// `busy` only stops it once React has re-rendered.
	const sending = useRef(false);
	return (
		<Modal title="New workspace" onClose={onClose}>
			<Form
				onSubmit={() => {
					if (sending.current || !name.trim()) return;
					sending.current = true;
					void run(create({ name }).then((id) => (onCreated(id), onClose()))).finally(() => (sending.current = false));
				}}
			>
				<Notice>{error}</Notice>
				<Field label="Name">
					<input autoFocus value={name} onChange={(e) => setName(e.target.value)} className={inputClass} />
				</Field>
				<button type="submit" disabled={!name.trim() || busy} className={`${primaryButton} self-start`}>
					Create workspace
				</button>
			</Form>
		</Modal>
	);
}
