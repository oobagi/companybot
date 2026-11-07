import { EVERYONE, type PlaceKind, losesOwnEdit, ownEditMessage } from "@companybot/core/place-access";
import { useQuery } from "../convex";
import { api } from "../api";
import { CaretDownIcon, CheckIcon, PlusIcon, PrivateIcon, RestoreIcon } from "../icons";
import { Notice, Section, compactButton, hintClass, listClass, useRun } from "../ui";
import { MenuItem, Popover } from "./chat/common";

// Who can access a channel, database, page, folder or file (core place-access.ts): Everyone or roles,
// each at View or Edit (Post, for a channel). One control for all of them, so they read the same.

export type AccessEntry = { role: string; level: "view" | "edit" };

/** Something in Drive that can follow a list instead of keeping its own: its parent page's, its folder's, or the default. */
export type Follow = { following: boolean; parent?: "page" | "folder"; what?: "page" | "folder" | "file"; onFollow: () => Promise<unknown> };

/**
 * The "Who can access" section of a dialog: one row per role, its level a quiet menu with Remove
 * under it, and + Add on the heading (as in a share dialog); editable when `onSave` is given; each
 * change saves at once (the server checks who may). `hint` adds a line under the heading.
 * `follow`: a page, folder or file that can follow its parent's list (a top-level one's is the default,
 * Everyone at Edit). Changing anything while it follows gives it its own list; a button goes back.
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
	follow?: Follow;
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
		const options: { value: AccessEntry["level"]; label: string; disabled?: boolean; hint?: string }[] = [
			{ value: "view", label: "Can view", ...(locksOut(view) && { disabled: true, hint: lockedOut }) },
			{ value: "edit", label: `Can ${verb}` },
		];
		return options;
	};
	const without = (role: string) => access.filter((x) => x.role !== role);
	const guarded = access.some((e) => locksOut(without(e.role)));
	const addable = [{ id: EVERYONE, name: "Everyone" }, ...roles.filter((r) => r.builtIn !== "owner")].filter((r) => !access.some((e) => e.role === r.id));
	const from = follow?.parent === "folder" ? "its folder" : follow?.parent === "page" ? "its parent page" : "the default";
	const what = follow?.what ?? "page";
	const lines = [
		hint,
		follow && (follow.following ? `Same as ${from}; changing it gives this ${what} its own list.` : `This ${what} has its own list.`),
		`Owners can always ${verb}${kind === "channel" ? " in it" : " it"}.`,
		onSave && guarded && `Taking away your own ${verb === "post" ? "Post" : "Edit"} needs an Owner.`,
	];
	const add = onSave && addable.length > 0 && (
		<Popover label="Add a role" trigger={<><PlusIcon /> Add</>} className={compactButton} panelClassName="flex w-56 flex-col p-1 text-sm">
			{(close) =>
				addable.map((r) => (
					<MenuItem key={r.id} onClick={() => (close(), save([...access, { role: r.id, level: "view" }]))}>
						{r.name}
					</MenuItem>
				))
			}
		</Popover>
	);
	const reset = follow && !follow.following && (
		<button type="button" className={compactButton} onClick={() => run(follow.onFollow())}>
			<RestoreIcon /> {follow.parent === "folder" ? "Use folder's" : follow.parent === "page" ? "Use parent page's" : "Reset to default"}
		</button>
	);
	return (
		<Section
			title="Who can access"
			note={lines.filter(Boolean).join(" ")}
			action={(add || reset) && <>{reset}{add}</>}
		>
			<ul className={listClass}>
				{access.length === 0 && <li className={`px-4 py-2.5 ${hintClass}`}>Only Owners can see it.</li>}
				{access.map((e) => (
					<li key={e.role} className="flex min-h-12 items-center gap-2 px-4 py-2">
						<span className="flex-1 truncate text-sm">{nameOf(e.role)}</span>
						{onSave ? (
							// The role's level, and Remove under it, as in a share dialog; the same button as + Add.
							<Popover
								label={`What ${nameOf(e.role)} can do`}
								trigger={<>{e.level === "edit" ? `Can ${verb}` : "Can view"}<CaretDownIcon className="text-neutral-400" /></>}
								className={compactButton}
								panelClassName="flex w-56 flex-col p-1 text-sm"
							>
								{(close) => (
									<>
										{levels(e.role).map((l) => (
											<MenuItem key={l.value} disabled={l.disabled} title={l.hint} onClick={() => (close(), l.value !== e.level && save(access.map((x) => (x.role === e.role ? { ...x, level: l.value } : x))))}>
												<span className="flex-1">{l.label}</span>
												{l.value === e.level && <CheckIcon className="text-neutral-500" />}
											</MenuItem>
										))}
										<span aria-hidden className="my-1 h-px bg-neutral-100" />
										<MenuItem danger disabled={locksOut(without(e.role))} title={locksOut(without(e.role)) ? lockedOut : undefined} onClick={() => (close(), save(without(e.role)))}>
											Remove access
										</MenuItem>
									</>
								)}
							</Popover>
						) : (
							<span className="text-sm text-neutral-500">{e.level === "edit" ? `Can ${verb}` : "Can view"}</span>
						)}
					</li>
				))}
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
