import { type Role, can } from "@companybot/core";
import type { FunctionReturnType } from "convex/server";
import { useState } from "react";
import { api } from "../api";
import { useMutation, usePaginatedQuery } from "../convex";
import { navigate } from "../router";
import { TrashIcon } from "../icons";
import { EmptyState, NoMatches, LoadMore, Notice, Page, compactControlClass, metadataClass, timeAgo, useRun } from "../ui";
import { recordPath, whoLabel } from "./records/logic";

// Trash: everything people deleted, like Notion's. Whoever deleted something, or an owner,
// can restore it; owners can delete forever, and the rest goes 30 days on. See wiki/data.md#trash.

type TrashRow = FunctionReturnType<typeof api.trash.list>["page"][number];
type Kind = TrashRow["kind"];

const kinds: { id: Kind; label: string; one: string }[] = [
	{ id: "record", label: "Records", one: "Record" },
	{ id: "database", label: "Databases", one: "Database" },
	{ id: "field", label: "Fields", one: "Field" },
	{ id: "page", label: "Pages", one: "Page" },
	{ id: "channel", label: "Channels", one: "Channel" },
	{ id: "agent", label: "Agents", one: "Agent" },
	{ id: "skill", label: "Skills", one: "Skill" },
	{ id: "automation", label: "Automations", one: "Automation" },
	{ id: "memory", label: "Team memories", one: "Team memory" },
];

/** Where an item in Trash opens, read-only, if it has its own screen. */
function pathOf(e: TrashRow): string[] | undefined {
	if (e.kind === "record" && e.typeKey) return recordPath(e.typeKey, e.itemId);
	if (e.kind === "page") return ["pages", e.itemId];
	if (e.kind === "channel") return ["chat", e.itemId];
	if (e.kind === "agent") return ["settings", "agents", e.itemId];
	if ((e.kind === "skill" || e.kind === "automation") && e.screenId) return ["settings", `${e.kind}s`, e.screenId];
}

export function TrashView({ role }: { role: Role }) {
	const [search, setSearch] = useState("");
	const [kind, setKind] = useState<Kind | "">("");
	const args = { search: search.trim() || undefined, kind: kind || undefined };
	const { results, status, loadMore } = usePaginatedQuery(api.trash.list, args, { initialNumItems: 25 });
	const restore = useMutation(api.trash.restore);
	const purge = useMutation(api.trash.purge);
	const { error, run } = useRun();
	const canPurge = can(role, "trash.manage");
	return (
		<Page title="Trash" description="Everything deleted lands here. It's deleted forever 30 days later." wide>
			<div className="flex items-center gap-3 text-sm">
				<input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search Trash" className={`${compactControlClass} w-64`} />
				<select value={kind} onChange={(e) => setKind(e.target.value as Kind | "")} className={compactControlClass}>
					<option value="">Everything</option>
					{kinds.map((k) => (
						<option key={k.id} value={k.id}>{k.label}</option>
					))}
				</select>
			</div>
			{error && <Notice>{error}</Notice>}
			{results.length > 0 && (
				<div className="flex flex-col divide-y divide-neutral-100 rounded-xl border border-neutral-200">
					{results.map((e) => {
						const to = pathOf(e);
						return (
							<div key={e._id} className="flex items-baseline gap-3 px-4 py-2 text-sm">
								<span className="w-24 shrink-0 text-neutral-500">{kinds.find((k) => k.id === e.kind)!.one}</span>
								<span className="min-w-0 truncate">
									{to ? (
										<button type="button" onClick={() => navigate(...to)} className="font-medium hover:underline">{e.name}</button>
									) : (
										<span className="font-medium">{e.name}</span>
									)}
									{e.in && <span className={`ml-2 ${metadataClass}`}>in {e.in}</span>}
								</span>
								<span className={`ml-auto shrink-0 ${metadataClass}`}>
									{whoLabel(e)} · {timeAgo(e.at)}
								</span>
								{e.canRestore && (
									<button type="button" onClick={() => run(restore({ kind: e.kind, id: e.itemId }))} className="shrink-0 text-neutral-600 hover:text-neutral-900">
										Restore
									</button>
								)}
								{canPurge && (
									<button
										type="button"
										onClick={() => confirm(`Delete “${e.name}” forever? This can't be undone.`) && run(purge({ id: e.itemId }))}
										className="shrink-0 text-neutral-400 hover:text-red-600"
									>
										Delete forever
									</button>
								)}
							</div>
						);
					})}
				</div>
			)}
			{status === "Exhausted" && results.length === 0 && (args.search || args.kind ? <NoMatches /> : <EmptyState icon={<TrashIcon />} title="Trash is empty">Nothing has been deleted.</EmptyState>)}
			<LoadMore status={status} onMore={() => loadMore(25)} />
		</Page>
	);
}

/** On an item's own screen while it's in Trash: who deleted it, and Restore. */
export function TrashNotice({ trash }: { trash: NonNullable<NonNullable<FunctionReturnType<typeof api.pages.get>>["trash"]> }) {
	const restore = useMutation(api.trash.restore);
	const { error, run } = useRun();
	return (
		<div className="flex flex-col gap-2">
			{error && <Notice>{error}</Notice>}
			<div className="flex items-center gap-3 rounded-xl bg-neutral-50 px-4 py-3 text-sm text-neutral-600">
				<p className="flex-1">
					In Trash: deleted by {whoLabel(trash)} {timeAgo(trash.at)}. It's deleted forever 30 days after that.
				</p>
				{trash.canRestore && (
					<button type="button" onClick={() => run(restore({ kind: trash.kind, id: trash.itemId }))} className="shrink-0 font-medium hover:underline">
						Restore
					</button>
				)}
			</div>
		</div>
	);
}
