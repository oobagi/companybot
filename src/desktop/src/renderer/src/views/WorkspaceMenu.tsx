import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import { api } from "../api";
import { useMutation, useQuery, useWorkspace } from "../convex";
import { CaretDownIcon, CheckIcon } from "../icons";
import { navigate } from "../router";
import { Notice, useRun } from "../ui";
import { MenuItem, Popover } from "./chat/common";

/** The workspace name at the top of the sidebar: switch workspaces, answer invites, or leave. */
export function WorkspaceMenu({ name }: { name: string }) {
	const mine = useQuery(api.workspace.mine);
	const accept = useMutation(api.workspace.acceptInvite);
	const decline = useMutation(api.workspace.declineInvite);
	const leave = useMutation(api.workspace.leave);
	const { error, run } = useRun();
	const invitations = mine?.invitations ?? [];
	const current = useWorkspace();

	return (
		<div className="no-drag flex">
			<Popover
				trigger={
					<>
						<span className="truncate">{name}</span>
						<CaretDownIcon className="shrink-0 text-neutral-400" />
						{invitations.length > 0 && <span className="ml-auto size-2 shrink-0 rounded-full bg-sky-500" title="You have an invite" />}
					</>
				}
				className="flex w-full items-center gap-1.5 rounded-lg px-2 py-1 text-left text-sm font-semibold hover:bg-neutral-100"
				panelClassName="flex w-56 flex-col gap-px p-1"
			>
				{(close) => {
					// Chats and records belong to one workspace, so a switch starts from the chat list.
					const opened = () => (close(), navigate("chat"));
					const goTo = (workspaceId: Id<"workspaces">) => (current?.open(workspaceId), opened());
					return (
						<>
							{mine?.workspaces.map((w) => (
								<MenuItem key={w.id} onClick={() => (w.id === current?.id ? close() : goTo(w.id))}>
									<span className="flex-1 truncate">{w.name}</span>
									{w.id === current?.id && <CheckIcon className="text-neutral-500" />}
								</MenuItem>
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
							<div className="my-1 border-t border-neutral-100" />
							<MenuItem danger onClick={() => confirm(`Leave ${name}? You'll need a new invite to come back.`) && run(leave(), opened)}>
								Leave {name}
							</MenuItem>
						</>
					);
				}}
			</Popover>
		</div>
	);
}
