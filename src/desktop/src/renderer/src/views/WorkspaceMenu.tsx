import { api } from "../api";
import { useMutation } from "../convex";
import { CaretDownIcon, SettingsIcon } from "../icons";
import { navigate } from "../router";
import { MenuDivider } from "../ui";
import { MenuItem, Popover, useConfirm } from "./chat/common";

/**
 * The workspace name at the top of the sidebar: its settings, or leave it. Its logo, switching and
 * invites are in the rail (WorkspaceRail); your own settings are under your avatar there.
 */
export function WorkspaceMenu({ name, onSettings }: { name: string; onSettings: () => void }) {
	const leave = useMutation(api.workspace.leave);
	const { confirm, dialog } = useConfirm();

	return (
		<div className="no-drag flex">
			<Popover
				trigger={
					<>
						<span className="truncate">{name}</span>
						<CaretDownIcon className="shrink-0 text-neutral-400" />
					</>
				}
				className="flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-sm font-semibold hover:bg-neutral-100"
				panelClassName="flex w-56 flex-col gap-px p-1"
			>
				{(close) => (
					<>
						<MenuItem onClick={() => (close(), onSettings())}>
							<SettingsIcon className="text-neutral-500" /> Workspace settings
						</MenuItem>
						<MenuDivider />
						<MenuItem
							danger
							onClick={() => (
								close(),
								confirm({ title: `Leave ${name}?`, action: "Leave", body: "You'll need a new invite to come back.", onConfirm: () => leave().then(() => navigate("chat")) })
							)}
						>
							Leave {name}
						</MenuItem>
					</>
				)}
			</Popover>
			{dialog}
		</div>
	);
}
