// The Public role: anyone outside the workspace who reaches an agent (a texter, an emailer, later a
// caller or someone in website chat). They aren't members and never sign in, so the role applies by
// itself; it can't be given to anyone, edited into a staff role, or deleted.
//
// Its ceiling is this list. An owner switches these on or off (Settings → Roles → Public), and nothing
// else can ever be on: staff permissions (`permissions.ts`) aren't switches here, and a turn for an
// outsider never runs as a member, so it never reaches records, pages, chat, memory, connectors,
// settings or money. Add an ability only if it's safe to hand to a stranger. wiki/permissions.md#public.

/**
 * What an agent may do for an outsider. `label` finishes "Agents talking with customers can …";
 * `on` is the default for every workspace until an owner flips it.
 */
export const publicAbilities = {
	/** Without it, every reply waits in Inbox as a draft until someone on staff sends it. */
	"public.reply": { label: "reply without staff approving each message", on: false },
	/** A note for staff on the conversation (never sent to the customer), and a line in the agent's announcement channel. */
	"public.message": { label: "take a message for staff", on: true },
	/** Stops the agent replying in that conversation and asks staff to take it, in Inbox and the announcement channel. */
	"public.handoff": { label: "hand the conversation to staff", on: true },
} as const satisfies Record<string, { label: string; on: boolean }>;

export type PublicAbility = keyof typeof publicAbilities;
export const publicAbilityIds = Object.keys(publicAbilities) as PublicAbility[];

export const isPublicAbility = (id: string): id is PublicAbility => (publicAbilityIds as string[]).includes(id);

/** What a workspace stores: only the abilities an owner flipped from their default. */
export type StoredAbilities = readonly { ability: string; on: boolean }[];

/** What Public may do: each ability's stored value, else its default. Anything not in the ceiling is dropped. */
export function publicSwitches(stored: StoredAbilities | undefined): PublicAbility[] {
	return publicAbilityIds.filter((a) => stored?.find((s) => s.ability === a)?.on ?? publicAbilities[a].on);
}

/** Stored abilities after turning one on or off: only what differs from the default is kept. Refuses anything past the ceiling. */
export function flipAbility(stored: StoredAbilities | undefined, ability: string, on: boolean): { ability: PublicAbility; on: boolean }[] {
	if (!isPublicAbility(ability)) throw new Error("Public can't be given that. Only customer-safe abilities can be switched on.");
	const rest = (stored ?? []).filter((s): s is { ability: PublicAbility; on: boolean } => s.ability !== ability && isPublicAbility(s.ability));
	return on === publicAbilities[ability].on ? rest : [...rest, { ability, on }];
}
