import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import { useState } from "react";
import { api } from "../api";
import { useMutation, useQuery, useWorkspace } from "../convex";
import { navigate } from "../router";
import { Notice, useRun } from "../ui";
import { useDismiss } from "./chat/common";

/** The workspace name at the top of the sidebar: switch workspaces, answer invites, or leave. */
export function WorkspaceMenu({ name }: { name: string }) {
	const mine = useQuery(api.workspace.mine);
	const accept = useMutation(api.workspace.acceptInvite);
	const decline = useMutation(api.workspace.declineInvite);
	const leave = useMutation(api.workspace.leave);
	const [open, setOpen] = useState(false);
	const ref = useDismiss<HTMLDivElement>(() => setOpen(false), open);
	const { error, run } = useRun();
	const invitations = mine?.invitations ?? [];
	// Chats and records belong to one workspace, so a switch starts from the chat list.
	const opened = () => (setOpen(false), navigate("chat"));
	const current = useWorkspace();
	const goTo = (workspaceId: Id<"workspaces">) => (current?.open(workspaceId), opened());

	return (
		<div ref={ref} className="no-drag relative pb-4">
			<button
				type="button"
				onClick={() => setOpen(!open)}
				className="flex w-full items-center gap-1.5 rounded-lg px-2 py-1 text-left text-sm font-semibold hover:bg-neutral-100"
			>
				<span className="truncate">{name}</span>
				<span className="text-xs text-neutral-400">▾</span>
				{invitations.length > 0 && <span className="ml-auto size-2 shrink-0 rounded-full bg-sky-500" title="You have an invite" />}
			</button>
			{open && mine && (
				<div className="absolute top-full right-0 left-0 z-30 -mt-3 flex flex-col gap-px rounded-xl border border-neutral-200 bg-white p-1 text-sm shadow-lg">
					{mine.workspaces.map((w) => (
						<button
							type="button"
							key={w.id}
							onClick={() => (w.id === current?.id ? setOpen(false) : goTo(w.id))}
							className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-neutral-100"
						>
							<span className="flex-1 truncate">{w.name}</span>
							{w.id === current?.id && <span className="text-neutral-500">✓</span>}
						</button>
					))}
					{invitations.map((i) => (
						<div key={i.id} className="flex flex-col gap-1.5 rounded-lg bg-sky-50 px-2 py-2">
							<p className="text-xs text-sky-900">
								{i.invitedBy ? `${i.invitedBy} invited you to ` : "You're invited to "}
								<span className="font-medium">{i.workspace}</span>
							</p>
							<div className="flex gap-3 text-xs font-medium">
								<button type="button" onClick={() => run(accept({ id: i.id }).then(goTo))} className="text-sky-800 hover:underline">
									Join
								</button>
								<button type="button" onClick={() => run(decline({ id: i.id }))} className="text-neutral-500 hover:underline">
									Decline
								</button>
							</div>
						</div>
					))}
					{error && <Notice>{error}</Notice>}
					<button
						type="button"
						onClick={() => confirm(`Leave ${name}? You'll need a new invite to come back.`) && run(leave(), opened)}
						className="mt-1 rounded-lg border-t border-neutral-100 px-2 py-1.5 text-left text-red-600 hover:bg-red-50"
					>
						Leave {name}
					</button>
				</div>
			)}
		</div>
	);
}
