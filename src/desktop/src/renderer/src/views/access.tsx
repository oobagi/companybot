import { EVERYONE, type PlaceKind, losesOwnEdit, ownEditMessage } from "@companybot/core/place-access";
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
	kind,
	follow,
}: {
	access: AccessEntry[];
	onSave?: (access: AccessEntry[]) => Promise<unknown>;
	kind: PlaceKind;
	follow?: { following: boolean; onFollow: () => Promise<unknown> };
}) {
	const roles = useQuery(api.roles.list);
	const me = useQuery(api.workspace.me);
	const { error, run } = useRun();
	if (!roles) return null;
	const editLabel = kind === "channel" ? "Post" : "Edit";
	// Only Owners may take their own Edit (Post) away: nobody else could undo it. The server refuses it too.
	const locksOut = (next: AccessEntry[]) => !!me?.access && losesOwnEdit(me.access, next);
	const lockedOut = ownEditMessage(kind);
	const nameOf = (role: string) => (role === EVERYONE ? "Everyone" : (roles.find((r) => r.id === role)?.name ?? "Deleted role"));
	const save = (next: AccessEntry[]) => onSave && run(onSave(next));
	const levels = (role: string) => {
		const view = access.map((x) => (x.role === role ? { ...x, level: "view" as const } : x));
		return [
			{ value: "view" as const, label: "View", ...(locksOut(view) && { disabled: true, title: lockedOut }) },
			{ value: "edit" as const, label: editLabel },
		];
	};
	const without = (role: string) => access.filter((x) => x.role !== role);
	const guarded = access.some((e) => locksOut(without(e.role)));
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
								<Segmented label={`What ${nameOf(e.role)} can do`} value={e.level} options={levels(e.role)} onChange={(level) => level !== e.level && save(access.map((x) => (x.role === e.role ? { ...x, level } : x)))} />
								<button
									type="button"
									aria-label={`Remove ${nameOf(e.role)}`}
									title={locksOut(without(e.role)) ? lockedOut : "Remove"}
									disabled={locksOut(without(e.role))}
									onClick={() => save(without(e.role))}
									className="rounded-md p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-900 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
								>
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
			{onSave && !follow?.following && guarded && <p className={descriptionClass}>{`Changes that would take away your own ${editLabel} need an Owner.`}</p>}
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
