import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import { Checkbox, Select } from "../../controls";
import { type FieldKind, NAME_KEY, fieldKinds } from "@companybot/core/records";
import type { FunctionArgs } from "convex/server";
import { useState } from "react";
import { api } from "../../api";
import { useMutation, useQuery } from "../../convex";
import { Form, Notice, Setting, Settings, compactControlClass, hintClass, iconDangerButton, metadataClass, notePanelClass, primaryButton, secondaryButton, smallButton, timeAgo, useDebounced, useRun, wideControlClass } from "../../ui";
import { ArchiveIcon, TrashIcon } from "../../icons";
import { DialogButtons, MenuItem, Modal, archiveQuestion, useConfirm } from "../chat/common";
import { type RecordType, useTypes } from "./data";
import { type TypeField, kindLabels } from "./logic";

// Adding a field, and changing any of its settings later (anyone with `fields.edit` and Edit in the
// database): the same form for both, so they can't drift. A new kind, one ↔ several or another linked
// database converts existing values in the background, after a preview; it can be undone.

const severalKinds: FieldKind[] = ["choice", "user", "link"];

type Option = { id?: string; label: string; retired?: boolean };

/** What the form holds. Options are the field's live ones, plus any typed. */
type Draft = { label: string; kind: FieldKind; options: Option[]; added: string; linkTypeId: string; multiple: boolean };

const draftOf = (field?: TypeField, kind: FieldKind = "text"): Draft => ({
	label: field?.label ?? "",
	kind: field?.kind ?? kind,
	options: field?.options?.filter((o) => !o.retired) ?? [],
	added: "",
	linkTypeId: field?.linkType ?? "",
	multiple: !!field?.multiple,
});

/** The options to send: the list, plus what's typed in New option. */
const optionsOf = (draft: Draft) => [...draft.options, ...(draft.added.trim() ? [{ label: draft.added.trim() }] : [])].map(({ id, label }) => ({ ...(id && { id }), label }));

/** Whether the draft changes how values are stored: its kind, one/several, or the linked database. */
const reshapes = (field: TypeField, d: Draft) =>
	d.kind !== field.kind || (severalKinds.includes(d.kind) && d.multiple !== !!field.multiple) || (d.kind === "link" && d.linkTypeId !== (field.linkType ?? ""));

/** Every setting a field has, in one place: Add field and Edit field both show these. */
function FieldSettings({ draft, set, field }: { draft: Draft; set: (d: Partial<Draft>) => void; field?: TypeField }) {
	const types = useTypes();
	const wasChoice = field?.kind === "choice";
	const retired = draft.kind === "choice" && wasChoice ? (field.options?.filter((o) => o.retired) ?? []) : [];
	const addOption = () => draft.added.trim() && set({ options: [...draft.options, { label: draft.added.trim() }], added: "" });
	const optionsHint = !field || wasChoice
		? field ? "Removing an option keeps it on the records that have it, but it can't be picked again." : "The values people can pick."
		: "Each different value already in this field becomes an option too.";
	return (
		<Settings>
			<Setting label="Name">
				<input autoFocus aria-label="Name" value={draft.label} onChange={(e) => set({ label: e.target.value })} placeholder="Roof type" className={wideControlClass} />
			</Setting>
			<Setting label="Kind" hint={field?.key === NAME_KEY ? "A record's name is always text." : field ? "Changing it converts the values already here." : undefined}>
				<Select
					label="Kind"
					className={wideControlClass}
					value={draft.kind}
					disabled={field?.key === NAME_KEY}
					options={fieldKinds.map((k) => ({ value: k, label: kindLabels[k] }))}
					onChange={(kind) => set({ kind, ...(kind === field?.kind && { multiple: !!field.multiple }) })}
				/>
			</Setting>
			{draft.kind === "choice" && (
				<Setting label="Options" hint={optionsHint} wide>
					<div className="flex w-full flex-col gap-2">
						{draft.options.map((o, i) => (
							<span key={o.id ?? `new-${i}`} className="flex items-center gap-2">
								<input
									aria-label={`Option ${i + 1}`}
									value={o.label}
									onChange={(e) => set({ options: draft.options.map((p, j) => (j === i ? { ...p, label: e.target.value } : p)) })}
									className={`${compactControlClass} flex-1`}
								/>
								<button type="button" onClick={() => set({ options: draft.options.filter((_, j) => j !== i) })} aria-label="Remove" title="Remove option" className={iconDangerButton}>
									<TrashIcon size={16} />
								</button>
							</span>
						))}
						<input
							aria-label="New option"
							value={draft.added}
							onChange={(e) => set({ added: e.target.value })}
							onKeyDown={(e) => e.key === "Enter" && draft.added.trim() && (e.preventDefault(), addOption())}
							placeholder="New option"
							className={compactControlClass}
						/>
						{retired.length > 0 && <p className={metadataClass}>Removed: {retired.map((o) => o.label).join(", ")}</p>}
					</div>
				</Setting>
			)}
			{draft.kind === "link" && (
				<Setting label="Links to" hint={field?.kind === "link" ? "Another database matches values by their record's name." : undefined}>
					<Select
						label="Links to"
						className={wideControlClass}
						value={draft.linkTypeId}
						placeholder="Pick a database…"
						options={(types ?? []).map((t) => ({ value: t._id as string, label: t.plural }))}
						onChange={(linkTypeId) => set({ linkTypeId })}
					/>
				</Setting>
			)}
			{severalKinds.includes(draft.kind) && (
				<Setting inline label="Holds several" hint={field && field.kind === draft.kind && field.multiple && !draft.multiple ? "Each record keeps its first value." : "More than one value per record."}>
					<Checkbox label="Holds several" checked={draft.multiple} onChange={(multiple) => set({ multiple })} />
				</Setting>
			)}
		</Settings>
	);
}

export function AddField({
	type,
	kind = "text",
	onCreated,
	onClose,
}: {
	type: RecordType;
	kind?: FieldKind;
	/** With the new field's key, e.g. to show it as a column. */
	onCreated?: (key: string) => void;
	onClose: () => void;
}) {
	const create = useMutation(api.fields.create);
	const [draft, setDraft] = useState(() => draftOf(undefined, kind));
	const { error, run } = useRun();
	const submit = () =>
		run(
			create({
				typeId: type._id,
				label: draft.label,
				kind: draft.kind,
				...(draft.kind === "choice" && { options: optionsOf(draft) }),
				...(draft.kind === "link" && draft.linkTypeId && { linkTypeId: draft.linkTypeId as Id<"recordTypes"> }),
				...(severalKinds.includes(draft.kind) && draft.multiple && { multiple: true }),
			}).then((field) => onCreated?.(field.key)),
			onClose,
		);
	return (
		<Modal title={`Add a field to ${type.plural.toLowerCase()}`} onClose={onClose}>
			<Form onSubmit={() => submit()}>
				<Notice>{error}</Notice>
				<FieldSettings draft={draft} set={(d) => setDraft({ ...draft, ...d })} />
				<DialogButtons>
					<button type="button" onClick={onClose} className={secondaryButton}>Cancel</button>
					<button type="submit" className={primaryButton}>Add field</button>
				</DialogButtons>
			</Form>
		</Modal>
	);
}

/**
 * Every setting of a field, changeable. A new kind, one ↔ several or linked database shows what it will
 * do to the values first; Change applies it in the background. Archive is in the menu (to Trash).
 */
export function EditField({ field, onClose }: { field: TypeField; onClose: () => void }) {
	const update = useMutation(api.fields.update);
	const remove = useMutation(api.trash.move);
	const undo = useMutation(api.records.undo);
	const { confirm, dialog } = useConfirm();
	const [draft, setDraft] = useState(() => draftOf(field));
	const { error, run } = useRun();
	const fieldId = field._id as Id<"recordFields">;
	const changes = useQuery(api.fields.changes, { fieldId });
	const converting = !!field.changing || !!changes?.running;
	const reshaping = reshapes(field, draft);
	const save = () =>
		run(
			update({
				fieldId,
				label: draft.label,
				...(draft.kind === "choice" && { options: optionsOf(draft) }),
				...(reshaping && {
					kind: draft.kind,
					multiple: severalKinds.includes(draft.kind) && draft.multiple,
					...(draft.kind === "link" && draft.linkTypeId && { linkTypeId: draft.linkTypeId as Id<"recordTypes"> }),
				}),
			}),
			onClose,
		);
	const last = changes?.last;
	return (
		<Modal
			title={`Edit “${field.label}”`}
			onClose={onClose}
			menu={
				field.key !== NAME_KEY
					? (close) => (
							<MenuItem onClick={() => (close(), confirm(archiveQuestion(field.label, () => remove({ kind: "field", id: fieldId }).then(onClose), "The field will be hidden; its saved values are kept.")))}>
								<ArchiveIcon /> Archive field
							</MenuItem>
						)
					: undefined
			}
		>
			{dialog}
			<Form onSubmit={() => save()}>
				<Notice>{error}</Notice>
				{converting ? (
					<div className={notePanelClass}>
						<p className="font-medium">{changes?.running?.undoing ? "Undoing the last change…" : "Converting values…"}</p>
						<p>{(changes?.running?.converted ?? 0).toLocaleString()} done so far. You can change this field again once it's finished.</p>
					</div>
				) : (
					<FieldSettings draft={draft} set={(d) => setDraft({ ...draft, ...d })} field={field} />
				)}
				{!converting && reshaping && <ChangePreview field={field} draft={draft} />}
				{!converting && !reshaping && last && (
					<div className={`flex items-center gap-3 ${hintClass}`}>
						<span className="min-w-0 flex-1">
							Changed {last.change} {timeAgo(last.at)}
							{last.cleared > 0 && `, clearing ${last.cleared.toLocaleString()} ${last.cleared === 1 ? "value" : "values"}`}.
						</span>
						{last.undoable && (
							<button
								type="button"
								className={smallButton}
								onClick={() =>
									confirm({
										title: `Undo “${last.change}”?`,
										action: "Undo",
										danger: false,
										body: `“${field.label}” goes back to how it was, and every record gets its old value back, unless it was changed since.`,
										onConfirm: () => undo({ historyId: last.historyId }).then(onClose),
									})
								}
							>
								Undo
							</button>
						)}
					</div>
				)}
				<DialogButtons>
					<button type="button" onClick={onClose} className={secondaryButton}>Cancel</button>
					<button type="submit" className={primaryButton} disabled={converting}>{reshaping ? "Change" : "Save"}</button>
				</DialogButtons>
			</Form>
		</Modal>
	);
}

/** What changing the field would do to its values, before anything changes. */
function ChangePreview({ field, draft }: { field: TypeField; draft: Draft }) {
	// Settles as text, so each render's new object doesn't restart the wait.
	const settled = useDebounced(
		JSON.stringify({
			fieldId: field._id,
			kind: draft.kind,
			multiple: severalKinds.includes(draft.kind) && draft.multiple,
			...(draft.kind === "link" && draft.linkTypeId && { linkTypeId: draft.linkTypeId }),
			...(draft.kind === "choice" && field.kind !== "choice" && { options: optionsOf(draft) }),
		}),
	);
	const waiting = draft.kind === "link" && !draft.linkTypeId;
	const preview = useQuery(api.fields.preview, waiting ? "skip" : (JSON.parse(settled) as FunctionArgs<typeof api.fields.preview>));
	if (waiting) return null;
	if (!preview) return <div className={notePanelClass}><p className={hintClass}>Checking the values…</p></div>;
	if ("error" in preview) return <Notice>{preview.error}</Notice>;
	const count = (n: number) => `${n.toLocaleString()}${preview.more ? "+" : ""}`;
	const plural = (n: number, one: string, many: string) => (n === 1 && !preview.more ? one : many);
	return (
		<div className={notePanelClass}>
			<p className="font-medium">{preview.change}</p>
			{preview.checked === 0 ? (
				<p>No records have a value here yet.</p>
			) : (
				<>
					<p>
						{count(preview.converted)} {plural(preview.converted, "value converts", "values convert")}
						{preview.partly > 0 && `, ${count(preview.partly)} keeping only part of what ${plural(preview.partly, "it has", "they have")}`}.
					</p>
					{preview.cleared > 0 && (
						<p>
							{count(preview.cleared)} {plural(preview.cleared, "doesn't fit and will be cleared", "don't fit and will be cleared")}
							{preview.examples.length > 0 && `: ${preview.examples.map((e) => `“${e}”`).join(", ")}`}.
						</p>
					)}
					{preview.cleared === 0 && preview.partly > 0 && preview.examples.length > 0 && <p>Dropped: {preview.examples.map((e) => `“${e}”`).join(", ")}.</p>}
					{preview.options.length > 0 && (
						<p>
							New options: {preview.options.slice(0, 12).join(", ")}
							{preview.options.length > 12 && ` and ${preview.options.length - 12} more`}
							{preview.options.length >= 100 && " (a choice field holds up to 100; other values will be cleared)"}.
						</p>
					)}
				</>
			)}
			{preview.views.length > 0 && <p>Filters, sorts or grouping on it in {preview.views.map((v) => `“${v}”`).join(", ")} will be removed.</p>}
			<p className={metadataClass}>
				{preview.more ? "Counted from the first 500 records; the rest convert the same way. " : ""}
				Old values are kept for 30 days: undo it from here or Settings → Activity.
			</p>
		</div>
	);
}
