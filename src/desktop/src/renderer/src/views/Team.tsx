import type { Role } from "@companybot/core";
import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { api, errorMessage } from "../api";
import { Notice } from "./Chat";
import { Page } from "./Memory";

export function TeamView({ role }: { role: Role }) {
	const team = useQuery(api.workspace.team);
	const invite = useMutation(api.workspace.invite);
	const cancelInvite = useMutation(api.workspace.cancelInvite);
	const removeMember = useMutation(api.workspace.removeMember);
	const [email, setEmail] = useState("");
	const [inviteRole, setInviteRole] = useState<Role>("member");
	const [error, setError] = useState<string>();
	const isOwner = role === "owner";
	const run = (action: Promise<unknown>, then?: () => void) =>
		action.then(
			() => (setError(undefined), then?.()),
			(e) => setError(errorMessage(e)),
		);

	return (
		<Page title="Team" subtitle="People in this workspace. Invited people join when they sign in with that email.">
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
						className="flex-1 rounded-xl border border-neutral-200 px-3 py-2 outline-none focus:border-neutral-300"
					/>
					<select
						value={inviteRole}
						onChange={(e) => setInviteRole(e.target.value as Role)}
						className="rounded-xl border border-neutral-200 px-2 text-sm"
					>
						<option value="member">Member</option>
						<option value="owner">Owner</option>
					</select>
					<button type="submit" className="rounded-xl bg-neutral-900 px-4 text-sm text-white">
						Invite
					</button>
				</form>
			)}

			<section className="flex flex-col gap-2">
				{team?.members.map((m) => (
					<Row key={m.id} label={m.email} detail={m.role}>
						{isOwner && m.role !== "owner" && (
							<button type="button" onClick={() => run(removeMember({ id: m.id }))} className="hover:text-red-600">
								Remove
							</button>
						)}
					</Row>
				))}
				{team?.invites.map((i) => (
					<Row key={i.id} label={i.email} detail={`invited · ${i.role}`}>
						<button type="button" onClick={() => run(cancelInvite({ id: i.id }))} className="hover:text-red-600">
							Cancel
						</button>
					</Row>
				))}
			</section>
		</Page>
	);
}

function Row({ label, detail, children }: { label: string; detail: string; children?: React.ReactNode }) {
	return (
		<div className="flex items-center gap-3 rounded-xl border border-neutral-200 px-4 py-3">
			<span className="flex-1 truncate">{label}</span>
			<span className="text-sm capitalize text-neutral-400">{detail}</span>
			<span className="text-sm text-neutral-500">{children}</span>
		</div>
	);
}
