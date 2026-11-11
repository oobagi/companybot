import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import { type Access, can } from "@companybot/core/permissions";
import { type FieldValue, NAME_KEY } from "@companybot/core/records";
import type { FunctionReturnType } from "convex/server";
import { useEffect, useMemo, useState } from "react";
import { api } from "../../api";
import { useMutation, usePaginatedQuery, useQuery } from "../../convex";
import { navigate } from "../../router";
import { ArchiveIcon, ChatIcon, DatabaseIcon, DragHandleIcon, FollowUpIcon, HistoryIcon, LinkedIcon, PinIcon, PlusIcon, RestoreIcon, SparkleIcon, UnpinIcon } from "../../icons";
import { usePins } from "../../pins";
import { LoadMore, NotFound, Notice, Section, Tabs, cardButton, cardClass, compactButton, descriptionClass, labelButton, linkButton, metadataClass, smallIconButton, timeAgo, titleButton, useRun } from "../../ui";
import { MenuItem, Modal, Popover, archiveQuestion, useConfirm } from "../chat/common";
import { type RecordType, useTypes } from "./data";
import { PageHistory } from "../pages/PageHistory";
import { PageView } from "../Pages";
import { TrashNotice } from "../Trash";
import { WakeupList } from "../Wakeups";
import { AddField, EditField } from "./fieldDialogs";
import { type DragProps, applyOrder, splitDrag, useDragList } from "../../sortable";
import { FieldSuggestion, type Suggestion } from "./FieldSuggestion";
import { Chip, FieldIcon, ValueEditor, ValueView } from "./fields";
import { type Refs, type TypeField, actionLabels, recordPath, valueText, whoLabel } from "./logic";

// One record's page: the page screen every page has (Pages.tsx `PageView`), with the record's
// properties above its body, Notion's way, and what else is about it as quiet rows under them
// (records linking here, chat messages mentioning it, follow-ups). History has property changes
// with undo, and the body's versions. The same page for every type.

export function RecordPage({ type, recordId, access }: { type: RecordType; recordId: Id<"records">; access: Access }) {
	const record = useQuery(api.records.get, { recordId });
	const pageId = useQuery(api.pages.forRecord, { recordId });
	const [history, setHistory] = useState(false);
	const remove = useMutation(api.trash.move);
	const { confirm, dialog } = useConfirm();
	const update = useMutation(api.records.update);
	const { pins, toggle } = usePins();
	const pinned = pins.includes(`rec:${recordId}`);
	const found = !!record && record.typeId === type._id;
	const body = useBody(recordId, pageId, found && can(access, "pages.edit") && record.canEdit && !record.archived);
	const crumbs = [{ label: type.plural, to: recordPath(type.key) }];
	if (!record || !found) {
		return <NotFound crumbs={crumbs} loaded={record !== undefined} icon={<DatabaseIcon />} title={`${type.name} not found`} />;
	}
	// The switch, and Edit in its database's Who can access list; or Add, for a record they made (`record.canEdit`).
	const canEdit = type.canEdit || (type.canAdd && record.canEdit);

	return (
		<PageView
			title={record.title}
			crumbs={crumbs}
			editableTitle={canEdit && !record.archived}
			onRename={(name) => update({ recordId, values: { name } })}
			menu={(close) => <>
				{!record.archived && <MenuItem onClick={() => { close(); toggle(`rec:${recordId}`); }}>{pinned ? <><UnpinIcon /> Unpin from rail</> : <><PinIcon /> Pin to rail</>}</MenuItem>}
				<MenuItem onClick={() => { close(); setHistory(true); }}><HistoryIcon /> History</MenuItem>
				{canEdit && !record.archived && <MenuItem onClick={() => { close(); confirm(archiveQuestion(record.title, () => remove({ kind: "record", id: recordId }), "Pages inside it will be archived with it.")); }}><ArchiveIcon /> Archive</MenuItem>}
			</>}
			notices={
				<>
					<Notice>{body.error}</Notice>
					{dialog}
					{record.trash && <TrashNotice trash={record.trash} />}
				</>
			}
			above={
				<div className="flex flex-col gap-1">
					<Fields type={type} record={record} editable={canEdit && !record.archived} />
					<About recordId={recordId} />
				</div>
			}
			body={body.page}
		>
			<RecordHistory open={history} onClose={() => setHistory(false)} type={type} recordId={recordId} pageId={pageId} canUndo={canEdit} canRestore={can(access, "pages.edit") && type.canEdit && !record.archived} />
		</PageView>
	);
}

type RecordDoc = NonNullable<FunctionReturnType<typeof api.records.get>>;

/**
 * The record's page body, as PageView takes it. It's made the first time someone who can edit opens the
 * record (or an agent writes in it), so records nobody opens carry no empty documents. Creating is idempotent.
 */
function useBody(recordId: Id<"records">, pageId: Id<"pages"> | null | undefined, editable: boolean) {
	const create = useMutation(api.pages.create);
	const { error, run } = useRun();
	const missing = pageId === null && editable;
	useEffect(() => {
		if (missing) void run(create({ recordId }));
	}, [missing, recordId]);
	const page = pageId ? { pageId, editable } : pageId === null && (!editable || error) ? null : undefined;
	return { page, error };
}

function Fields({ type, record, editable }: { type: RecordType; record: RecordDoc; editable: boolean }) {
	const [adding, setAdding] = useState(false);
	const [editing, setEditing] = useState<TypeField>();
	// The name is the page's title, edited there like Notion's.
	const live = useMemo(() => type.fields.filter((f) => !f.archived && f.key !== NAME_KEY) as TypeField[], [type.fields]);
	const suggestions = useQuery(api.fieldAi.suggestions, { recordId: record._id });
	const { shown, drag } = useFieldOrder(type, live);
	// Body-sized, like the page under it (Notion's properties read at the text's size).
	return (
		<section className="flex flex-col gap-1 text-base">
			<dl className="flex flex-col gap-1">
				{shown.map((field) => (
					<FieldRow
						key={field._id}
						field={field}
						record={record}
						editable={editable}
						suggestion={suggestions?.find((s) => s.fieldKey === field.key)}
						onEditField={field.canEdit ? () => setEditing(field) : undefined}
						drag={drag(field._id)}
					/>
				))}
			</dl>
			<div className="pt-2">
				{type.canManage && !record.archived && (
					<button type="button" onClick={() => setAdding(true)} className={labelButton}>
						<PlusIcon /> Add field
					</button>
				)}
			</div>
			{adding && <AddField type={type} onClose={() => setAdding(false)} />}
			{editing && <EditField field={editing} type={type} onClose={() => setEditing(undefined)} />}
		</section>
	);
}

/** Marks a value AI wrote, until someone changes it. */
const AiMark = () => (
	<span title="Filled by AI from a conversation. It stops being marked once someone changes it." className="shrink-0 text-neutral-400">
		<SparkleIcon />
	</span>
);

/**
 * The fields' order, by dragging a field's name: the database's order, so it moves for everyone (its lists'
 * column order too), like Notion's properties. Whoever may change its fields can. Shown in the new order at
 * once, until the server's matches.
 */
function useFieldOrder(type: RecordType, live: TypeField[]) {
	const update = useMutation(api.fields.update);
	const [pending, setPending] = useState<string[]>();
	const ids = live.map((f) => f._id).join();
	useEffect(() => setPending((p) => (p?.join() === ids ? undefined : p)), [ids]);
	const shown = useMemo(() => (pending ? applyOrder(pending, live, (f) => f._id) : live), [pending, live]);
	const { item } = useDragList({
		enabled: type.canManage,
		onDrop: (from, index) => {
			const order = shown.map((f) => f._id).filter((id) => id !== from.id);
			order.splice(index, 0, from.id);
			if (order.join() === shown.map((f) => f._id).join()) return;
			setPending(order);
			// Positions count Name, first.
			update({ fieldId: from.id as Id<"recordFields">, position: index + 1 }).catch(() => setPending(undefined));
		},
	});
	return { shown, drag: item };
}

function FieldRow({ field, record, editable, suggestion, onEditField, drag }: { field: TypeField; record: RecordDoc; editable: boolean; suggestion?: Suggestion; onEditField?: () => void; drag?: DragProps }) {
	const { box, handle } = splitDrag(drag);
	const update = useMutation(api.records.update);
	const { error, run } = useRun();
	const value = record.values[field.key] as FieldValue | undefined;
	const byAi = record.aiFilled.includes(field.key);
	return (
		<div {...box} className={`group relative grid grid-cols-[10rem_1fr] items-start gap-x-4 ${box.className}`}>
			{/* The label opens the field's settings, for whoever may change them; dragging it (or its grip) moves the field. */}
			<dt {...handle} className="relative flex min-w-0 items-center py-1 text-neutral-500">
				{/* Hovered, its grip shows in the margin, centered on the name, as a page block's does; pressing it picks the field up through its name. */}
				{handle && (
					<button type="button" aria-label="Drag to move" title="Drag to move" className={`${smallIconButton} absolute top-1/2 right-full mr-1 -translate-y-1/2 cursor-grab text-lg opacity-0 group-hover:opacity-100 focus-visible:opacity-100`}>
						<DragHandleIcon weight="bold" />
					</button>
				)}
				{onEditField ? (
					<button type="button" onClick={onEditField} title="Edit field" className={`${titleButton} -mx-1.5 flex max-w-full items-center gap-2 rounded-md px-1.5 py-0.5 hover:bg-neutral-100`}>
						<FieldIcon field={field} large /> <span className="truncate">{field.label}</span>
						{field.changing && <span className={metadataClass}>Converting…</span>}
						{byAi && <AiMark />}
					</button>
				) : (
					<span className="flex min-w-0 items-center gap-2 py-0.5"><FieldIcon field={field} large /> <span className="truncate">{field.label}</span>{byAi && <AiMark />}</span>
				)}
			</dt>
			<dd className="flex min-w-0 flex-col">
				{/* A suggestion takes the value's place: someone accepts or dismisses it before editing. */}
				{suggestion && editable ? (
					<FieldSuggestion suggestion={suggestion} current={value === undefined ? undefined : <ValueView field={field} value={value} refs={record.refs} />} editable />
				) : editable && !field.changing ? (
					<ValueEditor
						field={field}
						value={value}
						refs={record.refs}
						onSave={(next) => run(update({ recordId: record._id, values: { [field.key]: next } }))}
					/>
				) : (
					<span className="px-2 py-1">
						<ValueView field={field} value={value} refs={record.refs} />
					</span>
				)}
				{error && <span className="px-2 pb-1 text-xs text-red-600">{error}</span>}
			</dd>
		</div>
	);
}

/**
 * What else is about this record, as rows like its properties (Notion's backlinks): live records that link here
 * ("Deals · Client"), chat messages that mention it, and follow-ups agents set about it. Only rows with something.
 */
function About({ recordId }: { recordId: Id<"records"> }) {
	const types = useTypes();
	const { results, status, loadMore } = usePaginatedQuery(api.records.linked, { recordId }, { initialNumItems: 25 });
	const messages = useQuery(api.records.discussion, { recordId });
	const wakeups = useQuery(api.wakeups.list, { recordId });
	if (!types) return null;
	const groups = new Map<string, typeof results>();
	for (const r of results) groups.set(`${r.typeId}:${r.fieldId}`, [...(groups.get(`${r.typeId}:${r.fieldId}`) ?? []), r]);
	if (!groups.size && !messages?.length && !wakeups?.length) return null;
	return (
		<dl className="grid grid-cols-[10rem_1fr] items-start gap-x-4 gap-y-1">
			{[...groups.entries()].map(([key, rows], i) => {
				const type = types.find((t) => t._id === rows[0]!.typeId);
				const field = type?.fields.find((f) => f._id === rows[0]!.fieldId);
				if (!type) return null;
				return (
					<AboutRow key={key} icon={<LinkedIcon />} label={field ? `${type.plural} · ${field.label}` : type.plural}>
						<span className="flex flex-wrap items-center gap-1.5 py-0.5">
							{rows.map((r) => (
								<Chip key={r._id}>
									<button type="button" onClick={() => navigate(...recordPath(type.key, r._id))} title={summary(type, r.values, r.refs)} className={linkButton}>
										{r.title}
									</button>
								</Chip>
							))}
							{i === groups.size - 1 && <LoadMore status={status} onMore={() => loadMore(25)} />}
						</span>
					</AboutRow>
				);
			})}
			{!!messages?.length && (
				// The chat messages that tag this record (@ in the composer, or an agent's reply).
				<AboutRow icon={<ChatIcon />} label="In chat">
					<Popover trigger={`Tagged in ${messages.length}${messages.length === 50 ? "+" : ""} ${messages.length === 1 ? "message" : "messages"}`} className={`${linkButton} py-0.5`} panelClassName="flex max-h-96 w-96 flex-col gap-2 overflow-y-auto p-2">
						{messages.map((m) => (
							<button
								key={m.messageId}
								type="button"
								onClick={() => navigate("chat", m.chatId, ...(m.threadId ? ["thread", m.threadId] : ["message", m.messageId]))}
								className={`flex-col gap-1 text-sm ${cardButton}`}
							>
								<span className="flex min-w-0 items-baseline gap-2">
									<span className="truncate font-medium">{m.author}</span>
									<span className={`min-w-0 truncate ${metadataClass}`}>{m.where}</span>
									<span className={`ml-auto shrink-0 ${metadataClass}`}>{timeAgo(m.time)}</span>
								</span>
								<span className="line-clamp-3 text-neutral-600">{m.text}</span>
							</button>
						))}
					</Popover>
				</AboutRow>
			)}
			{!!wakeups?.length && (
				<AboutRow icon={<FollowUpIcon />} label="Follow-ups">
					<Popover trigger={`${wakeups.length} pending`} className={`${linkButton} py-0.5`} panelClassName="flex max-h-96 w-96 flex-col overflow-y-auto p-2">
						<WakeupList wakeups={wakeups} recordId={recordId} />
					</Popover>
				</AboutRow>
			)}
		</dl>
	);
}

/** One row beside the properties, lined up with them. */
function AboutRow({ icon, label, children }: { icon: React.ReactNode; label: string; children: React.ReactNode }) {
	return (
		<>
			<dt className={`flex min-w-0 items-center gap-2 py-1 ${descriptionClass}`}>
				<span className="shrink-0 text-neutral-400">{icon}</span>
				<span className="truncate" title={label}>{label}</span>
			</dt>
			<dd className="flex min-w-0 px-2 py-0.5 text-sm">{children}</dd>
		</>
	);
}

/** A linked record's first few values, after its name: "Proposal · $12,000.00". */
function summary(type: RecordType, values: Record<string, FieldValue>, refs: Refs) {
	return (type.fields as TypeField[])
		.filter((f) => !f.archived && f.key !== "name" && f.kind !== "link" && values[f.key] !== undefined)
		.slice(0, 3)
		.map((f) => valueText(f, values[f.key], refs))
		.join(" · ");
}

/** Who changed what, old → new, newest first. Each change can be undone unless something changed it since. */
function History({ type, recordId, canUndo }: { type: RecordType; recordId: Id<"records">; canUndo: boolean }) {
	const { results, status, loadMore } = usePaginatedQuery(api.records.history, { recordId }, { initialNumItems: 20 });
	const undo = useMutation(api.records.undo);
	const { confirm, dialog } = useConfirm();
	const { error, run } = useRun();
	const fields = type.fields as TypeField[];
	if (status === "LoadingFirstPage") return null;
	return (
		<Section title="Property changes">
			{dialog}
			<Notice>{error}</Notice>
			<div className="flex flex-col gap-2">
				{results.map((e) => (
					<div key={e._id} className={`flex flex-col gap-1 text-sm ${cardClass}`}>
						<div className="flex min-h-7 items-center gap-2">
							<span className="font-medium">{e.undoes ? "Undid a change" : (actionLabels[e.action] ?? e.action)}</span>
							<span className="text-neutral-500">by {whoLabel(e)}</span>
							<span className={`ml-auto shrink-0 ${metadataClass}`}>{timeAgo(e.time)}</span>
							{e.undone ? (
								<span className={metadataClass}>Undone</span>
							) : (
								canUndo && (
									<button type="button" onClick={() => e.action === "created" || e.action === "restored" ? confirm(archiveQuestion("this record", () => undo({ historyId: e._id }), "Undoing this change archives the record.")) : run(undo({ historyId: e._id }))} className={compactButton}>
										<RestoreIcon /> Undo
									</button>
								)
							)}
						</div>
						{e.action !== "archived" && e.action !== "restored" && e.changes.length > 0 && (
							<ul className="flex flex-col gap-0.5 text-neutral-600">
								{e.changes.map((c) => {
									const field = fields.find((f) => f.key === c.key);
									const text = (v: unknown) => valueText(field, v as FieldValue | undefined, e.refs) || "empty";
									return (
										<li key={c.key} className="break-words">
											<span className="text-neutral-500">{c.label}:</span>{" "}
											{e.action === "created" ? text(c.new) : <>{text(c.old)} → {text(c.new)}</>}
										</li>
									);
								})}
							</ul>
						)}
					</div>
				))}
			</div>
			<LoadMore status={status} onMore={() => loadMore(20)} />
		</Section>
	);
}

function RecordHistory({ open, onClose, type, recordId, pageId, canUndo, canRestore }: { open: boolean; onClose: () => void; type: RecordType; recordId: Id<"records">; pageId: Id<"pages"> | null | undefined; canUndo: boolean; canRestore: boolean }) {
	const [tab, setTab] = useState<"properties" | "body">("properties");
	if (!open) return null;
	const tabs = <Tabs tabs={[{ id: "properties", label: "Properties" }, { id: "body", label: "Page body" }]} value={tab} onChange={setTab} />;
	return tab === "body" && pageId ? <PageHistory pageId={pageId} canRestore={canRestore} onClose={onClose} tabs={tabs} /> : <Modal title="History" size="xl" onClose={onClose}>{tabs}{tab === "properties" ? <History type={type} recordId={recordId} canUndo={canUndo} /> : <p className={descriptionClass}>No page edits yet.</p>}</Modal>;
}
