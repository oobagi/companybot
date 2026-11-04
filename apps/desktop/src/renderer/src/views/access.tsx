import { EVERYONE } from "@companybot/core/place-access";
import { Segmented, Select } from "../controls";
import { useQuery } from "../convex";
import { api } from "../api";
import { CloseIcon, PrivateIcon } from "../icons";
import { Notice, compactControlClass, descriptionClass, useRun } from "../ui";

// Who can access a channel, database or page (core place-access.ts): Everyone or roles, each at
// View or Edit (Post, for a channel). One control for all three, so they read the same.

export type AccessEntry = { role: string; level: "view" | "edit" };

/**
 * The list, editable when `onSave` is given: each change saves at once (the server checks who may).
 * `follow`: a page that can follow its parent's list instead ("Same as parent page").
 */
export function WhoCanAccess({
	access,
	onSave,
	editLabel = "Edit",
	follow,
}: {
	access: AccessEntry[];
	onSave?: (access: AccessEntry[]) => Promise<unknown>;
	editLabel?: "Edit" | "Post";
	follow?: { following: boolean; onFollow: () => Promise<unknown> };
}) {
	const roles = useQuery(api.roles.list);
	const { error, run } = useRun();
	if (!roles) return null;
	const nameOf = (role: string) => (role === EVERYONE ? "Everyone" : (roles.find((r) => r.id === role)?.name ?? "Deleted role"));
	const save = (next: AccessEntry[]) => onSave && run(onSave(next));
	const levels = [
		{ value: "view" as const, label: "View" },
		{ value: "edit" as const, label: editLabel },
	];
	const addable = [{ id: EVERYONE, name: "Everyone" }, ...roles.filter((r) => r.builtIn !== "owner")].filter((r) => !access.some((e) => e.role === r.id));
	return (
		<div className="flex flex-col gap-2">
			{follow && (
				<Segmented
					label="Whose list"
					value={follow.following ? "parent" : "own"}
					options={[
						{ value: "parent", label: "Same as parent page" },
						{ value: "own", label: "Its own" },
					]}
					onChange={(v) => (v === "parent" ? !follow.following && run(follow.onFollow()) : follow.following && save(access))}
				/>
			)}
			<ul className="flex flex-col gap-1">
				{access.map((e) => (
					<li key={e.role} className="flex items-center gap-2 py-0.5">
						<span className="flex-1 truncate text-sm">{nameOf(e.role)}</span>
						{onSave && !follow?.following ? (
							<>
								<Segmented label={`What ${nameOf(e.role)} can do`} value={e.level} options={levels} onChange={(level) => level !== e.level && save(access.map((x) => (x.role === e.role ? { ...x, level } : x)))} />
								<button type="button" aria-label={`Remove ${nameOf(e.role)}`} title="Remove" onClick={() => save(access.filter((x) => x.role !== e.role))} className="rounded-md p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-900">
									<CloseIcon />
								</button>
							</>
						) : (
							<span className="text-sm text-neutral-500">{e.level === "edit" ? editLabel : "View"}</span>
						)}
					</li>
				))}
				<li className="flex items-center gap-2 py-0.5">
					<span className="flex-1 truncate text-sm">Owners</span>
					<span className="text-sm text-neutral-500">Always {editLabel}</span>
				</li>
			</ul>
			{onSave && !follow?.following && addable.length > 0 && (
				<Select
					value={undefined}
					placeholder="Add a role…"
					label="Add a role"
					className={`${compactControlClass} self-start`}
					options={addable.map((r) => ({ value: r.id, label: r.name }))}
					onChange={(role) => save([...access, { role, level: "view" }])}
				/>
			)}
			{access.length === 0 && <p className={descriptionClass}>Only owners can see it.</p>}
			<Notice>{error}</Notice>
		</div>
	);
}

/** The sidebar's lock on a restricted place, saying who can: "Office and Owners". */
export function AccessLock({ lock, verb = "edit" }: { lock: { who: string; edit: boolean } | null; verb?: "edit" | "post in" }) {
	if (!lock) return null;
	const words = lock.edit ? `Everyone can see it. Only ${lock.who} can ${verb} it.` : `Only ${lock.who} can see it.`;
	return (
		<span title={words} aria-label={words} className="ml-auto flex shrink-0 text-xs text-neutral-400">
			<PrivateIcon />
		</span>
	);
}
