import { EVERYONE, type PlaceKind, losesOwnEdit, ownEditMessage } from "@companybot/core/place-access";
import { Select } from "../controls";
import { useQuery } from "../convex";
import { api } from "../api";
import { CloseIcon, PrivateIcon } from "../icons";
import { Notice, compactButton, compactControlClass, descriptionClass, useRun } from "../ui";

// Who can access a channel, database or page (core place-access.ts): Everyone or roles, each at
// View or Edit (Post, for a channel). One control for all three, so they read the same.

export type AccessEntry = { role: string; level: "view" | "edit" };

/**
 * The list, editable when `onSave` is given: each change saves at once (the server checks who may).
 * `follow`: a page that can follow its parent's list (a top-level page's is the default, Everyone at
 * Edit). Changing anything while it follows gives the page its own list; a button goes back.
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
	follow?: { following: boolean; parent: boolean; onFollow: () => Promise<unknown> };
}) {
	const roles = useQuery(api.roles.list);
	const me = useQuery(api.workspace.me);
	const { error, run } = useRun();
	if (!roles) return null;
	const verb = kind === "channel" ? "post" : "edit";
	// Only Owners may take their own Edit (Post) away: nobody else could undo it. The server refuses it too.
	const locksOut = (next: AccessEntry[]) => !!me?.access && losesOwnEdit(me.access, next);
	const lockedOut = ownEditMessage(kind);
	const nameOf = (role: string) => (role === EVERYONE ? "Everyone" : (roles.find((r) => r.id === role)?.name ?? "Deleted role"));
	const save = (next: AccessEntry[]) => onSave && run(onSave(next));
	const levels = (role: string) => {
		const view = access.map((x) => (x.role === role ? { ...x, level: "view" as const } : x));
		return [
			{ value: "view" as const, label: "Can view", ...(locksOut(view) && { disabled: true, hint: lockedOut }) },
			{ value: "edit" as const, label: `Can ${verb}` },
		];
	};
	const without = (role: string) => access.filter((x) => x.role !== role);
	const guarded = access.some((e) => locksOut(without(e.role)));
	const addable = [{ id: EVERYONE, name: "Everyone" }, ...roles.filter((r) => r.builtIn !== "owner")].filter((r) => !access.some((e) => e.role === r.id));
	const from = follow?.parent ? "its parent page" : "the default";
	return (
		<div className="flex flex-col gap-3">
			{follow &&
				(follow.following ? (
					<p className={descriptionClass}>{`Same as ${from}. Changing it gives this page its own list.`}</p>
				) : (
					<div className="flex items-center gap-2">
						<p className={`${descriptionClass} flex-1`}>This page has its own list.</p>
						<button type="button" className={compactButton} onClick={() => run(follow.onFollow())}>
							{follow.parent ? "Use parent page's" : "Reset to default"}
						</button>
					</div>
				))}
			<ul className="flex flex-col gap-1">
				{access.map((e) => (
					<li key={e.role} className="flex min-h-8 items-center gap-2">
						<span className="flex-1 truncate text-sm">{nameOf(e.role)}</span>
						{onSave ? (
							<>
								<Select
									label={`What ${nameOf(e.role)} can do`}
									value={e.level}
									options={levels(e.role)}
									className={`${compactControlClass} w-32`}
									onChange={(level) => save(access.map((x) => (x.role === e.role ? { ...x, level } : x)))}
								/>
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
							<span className="text-sm text-neutral-500">{e.level === "edit" ? `Can ${verb}` : "Can view"}</span>
						)}
					</li>
				))}
			</ul>
			{onSave && addable.length > 0 && (
				<Select
					value={undefined}
					placeholder="Add a role…"
					label="Add a role"
					className={`${compactControlClass} self-start`}
					options={addable.map((r) => ({ value: r.id, label: r.name }))}
					onChange={(role) => save([...access, { role, level: "view" }])}
				/>
			)}
			<p className={descriptionClass}>
				{access.length === 0 ? "Only Owners can see it." : `Owners can always ${verb}${kind === "channel" ? " in it" : " it"}.`}
				{onSave && guarded && ` Changes that would take away your own ${verb === "post" ? "Post" : "Edit"} need an Owner.`}
			</p>
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
