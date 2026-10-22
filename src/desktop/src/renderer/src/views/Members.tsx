import type { Role } from "@companybot/core";
import { useMutation } from "convex/react";
import { useQuery } from "convex-helpers/react/cache";
import { useState } from "react";
import { api } from "../api";
import { Loading, Notice, inputClass, primaryButton, useRun } from "../ui";

export function MembersTab({ role }: { role: Role }) {
	const team = useQuery(api.workspace.team);
	const invite = useMutation(api.workspace.invite);
	const cancelInvite = useMutation(api.workspace.cancelInvite);
	const removeMember = useMutation(api.workspace.removeMember);
	const setRole = useMutation(api.workspace.setRole);
	const [email, setEmail] = useState("");
	const [inviteRole, setInviteRole] = useState<Role>("member");
	const { error, run } = useRun();
	const isOwner = role === "owner";

	if (!team) return <Loading />;

	return (
		<>
			<p className="text-sm text-neutral-500">
				Invited people join when they sign in with that email. Role changes apply right away.
			</p>
			{error && <Notice>{error}</Notice>}

			{isOwner && (
				<form
					className="flex gap-2"
					onSubmit={(e) => {
						e.preventDefault();
						run(invite({ email, role: inviteRole }), () => setEmail(""));
					}}
				>
					<input
						type="email"
						value={email}
						onChange={(e) => setEmail(e.target.value)}
						placeholder="teammate@company.com"
						className={`${inputClass} flex-1`}
					/>
					<RoleSelect value={inviteRole} onChange={setInviteRole} />
					<button type="submit" className={primaryButton}>
						Invite
					</button>
				</form>
			)}

			<section className="flex flex-col gap-2">
				{team.members.map((m) => (
					<Row key={m.id} label={m.name} detail={m.name === m.email ? undefined : m.email} you={m.isYou}>
						{isOwner ? (
							<>
								<RoleSelect value={m.role} onChange={(r) => run(setRole({ id: m.id, role: r }))} />
								{!m.isYou && (
									<button type="button" onClick={() => run(removeMember({ id: m.id }))} className="hover:text-red-600">
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
					<Row key={i.id} label={i.email} detail={`Invited as ${i.role}`}>
						<button type="button" onClick={() => run(cancelInvite({ id: i.id }))} className="hover:text-red-600">
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
		<select
			value={value}
			onChange={(e) => onChange(e.target.value as Role)}
			className="rounded-lg border border-neutral-200 px-2 py-1 text-sm"
		>
			<option value="member">Member</option>
			<option value="owner">Owner</option>
		</select>
	);
}

function Row({ label, detail, you, children }: { label: string; detail?: string; you?: boolean; children?: React.ReactNode }) {
	return (
		<div className="flex items-center gap-3 rounded-xl border border-neutral-200 px-4 py-3">
			<span className="flex min-w-0 flex-1 flex-col">
				<span className="truncate">
					{label}
					{you && <span className="ml-2 text-xs text-neutral-400">You</span>}
				</span>
				{detail && <span className="truncate text-xs text-neutral-500">{detail}</span>}
			</span>
			<span className="flex items-center gap-3 text-sm text-neutral-500">{children}</span>
		</div>
	);
}
