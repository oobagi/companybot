import { EVERYONE, type PlaceKind, losesOwnEdit, ownEditMessage } from "@companybot/core/place-access";
import { Select } from "../controls";
import { useQuery } from "../convex";
import { api } from "../api";
import { CloseIcon, PrivateIcon, RestoreIcon } from "../icons";
import { Notice, Section, compactButton, compactControlClass, hintClass, iconButton, listClass, useRun } from "../ui";

// Who can access a channel, database or page (core place-access.ts): Everyone or roles, each at
// View or Edit (Post, for a channel). One control for all three, so they read the same.

export type AccessEntry = { role: string; level: "view" | "edit" };

/**
 * The "Who can access" section of a dialog: one row per role, editable when `onSave` is given; each
 * change saves at once (the server checks who may). `hint` adds a line under the heading.
 * `follow`: a page that can follow its parent's list (a top-level page's is the default, Everyone at
 * Edit). Changing anything while it follows gives the page its own list; a button goes back.
 */
export function WhoCanAccess({
	access,
	onSave,
	kind,
	hint,
	follow,
}: {
	access: AccessEntry[];
	onSave?: (access: AccessEntry[]) => Promise<unknown>;
	kind: PlaceKind;
	hint?: string;
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
	const lines = [
		hint,
		follow && (follow.following ? `Same as ${from}; changing it gives this page its own list.` : "This page has its own list."),
		`Owners can always ${verb}${kind === "channel" ? " in it" : " it"}.`,
		onSave && guarded && `Taking away your own ${verb === "post" ? "Post" : "Edit"} needs an Owner.`,
	];
	return (
		<Section
			title="Who can access"
			note={lines.filter(Boolean).join(" ")}
			action={
				follow && !follow.following && (
					<button type="button" className={compactButton} onClick={() => run(follow.onFollow())}>
						<RestoreIcon /> {follow.parent ? "Use parent page's" : "Reset to default"}
					</button>
				)
			}
		>
			<ul className={listClass}>
				{access.length === 0 && <li className={`px-4 py-2.5 ${hintClass}`}>Only Owners can see it.</li>}
				{access.map((e) => (
					<li key={e.role} className="flex min-h-12 items-center gap-2 px-4 py-2">
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
									className={`${iconButton} disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent`}
								>
									<CloseIcon />
								</button>
							</>
						) : (
							<span className="text-sm text-neutral-500">{e.level === "edit" ? `Can ${verb}` : "Can view"}</span>
						)}
					</li>
				))}
				{onSave && addable.length > 0 && (
					<li className="px-4 py-2">
						<Select
							value={undefined}
							placeholder="Add a role…"
							label="Add a role"
							className={compactControlClass}
							options={addable.map((r) => ({ value: r.id, label: r.name }))}
							onChange={(role) => save([...access, { role, level: "view" }])}
						/>
					</li>
				)}
			</ul>
			<Notice>{error}</Notice>
		</Section>
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
