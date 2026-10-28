import { api } from "../api";
import { useMutation } from "../convex";
import { CaretDownIcon } from "../icons";
import { navigate } from "../router";
import { Notice, useRun } from "../ui";
import { Avatar, MenuItem, Popover } from "./chat/common";

/** The workspace name at the top of the sidebar: leave it. Switching and invites are in the rail (WorkspaceRail). */
export function WorkspaceMenu({ name, logo }: { name: string; logo: string | null }) {
	const leave = useMutation(api.workspace.leave);
	const { error, run } = useRun();

	return (
		<div className="no-drag flex">
			<Popover
				trigger={
					<>
						{/* The size of the sidebar's icons, so the name lines up with the labels below. */}
						<Avatar name={name} image={logo} agent size="xs" />
						<span className="truncate">{name}</span>
						<CaretDownIcon className="shrink-0 text-neutral-400" />
					</>
				}
				className="flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-sm font-semibold hover:bg-neutral-100"
				panelClassName="flex w-56 flex-col gap-px p-1"
			>
				{(close) => (
					<>
						{error && <Notice>{error}</Notice>}
						<MenuItem danger onClick={() => confirm(`Leave ${name}? You'll need a new invite to come back.`) && run(leave(), () => (close(), navigate("chat")))}>
							Leave {name}
						</MenuItem>
					</>
				)}
			</Popover>
		</div>
	);
}
