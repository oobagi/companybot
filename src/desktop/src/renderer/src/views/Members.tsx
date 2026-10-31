import { Select } from "../controls";
import { type Role, can } from "@companybot/core/permissions";
import { useState } from "react";
import { api } from "../api";
import { useMutation, useQuery } from "../convex";
import { Form, Loading, Notice, cardClass, compactControlClass, compactPrimaryButton, descriptionClass, metadataClass, toolbarClass, useRun } from "../ui";

import { useConfirm } from "./chat/common";

export function MembersTab({ role }: { role: Role }) {
	const team = useQuery(api.workspace.team);
	const invite = useMutation(api.workspace.invite);
	const cancelInvite = useMutation(api.workspace.cancelInvite);
	const resendInvite = useMutation(api.workspace.resendInvite);
	const removeMember = useMutation(api.workspace.removeMember);
	const { confirm, dialog } = useConfirm();
	const setRole = useMutation(api.workspace.setRole);
	const [email, setEmail] = useState("");
	const [inviteRole, setInviteRole] = useState<Role>("member");
	const [resent, setResent] = useState<string>();
	const [note, setNote] = useState<string>();
	const { error, run } = useRun();
	const isOwner = can(role, "members.manage");

	if (!team) return <Loading />;

	return (
		<>
			{dialog}
			<Notice>{error}</Notice>
			{note && <p className={descriptionClass}>{note}</p>}

			{isOwner && (
				<Form
					className={toolbarClass}
					onSubmit={() => {
						run(
							invite({ email, role: inviteRole }).then(({ emailed }) => setNote(emailed ? undefined : `${email} got an invite email a few minutes ago, so we didn't send another.`)),
							() => setEmail(""),
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
					<RoleSelect value={inviteRole} onChange={setInviteRole} />
					<button type="submit" className={compactPrimaryButton}>
						Invite
					</button>
				</Form>
			)}

			<section className="flex flex-col gap-2">
				{team.members.map((m) => (
					<Row key={m.id} label={m.name} detail={m.name === m.email ? undefined : m.email} you={m.isYou}>
						{isOwner ? (
							<>
								<RoleSelect value={m.role} onChange={(r) => run(setRole({ id: m.id, role: r }))} />
								{!m.isYou && (
									<button type="button" onClick={() => confirm({ title: `Remove ${m.name}?`, action: "Remove member", body: "They will lose access to this workspace, and their personal workspace data will be deleted.", onConfirm: () => removeMember({ id: m.id }) })} className="hover:text-red-600">
										Remove
									</button>
								)}
							</>
						) : (
							<span className="capitalize text-neutral-400">{m.role}</span>
						)}
					</Row>
				))}
				{team.invites.map((i) => (
					<Row key={i.id} label={i.email} detail={`Invited as ${i.role} · hasn't joined yet`}>
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
		</>
	);
}

function RoleSelect({ value, onChange }: { value: Role; onChange: (role: Role) => void }) {
	return (
		<Select
			label="Role"
			value={value}
			options={[
				{ value: "member", label: "Member" },
				{ value: "owner", label: "Owner" },
			]}
			onChange={onChange}
		/>
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
