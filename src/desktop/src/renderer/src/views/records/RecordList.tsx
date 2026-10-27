import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import type { Role } from "@companybot/core";
import { can } from "@companybot/core/permissions";
import { useEffect, useState } from "react";
import { api } from "../../api";
import { useMutation, usePaginatedQuery, useQuery } from "../../convex";
import { navigate } from "../../router";
import { ArrowDownIcon, ArrowUpIcon, CloseIcon, EditIcon, MoreIcon, PlusIcon } from "../../icons";
import { ConflictNotice, ErrorBoundary, Field, LoadMore, Loading, Notice, Page, Tabs, barButton, barPrimaryButton, compactControlClass, dangerButton, descriptionClass, inputClass, primaryButton, secondaryButton, timeAgo, useDraft, useRun } from "../../ui";
import { Modal, useDismiss } from "../chat/common";
import { DatabaseDialog } from "./DatabaseDialog";
import { type RecordType, type Row, useRefs } from "./data";
import { Chip, RecordOptions, RecordPicker, useOptions } from "./fields";
import {
	type Filter,
	type Op,
	type Refs,
	type TypeField,
	defaultColumns,
	fromConditions,
	needsValue,
	opLabels,
	opsFor,
	recordPath,
	sortable,
	toCondition,
	valueText,
} from "./logic";

// One database's list: a table with chosen columns, sort by any column, filters,
// search, and pages that keep loading as you scroll. Deleted records are in Trash.

type Sort = { field: string; order: "asc" | "desc" };

type Settings = { filters: Filter[]; sort?: Sort; columns: string[] };

export function RecordList({ type, role }: { type: RecordType; role: Role }) {
	const views = useQuery(api.databaseViews.list, { typeId: type._id });
	const saveView = useMutation(api.databaseViews.save);
	const removeView = useMutation(api.databaseViews.remove);
	const [viewId, setViewId] = useState("all");
	const selected = views?.find((v) => v._id === viewId);
	const fields = type.fields.filter((f) => !f.archived) as TypeField[];
	const live = (key: string) => ["createdAt", "updatedAt", ...fields.map((f) => f.key)].includes(key);
	// "All" keeps the columns people picked on this computer; a view's settings skip fields archived since.
	const columnsKey = `records.columns.${type.key}`;
	const draft = useDraft<Settings>(
		selected
			? { filters: fromConditions(selected.filters.filter((c) => live(c.field)), fields), sort: selected.sort && live(selected.sort.field) ? selected.sort : undefined, columns: selected.columns }
			: { filters: [], columns: JSON.parse(localStorage.getItem(columnsKey) ?? "null") ?? defaultColumns(type.fields) },
		selected?.version ?? 0,
	);
	const { filters, sort } = draft.value;
	const columns = draft.value.columns.filter(live);
	const change = (next: Partial<Settings>) => {
		draft.set({ ...draft.value, ...next });
		if (!selected && next.columns) localStorage.setItem(columnsKey, JSON.stringify(next.columns));
	};
	const setFilters = (filters: Filter[]) => change({ filters });
	const setSort = (sort: Sort | undefined) => change({ sort });
	const setColumns = (columns: string[]) => change({ columns });
	const open = (id: string) => (setViewId(id), draft.discard());
	// Someone deleted the open view.
	useEffect(() => {
		if (views && viewId !== "all" && !selected) open("all");
	}, [views, viewId, selected]);
	const [naming, setNaming] = useState<"new" | "edit">();
	const [editingDatabase, setEditingDatabase] = useState(false);
	const [search, setSearch] = useState("");
	const [creating, setCreating] = useState(false);
	const { error, run } = useRun();
	const shown = columns.map((k) => fields.find((f) => f.key === k)!);
	const conditions = filters.map(toCondition).filter((c) => c !== null);
	const canEdit = can(role, "records.edit");
	const sortField = sort && fields.find((f) => f.key === sort.field);
	const args = { typeId: type._id, filters: conditions, sort };
	const noun = type.plural.toLowerCase();
	const tabClass = "flex items-center px-3 py-2 text-base text-neutral-500 hover:text-neutral-800";

	return (
		<Page
			wide
			title={type.plural}
			actions={
				<>
					{can(role, "fields.manage") && (
						<button type="button" className={barButton} onClick={() => setEditingDatabase(true)}>
							<EditIcon /> Edit database
						</button>
					)}
					{canEdit && (
						<button type="button" className={barPrimaryButton} onClick={() => setCreating(true)}>
							<PlusIcon /> New {type.name.toLowerCase()}
						</button>
					)}
				</>
			}
		>
			<Tabs tabs={[{ id: "all", label: "All" }, ...(views ?? []).map((v) => ({ id: v._id as string, label: v.name }))]} value={selected ? viewId : "all"} onChange={open}>
				{canEdit && selected && (
					<button type="button" title="Rename or delete this view" className={tabClass} onClick={() => setNaming("edit")}>
						<MoreIcon />
					</button>
				)}
				{canEdit && (
					<button type="button" title="Save these filters as a view" className={tabClass} onClick={() => setNaming("new")}>
						<PlusIcon />
					</button>
				)}
				{canEdit && selected && draft.dirty && (
					<button type="button" disabled={draft.stale} className={`ml-auto self-center ${compactControlClass}`} onClick={() => run(saveView({ typeId: type._id, viewId: selected._id, version: draft.base, name: selected.name, filters: conditions, sort, columns }), draft.discard)}>
						Save for everyone
					</button>
				)}
			</Tabs>
			{error && <Notice>{error}</Notice>}
			{draft.stale && <ConflictNotice onDiscard={draft.discard} onKeep={draft.keepMine} />}
			<div className="flex flex-wrap items-center gap-3 text-sm">
				<input
					type="search"
					value={search}
					onChange={(e) => setSearch(e.target.value)}
					placeholder={`Search ${noun}`}
					className={`${compactControlClass} w-64`}
				/>
				<button
					type="button"
					onClick={() => setFilters([...filters, { field: fields[0]!.key, op: opsFor(fields[0]!)[0]!, value: "" }])}
					className="text-neutral-600 hover:text-neutral-900"
				>
					+ Filter
				</button>
				<ColumnsPicker fields={fields} columns={columns} onChange={setColumns} />
			</div>
			{filters.length > 0 && (
				<div className="-mt-2 flex flex-col gap-2">
					{filters.map((f, i) => (
						<FilterRow
							key={i}
							fields={fields}
							filter={f}
							onChange={(next) => setFilters(filters.map((g, j) => (j === i ? next : g)))}
							onRemove={() => setFilters(filters.filter((_, j) => j !== i))}
						/>
					))}
				</div>
			)}
			{search.trim() ? (
				<>
					<p className="-mt-2 text-xs text-neutral-500">Top 20 live {noun} matching the name or text. Filters and sort don't apply to search.</p>
					<SearchResults type={type} query={search} columns={shown} />
				</>
			) : (
				<>
					{sortField && (
						<p className="-mt-2 text-xs text-neutral-500">
							Sorted by {sortField.label}: {noun} without one aren't listed.
						</p>
					)}
					{/* A query error (a bad filter, an old page) shows here; changing the list clears it. */}
					<ErrorBoundary key={JSON.stringify(args)}>
						<Table
							type={type}
							args={args}
							columns={shown}
							sort={sort}
							onSort={setSort}
							empty={
								filters.length ? (
									<p className={descriptionClass}>No {noun} match these filters.</p>
								) : (
									<div className="flex flex-col items-start gap-3 rounded-xl border border-dashed border-neutral-200 px-6 py-8">
										<p className="text-neutral-600">No {noun} yet.</p>
										{canEdit && (
											<button type="button" className={primaryButton} onClick={() => setCreating(true)}>
												Add the first {type.name.toLowerCase()}
											</button>
										)}
									</div>
								)
							}
						/>
					</ErrorBoundary>
				</>
			)}
			{editingDatabase && <DatabaseDialog type={type} onClose={() => setEditingDatabase(false)} />}
			{naming && (
				<Modal title={naming === "edit" ? "Edit view" : "Save view"} onClose={() => setNaming(undefined)}>
					<form
						className="flex flex-col gap-4"
						onSubmit={(e) => {
							e.preventDefault();
							const name = String(new FormData(e.currentTarget).get("name"));
							const edit = naming === "edit" && selected && { viewId: selected._id, version: draft.base };
							run(saveView({ typeId: type._id, ...edit, name, filters: conditions, sort, columns }).then((id) => (open(id), setNaming(undefined))));
						}}
					>
						{error && <Notice>{error}</Notice>}
						<Field label="View name" hint="These filters, sort and columns, shared with everyone in the workspace.">
							<input name="name" autoFocus required maxLength={120} defaultValue={naming === "edit" ? selected?.name : ""} className={inputClass} />
						</Field>
						<div className="flex items-center gap-2">
							<button type="submit" disabled={naming === "edit" && draft.stale} className={primaryButton}>
								Save for everyone
							</button>
							{naming === "edit" && selected && (
								<button type="button" className={dangerButton} onClick={() => confirm(`Delete the view ${selected.name}?`) && run(removeView({ viewId: selected._id, version: draft.base }), () => (open("all"), setNaming(undefined)))}>
									Delete view
								</button>
							)}
						</div>
					</form>
				</Modal>
			)}
			{creating && <NewRecord type={type} onClose={() => setCreating(false)} />}
		</Page>
	);
}

/** Rows of a list, loading more as the end scrolls into view. Short pages with more to come keep loading. */
function Table({
	type,
	args,
	columns,
	sort,
	onSort,
	empty,
}: {
	type: RecordType;
	args: { typeId: Id<"recordTypes">; filters: Record<string, unknown>[]; sort?: Sort };
	columns: TypeField[];
	sort?: Sort;
	onSort: (sort: Sort | undefined) => void;
	empty: React.ReactNode;
}) {
	const { results, status, loadMore } = usePaginatedQuery(api.records.list, args as never, { initialNumItems: 25 });
	const rows = results as Row[];
	const refs = useRefs(rows);
	const [end, setEnd] = useState<HTMLDivElement | null>(null);
	const [atEnd, setAtEnd] = useState(false);
	useEffect(() => {
		if (!end) return;
		const observer = new IntersectionObserver(([e]) => setAtEnd(!!e?.isIntersecting), { rootMargin: "200px" });
		observer.observe(end);
		return () => observer.disconnect();
	}, [end]);
	// Re-checked after every page, so a short page (isDone false) asks again while the end is in view.
	useEffect(() => {
		if (atEnd && status === "CanLoadMore") loadMore(25);
	}, [atEnd, status, rows.length, loadMore]);

	const header = (key: string, label: string, canSort: boolean) => {
		const on = sort?.field === key;
		const next = (): Sort | undefined => {
			const first = key === "updatedAt" ? "desc" : "asc";
			if (!on) return { field: key, order: first };
			return sort.order === first ? { field: key, order: first === "asc" ? "desc" : "asc" } : undefined;
		};
		return (
			<th key={key} className="px-3 py-2 text-left font-medium whitespace-nowrap">
				{canSort ? (
					<button type="button" onClick={() => onSort(next())} className={`flex items-center gap-1 ${on ? "text-neutral-900" : "hover:text-neutral-900"}`}>
						{label}
						{on && (sort.order === "asc" ? <ArrowUpIcon /> : <ArrowDownIcon />)}
					</button>
				) : (
					label
				)}
			</th>
		);
	};

	if (status === "LoadingFirstPage") return <Loading />;
	return (
		<div className="flex flex-col gap-2">
			{rows.length === 0 && status === "Exhausted" ? (
				empty
			) : (
				<RowsTable
					type={type}
					rows={rows}
					refs={refs}
					columns={columns}
					head={[
						...columns.map((f) => header(f.key, f.label, sortable(f))),
						header("updatedAt", "Updated", true),
					]}
				/>
			)}
			<div ref={setEnd} className="flex flex-col items-center py-2">
				<LoadMore status={status} onMore={() => loadMore(25)} />
			</div>
		</div>
	);
}

function RowsTable({ type, rows, refs, columns, head }: { type: RecordType; rows: Row[]; refs: Refs; columns: TypeField[]; head: React.ReactNode[] }) {
	return (
		<div className="overflow-x-auto rounded-xl border border-neutral-200">
			<table className="w-full text-sm">
				<thead className="border-b border-neutral-200 bg-neutral-50 text-neutral-500">
					<tr>{head}</tr>
				</thead>
				<tbody>
					{rows.map((r) => (
						<tr
							key={r._id}
							onClick={() => navigate(...recordPath(type.key, r._id))}
							className="cursor-default border-b border-neutral-100 last:border-0 hover:bg-neutral-50"
						>
							{columns.map((f, i) => (
								<td key={f.key} className={`max-w-64 truncate px-3 py-2 ${i === 0 ? "font-medium" : "text-neutral-700"}`}>
									{valueText(f, r.values[f.key], refs)}
								</td>
							))}
							<td className="px-3 py-2 whitespace-nowrap text-neutral-400">{timeAgo(r.updatedAt)}</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

function SearchResults({ type, query, columns }: { type: RecordType; query: string; columns: TypeField[] }) {
	const rows = useQuery(api.records.search, { query, typeId: type._id });
	const refs = useRefs(rows ?? []);
	if (!rows) return <Loading />;
	if (rows.length === 0) return <p className={descriptionClass}>No matches.</p>;
	const head = [...columns.map((f) => <th key={f.key} className="px-3 py-2 text-left font-medium">{f.label}</th>), <th key="u" className="px-3 py-2 text-left font-medium">Updated</th>];
	return <RowsTable type={type} rows={rows} refs={refs} columns={columns} head={head} />;
}

function FilterRow({
	fields,
	filter,
	onChange,
	onRemove,
}: {
	fields: TypeField[];
	filter: Filter;
	onChange: (filter: Filter) => void;
	onRemove: () => void;
}) {
	const field = fields.find((f) => f.key === filter.field) ?? fields[0]!;
	return (
		<div className="flex flex-wrap items-center gap-2 text-sm">
			<select
				value={field.key}
				onChange={(e) => {
					const next = fields.find((f) => f.key === e.target.value)!;
					onChange({ field: next.key, op: opsFor(next)[0]!, value: "" });
				}}
				className={compactControlClass}
			>
				{fields.map((f) => (
					<option key={f.key} value={f.key}>
						{f.label}
					</option>
				))}
			</select>
			<select value={filter.op} onChange={(e) => onChange({ ...filter, op: e.target.value as Op })} className={compactControlClass}>
				{opsFor(field).map((op) => (
					<option key={op} value={op}>
						{opLabels[op]}
					</option>
				))}
			</select>
			{needsValue(filter.op) && <FilterValue field={field} filter={filter} onChange={(value) => onChange({ ...filter, value })} />}
			<button type="button" onClick={onRemove} className="text-neutral-400 hover:text-neutral-700" title="Remove filter" aria-label="Remove filter">
				<CloseIcon />
			</button>
		</div>
	);
}

/** The value box for a filter, by field kind. Typed text is checked by the server. */
function FilterValue({ field, filter, onChange }: { field: TypeField; filter: Filter; onChange: (value: string | string[]) => void }) {
	const options = useOptions(field);
	const ids = Array.isArray(filter.value) ? filter.value : [];
	const [names, setNames] = useState<Refs>({});
	if (filter.op === "anyOf") {
		const label = (id: string) => options.find((o) => o.id === id)?.label ?? names[id]?.name ?? id;
		return (
			<span className="flex flex-wrap items-center gap-1.5">
				{ids.map((id) => (
					<Chip key={id} onRemove={() => onChange(ids.filter((i) => i !== id))}>{label(id)}</Chip>
				))}
				{field.kind === "link" ? (
					<RecordPicker
						typeId={field.linkType!}
						exclude={ids}
						label="Pick"
						onPick={(id, name) => {
							setNames({ ...names, [id]: { name } });
							onChange([...ids, id]);
						}}
					/>
				) : (
					<select value="" onChange={(e) => e.target.value && onChange([...ids, e.target.value])} className={compactControlClass}>
						<option value="">Pick…</option>
						<RecordOptions options={options.filter((o) => !ids.includes(o.id))} />
					</select>
				)}
			</span>
		);
	}
	const type = field.kind === "date" ? "date" : "text";
	return (
		<input
			type={type}
			value={typeof filter.value === "string" ? filter.value : ""}
			onChange={(e) => onChange(e.target.value)}
			placeholder={field.kind === "currency" ? "1000 or EUR 1000" : "Value"}
			className={`${compactControlClass} w-44`}
		/>
	);
}

function ColumnsPicker({ fields, columns, onChange }: { fields: TypeField[]; columns: string[]; onChange: (keys: string[]) => void }) {
	const [open, setOpen] = useState(false);
	const ref = useDismiss<HTMLSpanElement>(() => setOpen(false), open);
	return (
		<span ref={ref} className="relative">
			<button type="button" onClick={() => setOpen(!open)} className="text-neutral-600 hover:text-neutral-900">
				Columns
			</button>
			{open && (
				<span className="absolute top-full left-0 z-20 mt-1 flex max-h-80 w-56 flex-col gap-1 overflow-y-auto rounded-xl border border-neutral-200 bg-white p-2 shadow-lg">
					{fields.map((f) => (
						<label key={f.key} className="flex items-center gap-2 rounded-md px-2 py-1 hover:bg-neutral-50">
							<input
								type="checkbox"
								disabled={f.key === "name"}
								checked={columns.includes(f.key)}
								onChange={(e) =>
									onChange(e.target.checked ? fields.map((g) => g.key).filter((k) => k === f.key || columns.includes(k)) : columns.filter((k) => k !== f.key))
								}
							/>
							{f.label}
						</label>
					))}
				</span>
			)}
		</span>
	);
}

/** A new record starts with a name; the rest is filled in on its page. */
function NewRecord({ type, onClose }: { type: RecordType; onClose: () => void }) {
	const create = useMutation(api.records.create);
	const [name, setName] = useState("");
	const { error, run } = useRun();
	const label = type.fields.find((f) => f.key === "name")?.label ?? "Name";
	return (
		<Modal title={`New ${type.name.toLowerCase()}`} onClose={onClose}>
			<form
				className="flex flex-col gap-4"
				onSubmit={(e) => {
					e.preventDefault();
					run(create({ typeId: type._id, values: { name } }).then((id) => navigate(...recordPath(type.key, id))));
				}}
			>
				{error && <Notice>{error}</Notice>}
				<Field label={label}>
					<input autoFocus value={name} onChange={(e) => setName(e.target.value)} className={inputClass} />
				</Field>
				<button type="submit" className={`${primaryButton} self-start`}>
					Create
				</button>
			</form>
		</Modal>
	);
}
