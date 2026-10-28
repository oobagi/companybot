import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import { useEffect, useState } from "react";
import { api } from "../api";
import { useMutation, useQuery, useWorkspace } from "../convex";
import { navigate } from "../router";
import { Notice, useRun } from "../ui";
import { Avatar, Popover } from "./chat/common";

/** Round until hovered or open, then a rounded square, as in Discord. */
const shape = "no-drag relative size-9 transition-all";

/** The strip at the far left: a logo per workspace you're in, then any invites. Click one to switch. */
export function WorkspaceRail() {
	const mine = useQuery(api.workspace.mine);
	const accept = useMutation(api.workspace.acceptInvite);
	const decline = useMutation(api.workspace.declineInvite);
	const { error, run } = useRun();
	const current = useWorkspace();
	// Chats and records belong to one workspace, so a switch starts from the chat list.
	const goTo = (workspaceId: Id<"workspaces">) => (current?.open(workspaceId), navigate("chat"));
	// A join resolves before the list shows the workspace, and opening one you're not in is refused,
	// so a joined workspace opens once it's listed.
	const [joined, setJoined] = useState<Id<"workspaces">>();
	useEffect(() => {
		if (joined && mine?.workspaces.some((w) => w.id === joined)) {
			setJoined(undefined);
			goTo(joined);
		}
	}, [joined, mine]);

	return (
		<nav className="drag flex w-[60px] shrink-0 flex-col items-center gap-2 border-r border-neutral-200 bg-neutral-100 pt-12 pb-3">
			{mine?.workspaces.map((w) => {
				const active = w.id === current?.id;
				return (
					<div key={w.id} className="group relative flex w-full justify-center">
						<span
							className={`absolute top-1/2 left-0 w-1 -translate-y-1/2 rounded-r-full bg-neutral-900 transition-all ${active ? "h-7" : "h-0 group-hover:h-3.5"}`}
						/>
						<button
							type="button"
							title={w.name}
							aria-label={w.name}
							aria-current={active}
							onClick={() => !active && goTo(w.id)}
							className={`${shape} overflow-hidden ${active ? "rounded-xl" : "rounded-[18px] hover:rounded-xl"}`}
						>
							<Avatar name={w.name} image={w.image} agent />
						</button>
					</div>
				);
			})}
			{mine?.invitations.map((i) => (
				<Popover
					key={i.id}
					label={`Invite to ${i.workspace}`}
					trigger={
						<>
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
			))}
		</nav>
	);
}
