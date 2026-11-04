import { Checkbox } from "../controls";
import { type Access, type Permission, can, permissions, switches } from "@companybot/core/permissions";
import type { FunctionReturnType } from "convex/server";
import { useState } from "react";
import { api } from "../api";
import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import { useMutation, useQuery } from "../convex";
import { CaretUpDownIcon } from "../icons";
import { Form, Loading, Notice, RenameInput, Setting, Settings, Tabs, cardClass, compactControlClass, compactPrimaryButton, descriptionClass, metadataClass, toolbarClass, useRun } from "../ui";

import { Popover, useConfirm } from "./chat/common";

type Role = NonNullable<FunctionReturnType<typeof api.roles.list>>[number];

/** "change agents" → "Change agents": a switch's label in Settings. */
const switchLabel = (p: Permission) => permissions[p].label.charAt(0).toUpperCase() + permissions[p].label.slice(1);

/** Role ids as their names, in the workspace's order. */
export const roleNames = (roles: readonly Role[] | null | undefined, ids: readonly string[]) =>
	(roles ?? []).filter((r) => ids.includes(r.id)).map((r) => r.name);

export function MembersTab({ access }: { access: Access }) {
	const team = useQuery(api.workspace.team);
	const roles = useQuery(api.roles.list);
	const invite = useMutation(api.workspace.invite);
	const cancelInvite = useMutation(api.workspace.cancelInvite);
	const resendInvite = useMutation(api.workspace.resendInvite);
	const removeMember = useMutation(api.workspace.removeMember);
	const setRoles = useMutation(api.workspace.setRoles);
	const { confirm, dialog } = useConfirm();
	const [email, setEmail] = useState("");
	const [inviteRoles, setInviteRoles] = useState<Id<"roles">[]>();
	const [resent, setResent] = useState<string>();
	const [note, setNote] = useState<string>();
	const { error, run } = useRun();
	const canManage = can(access, "members.manage");

	if (!team || !roles) return <Loading />;
	const memberRole = roles.find((r) => r.builtIn === "member")!.id;
	const ownerRole = roles.find((r) => r.builtIn === "owner")!.id;
	const picked = inviteRoles ?? [memberRole];

	return (
		<>
			{dialog}
			<Notice>{error}</Notice>
			{note && <p className={descriptionClass}>{note}</p>}

			{canManage && (
				<Form
					className={toolbarClass}
					onSubmit={() => {
						run(
							invite({ email, roles: picked }).then(({ emailed }) => setNote(emailed ? undefined : `${email} got an invite email a few minutes ago, so we didn't send another.`)),
							() => (setEmail(""), setInviteRoles(undefined)),
						);
					}}
				>
					<input
						type="email"
						value={email}
						onChange={(e) => setEmail(e.target.value)}
						placeholder="teammate@company.com"
						className={`${compactControlClass} min-w-48 flex-1`}
					/>
					<RolePicker roles={roles} value={picked} canGiveOwner={access.owner} onChange={setInviteRoles} />
					<button type="submit" className={compactPrimaryButton}>
						Invite
					</button>
				</Form>
			)}

			<section className="flex flex-col gap-2">
				{team.members.map((m) => {
					// Only owners give or take Owner, so only they change an owner's roles.
					const editable = canManage && (access.owner || !m.roles.includes(ownerRole));
					return (
						<Row key={m.id} label={m.name} detail={m.name === m.email ? undefined : m.email} you={m.isYou}>
							{editable ? (
								<RolePicker roles={roles} value={m.roles} canGiveOwner={access.owner} onChange={(ids) => run(setRoles({ id: m.id, roles: ids }))} />
							) : (
								<span className="text-neutral-400">{roleNames(roles, m.roles).join(", ") || "No role"}</span>
							)}
							{editable && !m.isYou && (
								<button type="button" onClick={() => confirm({ title: `Remove ${m.name}?`, action: "Remove member", body: "They will lose access to this workspace, and their personal workspace data will be deleted.", onConfirm: () => removeMember({ id: m.id }) })} className="hover:text-red-600">
									Remove
								</button>
							)}
						</Row>
					);
				})}
				{team.invites.map((i) => (
					<Row key={i.id} label={i.email} detail={`Invited as ${roleNames(roles, i.roles).join(", ")} · hasn't joined yet`}>
						{resent === i.id ? (
							<span className="text-neutral-400">Sent</span>
						) : (
							<button type="button" onClick={() => run(resendInvite({ id: i.id }), () => setResent(i.id))} className="hover:text-neutral-900">
								Resend
							</button>
						)}
						<button type="button" onClick={() => confirm({ title: `Cancel the invitation to ${i.email}?`, action: "Cancel invitation", body: "They will no longer be able to join using this invitation.", onConfirm: () => cancelInvite({ id: i.id }) })} className="hover:text-red-600">
							Cancel
						</button>
					</Row>
				))}
			</section>

			<RolesSection roles={roles} canEdit={can(access, "roles.manage")} />
		</>
	);
}

/** Pick one or more roles. At least one stays picked; Owner only for owners to give. */
function RolePicker({ roles, value, canGiveOwner, onChange }: { roles: readonly Role[]; value: readonly string[]; canGiveOwner: boolean; onChange: (ids: Id<"roles">[]) => void }) {
	const names = roleNames(roles, value);
	return (
		<Popover
			label="Roles"
			matchWidth
			trigger={
				<>
					<span className="min-w-0 flex-1 truncate">{names.join(", ") || "No role"}</span>
					<CaretUpDownIcon className="shrink-0 text-neutral-400" />
				</>
			}
			className={`inline-flex max-w-56 items-center gap-1.5 text-left ${compactControlClass}`}
			panelClassName="flex w-56 flex-col gap-px p-1"
		>
			{roles.map((r) => {
				const on = value.includes(r.id);
				return (
					<label key={r.id} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-neutral-100 has-disabled:cursor-default has-disabled:text-neutral-400 has-disabled:hover:bg-transparent">
						<Checkbox
							checked={on}
							disabled={(r.builtIn === "owner" && !canGiveOwner) || (on && value.length === 1)}
							onChange={(checked) => onChange(checked ? [...(value as Id<"roles">[]), r.id] : (value as Id<"roles">[]).filter((id) => id !== r.id))}
						/>
						<span className="min-w-0 flex-1 truncate">{r.name}</span>
					</label>
				);
			})}
		</Popover>
	);
}

/**
 * The workspace's roles, one at a time: its switches, and (for owners) rename and delete. Owner
 * shows every switch on and can't change; Member is what new people get.
 */
function RolesSection({ roles, canEdit }: { roles: readonly Role[]; canEdit: boolean }) {
	const create = useMutation(api.roles.create);
	const rename = useMutation(api.roles.rename);
	const remove = useMutation(api.roles.remove);
	const setPermission = useMutation(api.roles.setPermission);
	const { confirm, dialog } = useConfirm();
	const { error, run } = useRun();
	const [openId, setOpenId] = useState<string>();
	const [name, setName] = useState("");
	const [renaming, setRenaming] = useState(false);
	const open = roles.find((r) => r.id === openId) ?? roles.find((r) => r.builtIn === "member")!;
	const fixed = open.builtIn === "owner";

	return (
		<section className="flex flex-col gap-3">
			{dialog}
			<div>
				<h2 className="font-medium">Roles</h2>
				<p className={descriptionClass}>People get every switch any of their roles has. Owners can do everything. New people get Member.</p>
			</div>
			<Notice>{error}</Notice>
			<Tabs tabs={roles.map((r) => ({ id: r.id, label: r.name }))} value={open.id} onChange={(id) => (setOpenId(id), setRenaming(false))} />
			{canEdit && !fixed && (
				<div className={toolbarClass}>
					{renaming ? (
						<RenameInput value={open.name} onSave={(next) => rename({ id: open.id, name: next })} onDone={() => setRenaming(false)} className={`${compactControlClass} w-48`} />
					) : (
						<button type="button" onClick={() => setRenaming(true)} className="text-neutral-500 hover:text-neutral-900">
							Rename
						</button>
					)}
					{!open.builtIn && (
						<button
							type="button"
							onClick={() =>
								confirm({
									title: `Delete ${open.name}?`,
									action: "Delete role",
									body: `${open.people === 1 ? "1 person loses it" : `${open.people} people lose it`}. Anyone left without a role keeps only shared reads, chat and personal items.`,
									onConfirm: () => remove({ id: open.id }).then(() => setOpenId(undefined)),
								})
							}
							className="text-neutral-500 hover:text-red-600"
						>
							Delete
						</button>
					)}
				</div>
			)}
			<Settings hint={fixed ? "Owners can do everything. This role can't be changed." : `${open.people === 1 ? "1 person has" : `${open.people} people have`} this role.`}>
				{switches.map((p) => (
					<Setting key={p} label={switchLabel(p)}>
						<Checkbox
							label={switchLabel(p)}
							checked={open.permissions.includes(p)}
							disabled={!canEdit || fixed}
							onChange={(on) => run(setPermission({ id: open.id as Id<"roles">, permission: p, on }))}
						/>
					</Setting>
				))}
			</Settings>
			{canEdit && (
				<Form className={toolbarClass} onSubmit={() => run(create({ name }).then(setOpenId), () => setName(""))}>
					<input value={name} onChange={(e) => setName(e.target.value)} placeholder="New role, like Office or Crew" className={`${compactControlClass} min-w-48 flex-1`} />
					<button type="submit" className={compactPrimaryButton} disabled={!name.trim()}>
						Add role
					</button>
				</Form>
			)}
		</section>
	);
}

function Row({ label, detail, you, children }: { label: string; detail?: string; you?: boolean; children?: React.ReactNode }) {
	return (
		<div className={`flex items-center gap-3 ${cardClass}`}>
			<span className="flex min-w-0 flex-1 flex-col">
				<span className="truncate">
					{label}
					{you && <span className={`ml-2 ${metadataClass}`}>You</span>}
				</span>
				{detail && <span className="truncate text-xs text-neutral-500">{detail}</span>}
			</span>
			<span className={`flex items-center gap-3 ${descriptionClass}`}>{children}</span>
		</div>
	);
}
