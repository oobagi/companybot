import type { FieldKind } from "@companybot/core/records";
import { type Role, can } from "@companybot/core/permissions";
import { useEffect, useState } from "react";
import { api } from "../../api";
import { Segmented, Select } from "../../controls";
import { useMutation, useQuery } from "../../convex";
import { navigate } from "../../router";
import { useSortable } from "../../sortable";
import { ArrowDownIcon, ArrowUpIcon, CloseIcon, DatabaseIcon, EditIcon, FilterIcon, PlusIcon, PropertiesIcon, TrashIcon } from "../../icons";
import { ConflictNotice, EmptyState, ErrorBoundary, Field, Form, LoadMore, Loading, MenuDivider, NewButton, NoMatches, Notice, Page, Tabs, barButton, compactButton, compactControlClass, inputClass, primaryButton, timeAgo, useDebounced, useDraft, useRun, wideControlClass, storedIds, useStored } from "../../ui";
import { MenuItem, Modal, Popover } from "../chat/common";
import { Board } from "./Board";
import { DatabaseDialog } from "./DatabaseDialog";
import { type ListArgs, type RecordType, type Row, type Sort, usePagedRows, useRefs } from "./data";
import { AddField } from "./fieldDialogs";
import { Chip, RecordPicker, useOptions } from "./fields";
import {
	type Filter,
	type Refs,
	type TypeField,
	defaultColumns,
	fromConditions,
	groupable,
	needsValue,
	opLabels,
	opsFor,
	recordPath,
	sortable,
	toCondition,
	valueText,
} from "./logic";

// One database's list: a table with chosen columns, or a board of cards grouped by a
// choice field. Sort by any column, filters, search, and pages that keep loading as you
// scroll. Deleted records are in Trash.

type Layout = "table" | "board";

/** Filters carry an id while in the bar, so each row keeps its own state as others come and go. */
type Settings = { filters: (Filter & { id: string })[]; sort?: Sort; columns: string[]; layout: Layout; groupBy?: string };

const noViews: never[] = [];
const viewKey = (v: { _id: string }) => v._id;

export function RecordList({ type, role }: { type: RecordType; role: Role }) {
	const views = useQuery(api.databaseViews.list, { typeId: type._id });
	// Saved views are shared; their order is yours (drag a tab). "All" stays first.
	const tabs = useSortable(`views.order:${type._id}`, views ?? noViews, viewKey, "x");
	const saveView = useMutation(api.databaseViews.save);
	const removeView = useMutation(api.databaseViews.remove);
	const [viewId, setViewId] = useState("all");
	const selected = views?.find((v) => v._id === viewId);
	const fields = type.fields.filter((f) => !f.archived) as TypeField[];
	const live = (key: string) => ["createdAt", "updatedAt", ...fields.map((f) => f.key)].includes(key);
	// "All" keeps the columns and layout people picked on this computer; a view's settings skip fields archived since.
	const [storedColumns, storeColumns] = useStored(`records.columns.${type.key}`, (saved) => (Array.isArray(saved) ? storedIds(saved) : undefined));
	const [storedLayout, storeLayout] = useStored(`records.layout.${type.key}`, (saved) =>
		saved && typeof saved === "object" && "layout" in saved ? (saved as { layout: Layout; groupBy?: string }) : undefined,
	);
	const saved: Settings | undefined = selected && {
		filters: fromConditions(selected.filters.filter((c) => live(c.field)), fields).map((f, i) => ({ ...f, id: String(i) })),
		sort: selected.sort && live(selected.sort.field) ? selected.sort : undefined,
		columns: selected.columns,
		layout: selected.layout ?? "table",
		groupBy: selected.groupBy,
	};
	const draft = useDraft<Settings>(
		saved ?? { filters: [], columns: storedColumns ?? defaultColumns(type.fields), layout: "table", ...storedLayout },
		selected?.version ?? 0,
	);
	const { filters, sort, layout } = draft.value;
	const columns = draft.value.columns.filter(live);
	// Like Notion, a board without a saved grouping uses the first field it can group by.
	const groupFields = fields.filter(groupable);
	const group = groupFields.find((f) => f.key === draft.value.groupBy) ?? groupFields[0];
	const change = (next: Partial<Settings>) => {
		const value = { ...draft.value, ...next };
		draft.set(value);
		if (!selected && next.columns) storeColumns(next.columns);
		if (!selected && (next.layout || next.groupBy)) storeLayout({ layout: value.layout, groupBy: value.groupBy });
	};
	const setFilters = (filters: Settings["filters"]) => change({ filters });
	const setSort = (sort: Sort | undefined) => change({ sort });
	const setColumns = (columns: string[]) => change({ columns });
	const open = (id: string) => (setViewId(id), draft.discard());
	// Someone deleted the open view.
	useEffect(() => {
		if (views && viewId !== "all" && !selected) open("all");
	}, [views, viewId, selected]);
	const [savingView, setSavingView] = useState(false);
	const [editingDatabase, setEditingDatabase] = useState(false);
	const [search, setSearch] = useState("");
	const query = useDebounced(search);
	const [creating, setCreating] = useState(false);
	// The field kind a new-field dialog starts on, while it's open.
	const [addingField, setAddingField] = useState<FieldKind>();
	const { error, run } = useRun();
	// The Save view dialog's own errors, so they don't show on the page behind it too.
	const naming = useRun();
	const shown = columns.map((k) => fields.find((f) => f.key === k)!);
	const conditions = filters.map(toCondition).filter((c) => c !== null);
	const canEdit = can(role, "records.edit");
	const sortField = sort && fields.find((f) => f.key === sort.field);
	const args = { typeId: type._id, filters: conditions, sort };
	const config = { filters: conditions, sort, columns, layout, groupBy: group?.key };
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
					{canEdit && <NewButton label={`New ${type.name.toLowerCase()}`} onClick={() => setCreating(true)} />}
				</>
			}
		>
			<Tabs
				tabs={[{ id: "all", label: "All" }, ...tabs.sorted.map((v) => ({ id: v._id as string, label: v.name }))]}
				drag={(id) => (id === "all" ? undefined : tabs.drag(id))}
				value={selected ? viewId : "all"}
				onChange={open}
				menu={
					canEdit && selected && saved
						? (close) => (
								<>
									{/* Renaming keeps the view as saved; unsaved changes stay yours until "Save for everyone". */}
									<Form
										className=""
										onSubmit={(form) => {
											const name = String(new FormData(form).get("name")).trim();
											close();
											if (name && name !== selected.name) {
												const columns = saved.columns.filter(live);
												const groupBy = saved.groupBy && live(saved.groupBy) ? saved.groupBy : undefined;
												const filters = saved.filters.map(toCondition).filter((c) => c !== null);
												run(saveView({ typeId: type._id, viewId: selected._id, version: selected.version, name, filters, sort: saved.sort, columns, layout: saved.layout, groupBy }));
											}
										}}
									>
										<input name="name" aria-label="View name" autoFocus required maxLength={120} defaultValue={selected.name} className={`${compactControlClass} w-full`} />
									</Form>
									<MenuDivider />
									<MenuItem
										danger
										onClick={() => (close(), confirm(`Delete the view ${selected.name}?`) && run(removeView({ viewId: selected._id, version: selected.version }), () => open("all")))}
									>
										<TrashIcon /> Delete view
									</MenuItem>
								</>
							)
						: undefined
				}
			>
				{canEdit && (
					<button type="button" title="Save these filters as a view" className={tabClass} onClick={() => setSavingView(true)}>
						<PlusIcon />
					</button>
				)}
				{canEdit && selected && draft.dirty && (
					<button type="button" disabled={draft.stale} className={`ml-auto self-center ${compactControlClass}`} onClick={() => run(saveView({ typeId: type._id, viewId: selected._id, version: draft.base, name: selected.name, ...config }), draft.discard)}>
						Save for everyone
					</button>
				)}
			</Tabs>
			<Notice>{error}</Notice>
			<ConflictNotice draft={draft} />
			<div className="flex flex-wrap items-center gap-3 text-sm">
				<input
					type="search"
					value={search}
					onChange={(e) => setSearch(e.target.value)}
					placeholder={`Search ${noun}`}
					className={wideControlClass}
				/>
				<button type="button" onClick={() => setFilters([...filters, { id: crypto.randomUUID(), field: fields[0]!.key, op: opsFor(fields[0]!)[0]!, value: "" }])} className={compactButton}>
					<FilterIcon className="text-neutral-400" /> Filter
				</button>
				<ColumnsPicker
					label={layout === "board" ? "Properties" : "Columns"}
					fields={fields}
					columns={columns}
					onChange={setColumns}
					onNewField={can(role, "fields.create") ? () => setAddingField("text") : undefined}
				/>
				{layout === "board" && group && (
					<label className="flex items-center gap-2 text-neutral-600">
						Group by
						<Select value={group.key} options={groupFields.map((f) => ({ value: f.key, label: f.label }))} onChange={(groupBy) => change({ groupBy })} />
					</label>
				)}
				<span className="ml-auto">
					<Segmented
						label="Layout"
						value={layout}
						options={[
							{ value: "table", label: "Table" },
							{ value: "board", label: "Board" },
						]}
						onChange={(l) => change({ layout: l })}
					/>
				</span>
			</div>
			{filters.length > 0 && (
				<div className="-mt-2 flex flex-col gap-2">
					{filters.map((f) => (
						<FilterRow
							key={f.id}
							fields={fields}
							filter={f}
							onChange={(next) => setFilters(filters.map((g) => (g === f ? { ...next, id: f.id } : g)))}
							onRemove={() => setFilters(filters.filter((g) => g !== f))}
						/>
					))}
				</div>
			)}
			{query.trim() ? (
				<>
					<p className="-mt-2 text-xs text-neutral-500">Top 20 live {noun} matching the name or text. Filters and sort don't apply to search.</p>
					<SearchResults type={type} query={query} columns={shown} />
				</>
			) : (
				<>
					{sortField && (
						<p className="-mt-2 text-xs text-neutral-500">
							Sorted by {sortField.label}: {noun} without one aren't listed.
						</p>
					)}
					{/* A query error (a bad filter, an old page) shows here; changing the list clears it. */}
					<ErrorBoundary key={JSON.stringify([args, layout, group?.key])}>
						<RecordResults
							type={type} args={args} columns={shown} sort={sort} onSort={setSort}
							layout={layout} group={group} canEdit={canEdit}
							noGroup={<EmptyState icon={<DatabaseIcon />} title="No choice field to group by">Open a record and use Add field to add a choice field for grouping cards.</EmptyState>}
							empty={filters.length || sort ? <NoMatches /> : <EmptyState icon={<DatabaseIcon />} title={`No ${noun} yet`}>Keep your {noun} and their details here.</EmptyState>}
						/>
					</ErrorBoundary>
				</>
			)}
			{editingDatabase && <DatabaseDialog type={type} onClose={() => setEditingDatabase(false)} />}
			{savingView && (
				<Modal title="Save view" onClose={() => setSavingView(false)}>
					<Form
						onSubmit={(form) => {
							const name = String(new FormData(form).get("name"));
							naming.run(saveView({ typeId: type._id, name, ...config }).then((id) => (open(id), setSavingView(false))));
						}}
					>
						<Notice>{naming.error}</Notice>
						<Field label="View name" hint="These filters, sort, columns and layout, shared with everyone in the workspace.">
							<input name="name" autoFocus required maxLength={120} className={inputClass} />
						</Field>
						<button type="submit" className={`${primaryButton} self-start`}>
							Save for everyone
						</button>
					</Form>
				</Modal>
			)}
			{creating && <NewRecord type={type} onClose={() => setCreating(false)} />}
			{addingField && <AddField type={type} kind={addingField} onCreated={(key) => setColumns([...columns, key])} onClose={() => setAddingField(undefined)} />}
		</Page>
	);
}

function RecordResults({
	type,
	args,
	columns,
	sort,
	onSort,
	layout, group, canEdit, noGroup,
	empty,
}: {
	type: RecordType;
	args: ListArgs;
	columns: TypeField[];
	sort?: Sort;
	onSort: (sort: Sort | undefined) => void;
	empty: React.ReactNode;
	layout: Layout;
	group?: TypeField;
	canEdit: boolean;
	noGroup: React.ReactNode;
}) {
	const { rows, refs, status, loadMore, setEnd } = usePagedRows(args);

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
	if (rows.length === 0 && status === "Exhausted") return empty;
	if (layout === "board" && rows.length > 0) return group ? <Board type={type} args={args} group={group} cards={columns} canEdit={canEdit} /> : noGroup;
	// A board still looking past empty pages shows only the loader, not a table.
	return (
		<div className="flex flex-col gap-2">
			{layout === "table" && <RowsTable
				type={type}
				rows={rows}
				refs={refs}
				columns={columns}
				head={[
					...columns.map((f) => header(f.key, f.label, sortable(f))),
					header("updatedAt", "Updated", true),
				]}
			/>}
			<div ref={setEnd} className="flex flex-col items-center py-2">
				<LoadMore status={status} onMore={() => loadMore(25)} />
			</div>
		</div>
	);
}

function RowsTable({ type, rows, refs, columns, head }: { type: RecordType; rows: Row[]; refs: Refs; columns: TypeField[]; head: React.ReactNode[] }) {
	return (
		// Too wide for the column: it scrolls out to the screen's edges.
		<div className="bleed">
			<div className="w-max min-w-full overflow-hidden rounded-xl border border-neutral-200">
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
		</div>
	);
}

function SearchResults({ type, query, columns }: { type: RecordType; query: string; columns: TypeField[] }) {
	const rows = useQuery(api.records.search, { query, typeId: type._id });
	const refs = useRefs(rows ?? []);
	if (!rows) return <Loading />;
	if (rows.length === 0) return <NoMatches />;
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
			<Select
				label="Field"
				value={field.key}
				options={fields.map((f) => ({ value: f.key, label: f.label }))}
				onChange={(key) => {
					const next = fields.find((f) => f.key === key)!;
					onChange({ field: next.key, op: opsFor(next)[0]!, value: "" });
				}}
			/>
			<Select label="Condition" value={filter.op} options={opsFor(field).map((op) => ({ value: op, label: opLabels[op] }))} onChange={(op) => onChange({ ...filter, op })} />
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
					<Select
						value=""
						options={options.filter((o) => !ids.includes(o.id)).map((o) => ({ value: o.id, label: o.label }))}
						onChange={(id) => onChange([...ids, id])}
					/>
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

function ColumnsPicker({
	label,
	fields,
	columns,
	onChange,
	onNewField,
}: {
	label: string;
	fields: TypeField[];
	columns: string[];
	onChange: (keys: string[]) => void;
	/** Opens the new-field dialog; the field is shown once made. */
	onNewField?: () => void;
}) {
	return (
		<Popover
			trigger={
				<>
					<PropertiesIcon className="text-neutral-400" /> {label}
				</>
			}
			className={compactButton}
			panelClassName="flex w-56 flex-col gap-px p-1"
		>
			{(close) => (
				<>
					{fields.map((f) => (
						<label key={f.key} className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-neutral-100">
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
					{onNewField && (
						<>
							<MenuDivider />
							<MenuItem onClick={() => (close(), onNewField())}>
								<PlusIcon className="text-neutral-400" /> New field
							</MenuItem>
						</>
					)}
				</>
			)}
		</Popover>
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
			<Form onSubmit={() => run(create({ typeId: type._id, values: { name } }).then((id) => navigate(...recordPath(type.key, id))))}>
				<Notice>{error}</Notice>
				<Field label={label}>
					<input autoFocus value={name} onChange={(e) => setName(e.target.value)} className={inputClass} />
				</Field>
				<button type="submit" className={`${primaryButton} self-start`}>
					Create
				</button>
			</Form>
		</Modal>
	);
}
