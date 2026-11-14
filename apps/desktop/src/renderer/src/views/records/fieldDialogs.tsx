import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import { Checkbox, Select } from "../../controls";
import { type FieldKind, NAME_KEY, autoColor, fieldIcons, fieldKinds, optionColors } from "@companybot/core/records";
import type { FunctionArgs, FunctionReturnType } from "convex/server";
import { useEffect, useRef, useState } from "react";
import { api } from "../../api";
import { useMutation, useQuery } from "../../convex";
import { Form, MenuDivider, Notice, Setting, Settings, compactControlClass, hintClass, iconDangerButton, metadataClass, notePanelClass, pickedTileButton, primaryButton, secondaryButton, smallButton, surfaceButton, swatchButton, timeAgo, useDebounced, useRun, wideControlClass } from "../../ui";
import { ArchiveIcon, CheckIcon, RestoreIcon, TrashIcon, fieldIconSet } from "../../icons";
import { DialogButtons, MenuItem, Modal, Popover, archiveQuestion, useConfirm } from "../chat/common";
import { FieldIcon, tintOf } from "./fields";
import { type RecordType, useTypes } from "./data";
import { type TypeField, kindLabels } from "./logic";

// Adding a field, and changing any of its settings later (anyone with `fields.edit` and Edit in the
// database): the same form for both, so they can't drift. A new kind, one ↔ several or another linked
// database converts existing values in the background, after a preview; it can be undone. Its icon and
// its options' colors are only looks: they change nothing stored in records.

const severalKinds: FieldKind[] = ["choice", "user", "link"];

type Option = { id?: string; label: string; color?: string; retired?: boolean };

/** What the form holds. Options are the field's live ones, plus any typed. */
type Draft = { label: string; icon?: string; kind: FieldKind; options: Option[]; added: string; linkTypeId: string; multiple: boolean };

const draftOf = (field?: TypeField, kind: FieldKind = "text"): Draft => ({
	label: field?.label ?? "",
	icon: field?.icon,
	kind: field?.kind ?? kind,
	options: field?.options?.filter((o) => !o.retired) ?? [],
	added: "",
	linkTypeId: field?.linkType ?? "",
	multiple: !!field?.multiple,
});

/** The options to send: the list, plus what's typed in New option (the server gives it the next color in turn). */
const optionsOf = (draft: Draft) =>
	[...draft.options, ...(draft.added.trim() ? [{ label: draft.added.trim() }] : [])].map(({ id, label, color }: Option) => ({ ...(id && { id }), label, ...(color && { color }) }));

/** Whether the draft changes how values are stored: its kind, one/several, or the linked database. */
const reshapes = (field: TypeField, d: Draft) =>
	d.kind !== field.kind || (severalKinds.includes(d.kind) && d.multiple !== !!field.multiple) || (d.kind === "link" && d.linkTypeId !== (field.linkType ?? ""));

/** Every setting a field has, in one place: Add field and Edit field both show these. */
function FieldSettings({ draft, set, field }: { draft: Draft; set: (d: Partial<Draft>) => void; field?: TypeField }) {
	const types = useTypes();
	const wasChoice = field?.kind === "choice";
	const retired = draft.kind === "choice" && wasChoice ? (field.options?.filter((o) => o.retired) ?? []) : [];
	const optionsHint = !field || wasChoice
		? field ? "Removing an option keeps it on the records that have it, but it can't be picked again." : "The values people can pick."
		: "Each different value already in this field becomes an option too.";
	return (
		<Settings>
			<Setting label="Name">
				<span className="flex gap-2">
					<IconPicker kind={draft.kind} icon={draft.icon} onChange={(icon) => set({ icon })} />
					<input autoFocus aria-label="Name" value={draft.label} onChange={(e) => set({ label: e.target.value })} placeholder="Roof type" className={`${wideControlClass} flex-1`} />
				</span>
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
					<OptionsEditor options={draft.options} onChange={(options) => set({ options })} added={draft.added} onAdded={(added) => set({ added })} before={retired.length}>
						{retired.length > 0 && <p className={metadataClass}>Removed: {retired.map((o) => o.label).join(", ")}</p>}
					</OptionsEditor>
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
				<Setting label="Holds several" hint={field && field.kind === draft.kind && field.multiple && !draft.multiple ? "Each record keeps its first value." : "More than one value per record."}>
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
				...(draft.icon && { icon: draft.icon }),
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
				<FieldSettings draft={draft} set={(d) => setDraft((prev) => ({ ...prev, ...d }))} />
				<DialogButtons>
					<button type="button" onClick={onClose} className={secondaryButton}>Cancel</button>
					<button type="submit" className={primaryButton}>Add field</button>
				</DialogButtons>
			</Form>
		</Modal>
	);
}

/**
 * Every setting of a field, changeable. A new kind, one ↔ several or linked database converts the values
 * in the background on Save, like Notion; only a change that loses something says so first. Undoable for
 * 30 days. Archive is in the menu (to Trash).
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
	const preview = usePreview(field, draft, reshaping && !converting);
	const save = () =>
		run(
			update({
				fieldId,
				label: draft.label,
				...(draft.icon !== field.icon && { icon: draft.icon ?? null }),
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
					<FieldSettings draft={draft} set={(d) => setDraft((prev) => ({ ...prev, ...d }))} field={field} />
				)}
				{preview && <ChangeWarning preview={preview} />}
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
					<button type="submit" className={primaryButton} disabled={converting || (reshaping && preview === undefined)}>Save</button>
				</DialogButtons>
			</Form>
		</Modal>
	);
}

/** What changing the field would do to its values: undefined while checking, null when nothing changes shape. */
function usePreview(field: TypeField, draft: Draft, reshaping: boolean) {
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
	const skip = !reshaping || (draft.kind === "link" && !draft.linkTypeId);
	const preview = useQuery(api.fields.preview, skip ? "skip" : (JSON.parse(settled) as FunctionArgs<typeof api.fields.preview>));
	return skip ? null : preview;
}

/** Says only what a change loses (values cleared or cut, view filters dropped); a lossless one says nothing. */
function ChangeWarning({ preview }: { preview: NonNullable<FunctionReturnType<typeof api.fields.preview>> }) {
	if ("error" in preview) return <Notice>{preview.error}</Notice>;
	const n = (count: number) => `${count.toLocaleString()}${preview.more ? "+" : ""}`;
	const values = (count: number) => `${n(count)} ${count === 1 && !preview.more ? "value" : "values"}`;
	const examples = preview.examples.length ? `: ${preview.examples.map((e) => `“${e}”`).join(", ")}` : "";
	const lines = [
		preview.cleared > 0 && `${values(preview.cleared)} will be cleared${examples}.`,
		preview.partly > 0 && `${values(preview.partly)} will keep only their first pick${preview.cleared ? "" : examples}.`,
		preview.views.length > 0 && `Filters or grouping on it in ${preview.views.map((v) => `“${v}”`).join(", ")} will be removed.`,
	].filter(Boolean);
	if (!lines.length) return null;
	return (
		<p className={hintClass}>
			{lines.join(" ")} You can undo this for 30 days.
		</p>
	);
}

/**
 * Choice options as rows, Notion's way: a color swatch, the name, remove. Enter in "New option"
 * adds it (pasting several lines adds one each); a new option takes the next color in turn.
 */
function OptionsEditor({
	options,
	onChange,
	added,
	onAdded,
	before,
	children,
}: {
	options: Option[];
	onChange: (options: Option[]) => void;
	added: string;
	onAdded: (text: string) => void;
	before: number;
	children?: React.ReactNode;
}) {
	const add = (labels: string[]) => {
		const fresh = labels.map((l) => l.trim()).filter(Boolean);
		if (fresh.length) onChange([...options, ...fresh.map((label, i) => ({ label, color: autoColor(before + options.length + i) }))]);
		onAdded("");
	};
	return (
		<div className="flex w-full flex-col gap-2">
			{options.map((o, i) => (
				<span key={o.id ?? `new-${i}`} className="flex items-center gap-2">
					<ColorPicker color={o.color} onChange={(color) => onChange(options.map((p, j) => (j === i ? { ...p, color } : p)))} />
					<input
						aria-label={`Option ${i + 1}`}
						value={o.label}
						onChange={(e) => onChange(options.map((p, j) => (j === i ? { ...p, label: e.target.value } : p)))}
						className={`${compactControlClass} flex-1`}
					/>
					<button type="button" onClick={() => onChange(options.filter((_, j) => j !== i))} aria-label="Remove" title="Remove option" className={iconDangerButton}>
						<TrashIcon />
					</button>
				</span>
			))}
			<input
				aria-label="New option"
				value={added}
				onChange={(e) => onAdded(e.target.value)}
				onKeyDown={(e) => {
					if (e.key !== "Enter" || !added.trim()) return;
					e.preventDefault();
					add([added]);
				}}
				onPaste={(e) => {
					const lines = e.clipboardData.getData("text").split(/\r?\n/);
					if (lines.length < 2) return;
					e.preventDefault();
					add([added + lines[0], ...lines.slice(1)]);
				}}
				placeholder="Add an option"
				className={compactControlClass}
			/>
			{children}
		</div>
	);
}

const colorNames: Record<(typeof optionColors)[number], string> = {
	default: "Default",
	gray: "Gray",
	brown: "Brown",
	orange: "Orange",
	yellow: "Yellow",
	green: "Green",
	blue: "Blue",
	purple: "Purple",
	pink: "Pink",
	red: "Red",
};

/** An option's color: its swatch, opening Notion's palette of named tints. */
function ColorPicker({ color = "default", onChange }: { color?: string; onChange: (color: string) => void }) {
	return (
		<Popover label="Color" trigger={<span className={`size-4 rounded ring-1 ring-black/5 ${tintOf(color)}`} />} className={swatchButton} panelClassName="flex w-44 flex-col gap-px p-1">
			{(close) => (
				<>
					<p className="px-2 pt-1 pb-0.5 text-xs text-neutral-400">Color</p>
					{optionColors.map((c) => (
						<MenuItem key={c} onClick={() => (close(), onChange(c))}>
							<span className={`size-4 shrink-0 rounded ring-1 ring-black/5 ${tintOf(c)}`} />
							<span className="flex-1">{colorNames[c]}</span>
							{c === color && <CheckIcon className="text-neutral-500" />}
						</MenuItem>
					))}
				</>
			)}
		</Popover>
	);
}

/** A field's icon beside its name: a grid of business icons, or back to its kind's. */
function IconPicker({ kind, icon, onChange }: { kind: FieldKind; icon?: string; onChange: (icon: string | undefined) => void }) {
	return (
		<Popover label="Icon" trigger={<FieldIcon field={{ kind, icon }} className="text-neutral-500" />} className={swatchButton} panelClassName="flex w-[19rem] flex-col gap-1 p-2">
			{(close) => (
				<>
					<div className="grid grid-cols-8 gap-0.5">
						{fieldIcons.map((id) => {
							const Icon = fieldIconSet[id];
							return (
								<button key={id} type="button" title={id.replace(/-/g, " ")} aria-label={id.replace(/-/g, " ")} aria-pressed={icon === id} onClick={() => (close(), onChange(id))} className={pickedTileButton}>
									<Icon />
								</button>
							);
						})}
					</div>
					<MenuDivider />
					<MenuItem disabled={!icon} onClick={() => (close(), onChange(undefined))}>
						<RestoreIcon className="text-neutral-400" /> Reset to default
					</MenuItem>
				</>
			)}
		</Popover>
	);
}

/**
 * A board column's option, from its header chip, like Notion's: rename it (saved as the menu closes), pick
 * its color, or remove it. Cards that have a removed option keep it, in a "(removed)" column, until they're changed.
 */
export function OptionMenu({
	option,
	onSave,
	onRemove,
	children,
}: {
	option: { label: string; color?: string };
	onSave: (change: { label?: string; color?: string }) => void;
	onRemove: () => void;
	/** The chip, as the button. */
	children: React.ReactNode;
}) {
	const { confirm, dialog } = useConfirm();
	return (
		<>
			{dialog}
			<Popover label={`Edit “${option.label}”`} trigger={children} className={`${surfaceButton} flex min-w-0 rounded-md hover:brightness-95`} panelClassName="flex w-56 flex-col gap-px p-1">
				{(close) => (
					<OptionPanel
						option={option}
						onSave={onSave}
						onClose={close}
						onRemove={() =>
							(close(),
							confirm({
								title: `Remove “${option.label}”?`,
								action: "Remove",
								danger: false,
								body: "Cards that have it keep it, in a removed column at the end, until you change them.",
								onConfirm: onRemove,
							}))
						}
					/>
				)}
			</Popover>
		</>
	);
}

function OptionPanel({ option, onSave, onClose, onRemove }: { option: { label: string; color?: string }; onSave: (change: { label?: string; color?: string }) => void; onClose: () => void; onRemove: () => void }) {
	const [label, setLabel] = useState(option.label);
	// A new name saves when the menu closes, however it closes (Enter, Escape, a click elsewhere).
	const typed = useRef({ label, option, onSave });
	typed.current = { label, option, onSave };
	useEffect(
		() => () => {
			const { label, option, onSave } = typed.current;
			if (label.trim() && label.trim() !== option.label) onSave({ label: label.trim() });
		},
		[],
	);
	const color = option.color ?? "default";
	return (
		<>
			<input
				autoFocus
				aria-label="Option name"
				value={label}
				maxLength={100}
				onChange={(e) => setLabel(e.target.value)}
				onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), onClose())}
				className={`${compactControlClass} m-1`}
			/>
			<p className="px-2 pt-1 pb-0.5 text-xs text-neutral-400">Color</p>
			{optionColors.map((c) => (
				<MenuItem key={c} onClick={() => c !== color && onSave({ color: c })}>
					<span className={`size-4 shrink-0 rounded ring-1 ring-black/5 ${tintOf(c)}`} />
					<span className="flex-1">{colorNames[c]}</span>
					{c === color && <CheckIcon className="text-neutral-500" />}
				</MenuItem>
			))}
			<MenuDivider />
			<MenuItem onClick={onRemove}>
				<TrashIcon className="text-neutral-400" /> Remove option
			</MenuItem>
		</>
	);
}
