import { Checkbox } from "../controls";
import { type Access, type Permission, can, canGrantRole, permissions, switches } from "@companybot/core/permissions";
import type { FunctionReturnType } from "convex/server";
import { useState } from "react";
import { api } from "../api";
import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import { useMutation, useQuery } from "../convex";
import { CaretRightIcon, CaretUpDownIcon, CloseIcon, PaperPlaneTiltIcon, RolesIcon, TrashIcon, UserMinusIcon } from "../icons";
import { navigate } from "../router";
import { ConflictNotice, Form, Loading, NewButton, Notice, NotFound, Page, PageActions, SaveBar, Setting, Settings, barDangerButton, versionOf, cardClass, compactControlClass, descriptionClass, metadataClass, primaryButton, secondaryButton, useDraft, useRun, wideControlClass, cardButton } from "../ui";

import { DialogButtons, MenuItem, Modal, MoreMenu, Popover, useConfirm } from "./chat/common";

type Role = NonNullable<FunctionReturnType<typeof api.roles.list>>[number];

/** "change agents" → "Change agents": a switch's label in Settings. */
const switchLabel = (p: Permission) => permissions[p].label.charAt(0).toUpperCase() + permissions[p].label.slice(1);

/** Role ids as their names, in the workspace's order. */
export const roleNames = (roles: readonly Role[] | null | undefined, ids: readonly string[]) =>
	(roles ?? []).filter((r) => ids.includes(r.id)).map((r) => r.name);

/** The people in the workspace and pending invitations. Invite from the top bar; each row's ⋯ removes, resends or cancels. */
export function MembersTab({ access }: { access: Access }) {
	const team = useQuery(api.workspace.team);
	const roles = useQuery(api.roles.list);
	const cancelInvite = useMutation(api.workspace.cancelInvite);
	const resendInvite = useMutation(api.workspace.resendInvite);
	const removeMember = useMutation(api.workspace.removeMember);
	const setRoles = useMutation(api.workspace.setRoles);
	const { confirm, dialog } = useConfirm();
	const [inviting, setInviting] = useState(false);
	const [resent, setResent] = useState<string>();
	const [note, setNote] = useState<string>();
	const { error, run } = useRun();
	const canManage = can(access, "members.manage");

	if (!team || !roles) return <Loading />;
	const ownerRole = roles.find((r) => r.builtIn === "owner")!.id;
	const takable = (ids: readonly string[]) => roles.filter((r) => ids.includes(r.id)).every((r) => canGrantRole(access, r));

	return (
		<>
			{dialog}
			{canManage && (
				<PageActions>
					<NewButton label="Invite people" onClick={() => (setNote(undefined), setInviting(true))} />
				</PageActions>
			)}
			{inviting && <InviteDialog roles={roles} who={access} onNote={setNote} onClose={() => setInviting(false)} />}
			<Notice>{error}</Notice>
			{note && <p className={descriptionClass}>{note}</p>}

			<section className="flex flex-col gap-2">
				{team.members.map((m) => {
					// Only owners give or take Owner, so only they change an owner's roles, or their own.
					const editable = canManage && (access.owner || (!m.roles.includes(ownerRole) && !m.isYou));
					// Removing someone takes all their roles: only someone who could take each (the server checks too).
					const removable = editable && takable(m.roles) && !m.isYou;
					return (
						<Row key={m.id} label={m.name} detail={m.name === m.email ? undefined : m.email} you={m.isYou}>
							{editable ? (
								<RolePicker roles={roles} value={m.roles} who={access} onChange={(ids) => run(setRoles({ id: m.id, roles: ids }))} />
							) : (
								<span className="text-neutral-500">{roleNames(roles, m.roles).join(", ") || "No role"}</span>
							)}
							<RowMenu label={`More for ${m.name}`} hidden={!removable}>
								{(close) => (
									<MenuItem
										danger
										onClick={() => (close(), confirm({ title: `Remove ${m.name}?`, action: "Remove member", body: "They will lose access to this workspace, and their personal workspace data will be deleted.", onConfirm: () => removeMember({ id: m.id }) }))}
									>
										<UserMinusIcon /> Remove from workspace
									</MenuItem>
								)}
							</RowMenu>
						</Row>
					);
				})}
				{team.invites.map((i) => (
					<Row key={i.id} label={i.email} detail={resent === i.id ? "Invitation sent again" : "Hasn't joined yet"}>
						<span className="text-neutral-500">{roleNames(roles, i.roles).join(", ") || "No role"}</span>
						<RowMenu label={`More for ${i.email}`} hidden={!canManage}>
							{(close) => (
								<>
									<MenuItem onClick={() => (close(), run(resendInvite({ id: i.id }), () => setResent(i.id)))}>
										<PaperPlaneTiltIcon /> Resend invitation
									</MenuItem>
									{takable(i.roles) && (
										<MenuItem
											danger
											onClick={() => (close(), confirm({ title: `Cancel the invitation to ${i.email}?`, action: "Cancel invitation", body: "They will no longer be able to join using this invitation.", onConfirm: () => cancelInvite({ id: i.id }) }))}
										>
											<CloseIcon /> Cancel invitation
										</MenuItem>
									)}
								</>
							)}
						</RowMenu>
					</Row>
				))}
			</section>
		</>
	);
}

/** Invite someone by email, with the roles they'll join with (Member unless you pick others). */
function InviteDialog({ roles, who, onNote, onClose }: { roles: readonly Role[]; who: Access; onNote: (note: string | undefined) => void; onClose: () => void }) {
	const invite = useMutation(api.workspace.invite);
	const memberRole = roles.find((r) => r.builtIn === "member")!.id;
	const [email, setEmail] = useState("");
	const [picked, setPicked] = useState<Id<"roles">[]>([memberRole]);
	const { error, busy, run } = useRun();
	return (
		<Modal title="Invite people" onClose={onClose}>
			<p className={descriptionClass}>We email them a link to get the app. They join when they sign in with that email.</p>
			<Form
				onSubmit={() =>
					run(
						invite({ email, roles: picked }).then(({ emailed }) => onNote(emailed ? undefined : `${email} got an invite email a few minutes ago, so we didn't send another.`)),
						onClose,
					)
				}
			>
				<Settings>
					<Setting label="Email">
						<input autoFocus aria-label="Email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="teammate@company.com" className={wideControlClass} />
					</Setting>
					<Setting label="Roles" hint="Member unless you pick others.">
						<RolePicker roles={roles} value={picked} who={who} onChange={setPicked} wide />
					</Setting>
				</Settings>
				<Notice>{error}</Notice>
				<DialogButtons>
					<button type="button" onClick={onClose} className={secondaryButton}>
						Cancel
					</button>
					<button type="submit" disabled={busy || !email.trim()} className={primaryButton}>
						Invite
					</button>
				</DialogButtons>
			</Form>
		</Modal>
	);
}

/** A row's ⋯ menu; none when there's nothing in it for you. */
function RowMenu({ label, hidden, children }: { label: string; hidden?: boolean; children: (close: () => void) => React.ReactNode }) {
	return hidden ? null : <MoreMenu label={label}>{children}</MoreMenu>;
}

/** Pick one or more roles. At least one stays picked; only roles `who` may give or take (Owner only for owners). */
function RolePicker({ roles, value, who, onChange, wide }: { roles: readonly Role[]; value: readonly string[]; who: Access; onChange: (ids: Id<"roles">[]) => void; wide?: boolean }) {
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
			className={wide ? `flex items-center gap-1.5 text-left ${wideControlClass}` : `inline-flex max-w-56 items-center gap-1.5 text-left ${compactControlClass}`}
			panelClassName="flex w-56 flex-col gap-px p-1"
		>
			{roles.map((r) => {
				const on = value.includes(r.id);
				const grantable = canGrantRole(who, r);
				return (
					<label key={r.id} title={grantable ? undefined : "Only Owners and people who have this role can give or take it."} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-neutral-100 has-disabled:cursor-default has-disabled:text-neutral-400 has-disabled:hover:bg-transparent">
						<Checkbox
							checked={on}
							disabled={!grantable || (on && value.length === 1)}
							onChange={(checked) => onChange(checked ? [...(value as Id<"roles">[]), r.id] : (value as Id<"roles">[]).filter((id) => id !== r.id))}
						/>
						<span className="min-w-0 flex-1 truncate">{r.name}</span>
					</label>
				);
			})}
		</Popover>
	);
}

/** "6 of 14 switches", or what's special about a built-in role. */
const roleSummary = (r: Role) =>
	r.builtIn === "owner" ? "Can do everything" : `${r.permissions.filter((p) => switches.includes(p)).length} of ${switches.length} switches on${r.builtIn === "member" ? " · New people get it" : ""}`;
const peopleLabel = (n: number) => (n === 1 ? "1 person" : `${n} people`);

/** Settings → Roles: every role, with who has it; open one to change its switches. New role in the top bar. */
export function RolesTab({ access }: { access: Access }) {
	const roles = useQuery(api.roles.list);
	const publicRole = useQuery(api.roles.publicRole);
	const [creating, setCreating] = useState(false);
	if (!roles || !publicRole) return <Loading />;
	return (
		<>
			{can(access, "roles.manage") && (
				<PageActions>
					<NewButton label="New role" onClick={() => setCreating(true)} />
				</PageActions>
			)}
			{creating && <NewRoleDialog onClose={() => setCreating(false)} />}
			<section className="flex flex-col gap-2">
				{roles.map((r) => (
					<button key={r.id} type="button" onClick={() => navigate("settings", "roles", r.id)} className={`items-center gap-3 ${cardButton}`}>
						<span className="flex min-w-0 flex-1 flex-col">
							<span className="truncate font-medium">{r.name}</span>
							<span className="truncate text-xs text-neutral-500">{roleSummary(r)}</span>
						</span>
						<span className={descriptionClass}>{peopleLabel(r.people)}</span>
						<CaretRightIcon className="text-neutral-400" />
					</button>
				))}
				<button type="button" onClick={() => navigate("settings", "roles", "public")} className={`items-center gap-3 ${cardButton}`}>
					<span className="flex min-w-0 flex-1 flex-col">
						<span className="truncate font-medium">Public</span>
						<span className="truncate text-xs text-neutral-500">{publicSummary(publicRole.abilities)}</span>
					</span>
					<span className={descriptionClass}>Customers</span>
					<CaretRightIcon className="text-neutral-400" />
				</button>
			</section>
		</>
	);
}

function NewRoleDialog({ onClose }: { onClose: () => void }) {
	const create = useMutation(api.roles.create);
	const [name, setName] = useState("");
	const { error, busy, run } = useRun();
	return (
		<Modal title="New role" onClose={onClose}>
			<Form onSubmit={() => run(create({ name }).then((id) => navigate("settings", "roles", id)), onClose)}>
				<Settings>
					<Setting label="Name" hint="Starts with every switch off. You turn on what it can do next.">
						<input autoFocus aria-label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Office, Crew…" className={wideControlClass} />
					</Setting>
				</Settings>
				<Notice>{error}</Notice>
				<DialogButtons>
					<button type="button" onClick={onClose} className={secondaryButton}>
						Cancel
					</button>
					<button type="submit" disabled={busy || !name.trim()} className={primaryButton}>
						Create role
					</button>
				</DialogButtons>
			</Form>
		</Modal>
	);
}

/** One role: its name and switches, saved together from the top bar like an agent. Owner can't change. */
export function RoleScreen({ access, roleId }: { access: Access; roleId: string }) {
	const roles = useQuery(api.roles.list);
	const crumbs = [{ label: "Roles", to: ["settings", "roles"] }];
	if (roleId === "public") return <PublicRoleForm crumbs={crumbs} canEdit={can(access, "roles.manage")} />;
	if (!roles) return <NotFound crumbs={crumbs} loaded={false} icon={<RolesIcon />} title="Role not found" />;
	const role = roles.find((r) => r.id === roleId);
	if (!role) return <NotFound crumbs={crumbs} loaded icon={<RolesIcon />} title="Role not found" children="It may have been deleted." />;
	return <RoleForm key={role.id} role={role} crumbs={crumbs} canEdit={can(access, "roles.manage") && role.builtIn !== "owner"} />;
}

type RoleConfig = { name: string; on: Permission[] };
/** The draft keeps `start`, the role as it was when you began editing, so Save sends only what you changed. */
type RoleDraft = RoleConfig & { start: RoleConfig };
/** Roles have no version number; the draft notices someone else's save by what changed. */

function RoleForm({ role, crumbs, canEdit }: { role: Role; crumbs: { label: string; to: string[] }[]; canEdit: boolean }) {
	const rename = useMutation(api.roles.rename);
	const remove = useMutation(api.roles.remove);
	const setPermission = useMutation(api.roles.setPermission);
	const { confirm, dialog } = useConfirm();
	const { error, run } = useRun();
	const fixed = role.builtIn === "owner";
	const saved: RoleConfig = { name: role.name, on: switches.filter((p) => role.permissions.includes(p)) };
	const draft = useDraft<RoleDraft>(`role:${role.id}`, { ...saved, start: saved }, versionOf(saved));
	const value = draft.value;
	const toggle = (p: Permission, on: boolean) => draft.set({ ...value, on: on ? [...value.on, p] : value.on.filter((x) => x !== p) });
	// Only what you changed since you began is sent, one switch at a time, so someone else's other
	// changes stay. If they saved meanwhile, Save waits until you pick theirs or yours (ConflictNotice).
	const save = async () => {
		const { start } = value;
		if (value.name.trim() !== start.name) await rename({ id: role.id, name: value.name });
		for (const p of switches) {
			const on = value.on.includes(p);
			if (on !== start.on.includes(p)) await setPermission({ id: role.id as Id<"roles">, permission: p, on });
		}
	};
	return (
		<Page
			title={role.name}
			crumbs={crumbs}
			description={fixed ? "Can do everything" : `${peopleLabel(role.people)}${role.builtIn === "member" ? " · new people get it" : ""}`}
			actions={
				canEdit &&
				!role.builtIn && (
					<button
						type="button"
						onClick={() =>
							confirm({
								title: `Delete ${role.name}?`,
								action: "Delete role",
								body: `${role.people === 1 ? "1 person loses it" : `${role.people} people lose it`}. Anyone left without a role keeps only shared reads, chat and personal items.${role.invited ? ` ${role.invited === 1 ? "1 pending invite gives it" : `${role.invited} pending invites give it`}: anyone it was their only role joins as Member.` : ""}`,
								onConfirm: () => remove({ id: role.id }).then(() => (draft.discard(), navigate("settings", "roles"))),
							})
						}
						className={barDangerButton}
					>
						<TrashIcon /> Delete
					</button>
				)
			}
		>
			{dialog}
			{canEdit && <SaveBar dirty={draft.dirty} canSave={!draft.stale} onSave={() => run(save(), draft.discard)} onDiscard={draft.discard} />}
			<ConflictNotice draft={draft} />
			<Notice>{error}</Notice>
			<Settings>
				<Setting label="Name">
					<input aria-label="Name" value={value.name} disabled={!canEdit} onChange={(e) => draft.set({ ...value, name: e.target.value })} className={wideControlClass} />
				</Setting>
			</Settings>
			<Settings title="What it can do" note={fixed ? undefined : "People get every switch any of their roles has."}>
				{switches.map((p) => (
					<Setting key={p} label={switchLabel(p)}>
						<Checkbox label={switchLabel(p)} checked={fixed || value.on.includes(p)} disabled={!canEdit} onChange={(on) => toggle(p, on)} />
					</Setting>
				))}
			</Settings>
		</Page>
	);
}

type Ability = NonNullable<FunctionReturnType<typeof api.roles.publicRole>>["abilities"][number];
const publicSummary = (abilities: readonly Ability[]) => `Anyone outside who emails or texts an agent · ${abilities.filter((a) => a.on).length} of ${abilities.length} on`;

/**
 * The Public role: what agents may do for people outside the workspace. It's nobody's to hold and
 * can't be deleted; owners switch its customer-safe abilities, and staff powers never appear here.
 */
function PublicRoleForm({ crumbs, canEdit }: { crumbs: { label: string; to: string[] }[]; canEdit: boolean }) {
	const role = useQuery(api.roles.publicRole);
	if (!role) return <NotFound crumbs={crumbs} loaded={false} icon={<RolesIcon />} title="Role not found" />;
	return <PublicAbilities abilities={role.abilities} crumbs={crumbs} canEdit={canEdit} />;
}

const sentenceCase = (label: string) => label.charAt(0).toUpperCase() + label.slice(1);

function PublicAbilities({ abilities, crumbs, canEdit }: { abilities: readonly Ability[]; crumbs: { label: string; to: string[] }[]; canEdit: boolean }) {
	const setAbility = useMutation(api.roles.setPublicAbility);
	const saved = abilities.filter((a) => a.on).map((a) => a.id as string);
	const draft = useDraft<{ on: string[]; start: string[] }>("role:public", { on: saved, start: saved }, versionOf(saved));
	const { error, run } = useRun();
	const value = draft.value;
	// Only what you changed since you began is sent, one ability at a time, like a role's switches.
	const save = async () => {
		for (const a of abilities) {
			const on = value.on.includes(a.id);
			if (on !== value.start.includes(a.id)) await setAbility({ ability: a.id, on });
		}
	};
	return (
		<Page title="Public" crumbs={crumbs} description="Anyone outside who reaches an agent">
			{canEdit && <SaveBar dirty={draft.dirty} canSave={!draft.stale} onSave={() => run(save(), draft.discard)} onDiscard={draft.discard} />}
			<ConflictNotice draft={draft} />
			<Notice>{error}</Notice>
			<Settings title="What agents can do for them" note="Agents always answer customers. To let them use a page or database, add Public to its Who can access list: View, or Add in a database. Staff powers, like Edit anywhere, chat, money and settings, never apply to Public.">
				{abilities.map((a) => (
					<Setting key={a.id} label={sentenceCase(a.label)}>
						<Checkbox
							label={sentenceCase(a.label)}
							checked={value.on.includes(a.id)}
							disabled={!canEdit}
							onChange={(on) => draft.set({ ...value, on: on ? [...value.on, a.id] : value.on.filter((x) => x !== a.id) })}
						/>
					</Setting>
				))}
			</Settings>
		</Page>
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
