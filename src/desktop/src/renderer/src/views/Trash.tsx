import { type Role, can } from "@companybot/core/permissions";
import { Select } from "../controls";
import type { FunctionReturnType } from "convex/server";
import { useState } from "react";
import { api } from "../api";
import { useMutation, usePaginatedQuery } from "../convex";
import { navigate } from "../router";
import { ArchiveIcon } from "../icons";
import { useConfirm } from "./chat/common";
import { EmptyState, LoadMore, NoMatches, Notice, Page, listClass, metadataClass, timeAgo, toolbarClass, useDebounced, useRun, wideControlClass } from "../ui";
import { recordPath, whoLabel } from "./records/logic";

// Archive keeps content indefinitely. Owners can explicitly delete forever.
// The existing trash API/storage remains compatible with installed clients.

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
	const query = useDebounced(search);
	const [kind, setKind] = useState<Kind | "">("");
	const args = { search: query.trim() || undefined, kind: kind || undefined };
	const { results, status, loadMore } = usePaginatedQuery(api.trash.list, args, { initialNumItems: 25 });
	const restore = useMutation(api.trash.restore);
	const purge = useMutation(api.trash.purge);
	const { error, run } = useRun();
	const { confirm, dialog } = useConfirm();
	const canPurge = can(role, "trash.manage");
	return (
		<Page title="Archive" description="Archived items are kept here until you restore them or explicitly delete them forever.">
			<div className={toolbarClass}>
				<input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search Archive" className={wideControlClass} />
				<Select
					label="Kind"
					value={kind}
					options={[{ value: "", label: "Everything" }, ...kinds.map((k) => ({ value: k.id, label: k.label }))]}
					onChange={setKind}
				/>
			</div>
			<Notice>{error}</Notice>
			{dialog}
			{results.length > 0 && (
				<div className={listClass}>
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
									{e.hasChildren && <span className={`ml-2 ${metadataClass}`}>includes sub-pages</span>}
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
										onClick={() => confirm({ title: `Delete “${e.name}” forever?`, action: "Delete forever", body: "This can't be undone.", onConfirm: () => purge({ id: e.itemId }) })}
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
			{status === "Exhausted" && results.length === 0 && (args.search || args.kind ? <NoMatches /> : <EmptyState icon={<ArchiveIcon />} title="Archive is empty">Items you archive will appear here. Nothing is automatically deleted.</EmptyState>)}
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
			<Notice>{error}</Notice>
			<div className="flex items-center gap-3 rounded-xl bg-neutral-50 px-4 py-3 text-sm text-neutral-600">
				<p className="flex-1">
					Archived by {whoLabel(trash)} {timeAgo(trash.at)}. Its content is kept until you restore it or delete it forever.
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
