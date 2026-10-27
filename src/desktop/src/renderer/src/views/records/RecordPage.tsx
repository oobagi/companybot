import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import type { Role } from "@companybot/core";
import { can } from "@companybot/core/permissions";
import type { FieldValue } from "@companybot/core/records";
import type { FunctionReturnType } from "convex/server";
import { useState } from "react";
import { api } from "../../api";
import { useMutation, usePaginatedQuery, useQuery } from "../../convex";
import { navigate } from "../../router";
import { LoadMore, Loading, Notice, Page, Section, Tabs, descriptionClass, metadataClass, timeAgo, useRun } from "../../ui";
import { Modal } from "../chat/common";
import { type RecordType, useTypes } from "./data";
import { PageEditor } from "../pages/PageEditor";
import { PageHistory } from "../pages/PageHistory";
import { PageTitle } from "../pages/PageTitle";
import { AddField, EditField } from "./fieldDialogs";
import { ValueEditor, ValueView } from "./fields";
import { type Refs, type TypeField, actionLabels, recordPath, valueText, whoLabel } from "./logic";

// One record's page: its fields, editable in place, its page body (notes, plans: a page,
// wiki/pages.md), then what links to it, where it was discussed, and its history with undo.
// The same page for every type.

export function RecordPage({ type, recordId, role }: { type: RecordType; recordId: Id<"records">; role: Role }) {
	const record = useQuery(api.records.get, { recordId });
	const pageId = useQuery(api.pages.forRecord, { recordId });
	const [history, setHistory] = useState(false);
	const archive = useMutation(api.records.archive);
	const update = useMutation(api.records.update);
	const restore = useMutation(api.records.restore);
	const { error, run } = useRun();
	const back = { label: type.plural, to: recordPath(type.key) };
	if (record === undefined) return <Page title="" back={back}><Loading /></Page>;
	if (record === null || record.typeId !== type._id) {
		return (
			<Page title="Not found" back={back}>
				<p className={descriptionClass}>This {type.name.toLowerCase()} isn't in your workspace.</p>
			</Page>
		);
	}
	const canEdit = can(role, "records.edit");

	return (
		<Page
			title={<PageTitle title={record.title} editable={canEdit && !record.archived} onSave={(name) => update({ recordId, values: { name } })} />}
			subtitle={record.archived ? `${type.name} · Archived` : type.name}
			back={back}
			actions={<div className="flex gap-4">
				<button type="button" onClick={() => setHistory(true)} className={`${descriptionClass} hover:text-neutral-900`}>History</button>
				{canEdit && <button type="button" onClick={() => run(record.archived ? restore({ recordId }) : archive({ recordId }))} className={`${descriptionClass} hover:text-neutral-900`}>{record.archived ? "Restore" : "Archive"}</button>}
			</div>}
		>
			{error && <Notice>{error}</Notice>}
			{record.archived && (
				<p className="-mt-3 rounded-xl bg-neutral-50 px-4 py-3 text-sm text-neutral-600">
					Archived: it's out of lists and search, and links to it show as archived.{canEdit && " Restore it to make changes."}
				</p>
			)}
			<Fields type={type} record={record} role={role} editable={canEdit && !record.archived} />
			<Body recordId={recordId} pageId={pageId} editable={can(role, "pages.edit") && !record.archived} />
			<Linked recordId={recordId} archived={record.archived} />
			<Discussion recordId={recordId} />
			<RecordHistory open={history} onClose={() => setHistory(false)} type={type} recordId={recordId} pageId={pageId} canUndo={canEdit} canRestore={can(role, "pages.edit") && !record.archived} />
		</Page>
	);
}

type RecordDoc = NonNullable<FunctionReturnType<typeof api.records.get>>;

/** The record's page body. It's made when someone first writes in it. */
function Body({ recordId, pageId, editable }: { recordId: Id<"records">; pageId: Id<"pages"> | null | undefined; editable: boolean }) {
	const create = useMutation(api.pages.create);
	const { error, run } = useRun();
	if (pageId === undefined || (pageId === null && !editable)) return null;
	return (
		<section className="flex flex-col gap-2 border-t border-neutral-200 pt-4">
			{error && <Notice>{error}</Notice>}
			{pageId ? (
				<PageEditor pageId={pageId} editable={editable} />
			) : (
				<button type="button" onClick={() => run(create({ recordId }))} className="py-1 text-left text-neutral-400 hover:text-neutral-600">
					Write notes, plans, anything…
				</button>
			)}
		</section>
	);
}

function Fields({ type, record, role, editable }: { type: RecordType; record: RecordDoc; role: Role; editable: boolean }) {
	const [adding, setAdding] = useState(false);
	const [editing, setEditing] = useState<TypeField>();
	const live = type.fields.filter((f) => !f.archived) as TypeField[];
	const archived = type.fields.filter((f) => f.archived && f.canEdit) as TypeField[];
	return (
		<section className="flex flex-col gap-1">
			<dl className="grid grid-cols-[10rem_1fr] items-start gap-x-4 gap-y-1">
				{live.map((field) => (
					<FieldRow
						key={field._id}
						field={field}
						record={record}
						editable={editable}
						onEditField={field.canEdit ? () => setEditing(field) : undefined}
					/>
				))}
			</dl>
			<div className="flex gap-4 pt-2 text-sm">
				{can(role, "fields.create") && (
					<button type="button" onClick={() => setAdding(true)} className="text-neutral-500 hover:text-neutral-900">
						+ Add field
					</button>
				)}
			</div>
			{archived.length > 0 && <ArchivedFields fields={archived} />}
			{adding && <AddField type={type} onClose={() => setAdding(false)} />}
			{editing && <EditField field={editing} onClose={() => setEditing(undefined)} />}
		</section>
	);
}

function FieldRow({ field, record, editable, onEditField }: { field: TypeField; record: RecordDoc; editable: boolean; onEditField?: () => void }) {
	const update = useMutation(api.records.update);
	const { error, run } = useRun();
	const value = record.values[field.key] as FieldValue | undefined;
	return (
		<>
			<dt className={`group flex items-center gap-2 py-1.5 ${descriptionClass}`}>
				<span className="truncate">{field.label}</span>
				{onEditField && (
					<button type="button" onClick={onEditField} className={`invisible ${metadataClass} group-hover:visible hover:text-neutral-700`}>
						Edit
					</button>
				)}
			</dt>
			<dd className="flex min-w-0 flex-col">
				{editable ? (
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
		</>
	);
}

function ArchivedFields({ fields }: { fields: TypeField[] }) {
	const restore = useMutation(api.fields.restore);
	const { error, run } = useRun();
	return (
		<div className={`flex flex-col gap-1 pt-2 ${descriptionClass}`}>
			{error && <Notice>{error}</Notice>}
			<p>
				Archived fields:{" "}
				{fields.map((f, i) => (
					<span key={f._id}>
						{i > 0 && ", "}
						{f.label}{" "}
						<button type="button" onClick={() => run(restore({ fieldId: f._id as Id<"recordFields"> }))} className="hover:text-neutral-900 hover:underline">
							Restore
						</button>
					</span>
				))}
			</p>
		</div>
	);
}

/** Live records that link here ("deals for this client"), grouped by type and field. */
function Linked({ recordId, archived }: { recordId: Id<"records">; archived: boolean }) {
	const types = useTypes();
	const { results, status, loadMore } = usePaginatedQuery(api.records.linked, { recordId }, { initialNumItems: 25 });
	if (archived || !types || (results.length === 0 && status === "Exhausted")) return null;
	const groups = new Map<string, typeof results>();
	for (const r of results) groups.set(`${r.typeId}:${r.fieldId}`, [...(groups.get(`${r.typeId}:${r.fieldId}`) ?? []), r]);
	return (
		<Section title="Linked">
			{[...groups.entries()].map(([key, rows]) => {
				const type = types.find((t) => t._id === rows[0]!.typeId);
				const field = type?.fields.find((f) => f._id === rows[0]!.fieldId);
				if (!type) return null;
				return (
					<div key={key} className="flex flex-col gap-1">
						<p className={descriptionClass}>
							{type.plural}
							{field && <span className="text-neutral-400"> · {field.label}</span>}
						</p>
						<div className="flex flex-col divide-y divide-neutral-100 rounded-xl border border-neutral-200">
							{rows.map((r) => (
								<button
									key={r._id}
									type="button"
									onClick={() => navigate(...recordPath(type.key, r._id))}
									className="flex items-baseline gap-3 px-4 py-2 text-left text-sm hover:bg-neutral-50"
								>
									<span className="font-medium">{r.title}</span>
									<span className="truncate text-neutral-500">{summary(type, r.values, r.refs)}</span>
								</button>
							))}
						</div>
					</div>
				);
			})}
			<LoadMore status={status} onMore={() => loadMore(25)} />
		</Section>
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

/** Chat messages that mention this record, each opening the message in its chat. */
function Discussion({ recordId }: { recordId: Id<"records"> }) {
	const messages = useQuery(api.records.discussion, { recordId });
	if (!messages?.length) return null;
	return (
		<Section title="Discussion">
			<div className="flex flex-col gap-2">
				{messages.map((m) => (
					<button
						key={m.messageId}
						type="button"
						onClick={() => navigate("chat", m.chatId, ...(m.threadId ? ["thread", m.threadId] : ["message", m.messageId]))}
						className="flex flex-col gap-1 rounded-xl border border-neutral-200 px-4 py-3 text-left text-sm hover:bg-neutral-50"
					>
						<span className="flex items-baseline gap-2">
							<span className="font-medium">{m.author}</span>
							<span className={`ml-auto ${metadataClass}`}>{timeAgo(m.time)}</span>
						</span>
						<span className="line-clamp-3 text-neutral-600">{m.text}</span>
					</button>
				))}
			</div>
		</Section>
	);
}

/** Who changed what, old → new, newest first. Each change can be undone unless something changed it since. */
function History({ type, recordId, canUndo }: { type: RecordType; recordId: Id<"records">; canUndo: boolean }) {
	const { results, status, loadMore } = usePaginatedQuery(api.records.history, { recordId }, { initialNumItems: 20 });
	const undo = useMutation(api.records.undo);
	const { error, run } = useRun();
	const fields = type.fields as TypeField[];
	if (status === "LoadingFirstPage") return null;
	return (
		<Section title="Property changes">
			{error && <Notice>{error}</Notice>}
			<div className="flex flex-col gap-2">
				{results.map((e) => (
					<div key={e._id} className="flex flex-col gap-1 rounded-xl border border-neutral-200 px-4 py-3 text-sm">
						<div className="flex items-baseline gap-2">
							<span className="font-medium">{e.undoes ? "Undid a change" : (actionLabels[e.action] ?? e.action)}</span>
							<span className="text-neutral-500">by {whoLabel(e)}</span>
							<span className={`ml-auto shrink-0 ${metadataClass}`}>{timeAgo(e.time)}</span>
							{e.undone ? (
								<span className={metadataClass}>Undone</span>
							) : (
								canUndo && (
									<button type="button" onClick={() => run(undo({ historyId: e._id }))} className="text-xs text-neutral-500 hover:text-neutral-900">
										Undo
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
	return tab === "body" && pageId ? <PageHistory pageId={pageId} canRestore={canRestore} onClose={onClose} tabs={tabs} /> : <Modal title="History" wide onClose={onClose}>{tabs}{tab === "properties" ? <History type={type} recordId={recordId} canUndo={canUndo} /> : <p className={descriptionClass}>No page edits yet.</p>}</Modal>;
}
