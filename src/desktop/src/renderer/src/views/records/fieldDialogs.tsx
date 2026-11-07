import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import { Checkbox, Select } from "../../controls";
import { type FieldKind, autoColor, fieldIcons, fieldKinds, optionColors } from "@companybot/core/records";
import { useState } from "react";
import { api } from "../../api";
import { useMutation } from "../../convex";
import { Form, MenuDivider, Notice, Setting, Settings, compactControlClass, iconDangerButton, metadataClass, pickedTileButton, primaryButton, secondaryButton, swatchButton, useRun, wideControlClass } from "../../ui";
import { ArchiveIcon, CheckIcon, RestoreIcon, TrashIcon, fieldIconSet } from "../../icons";
import { DialogButtons, MenuItem, Modal, Popover, archiveQuestion, useConfirm } from "../chat/common";
import { Chip, FieldIcon, tintOf } from "./fields";
import { type RecordType, useTypes } from "./data";
import { type TypeField, kindLabels } from "./logic";

// Adding a field to a type (anyone with `fields.edit`), and renaming, re-iconing, re-optioning
// or deleting one (`canEdit` from the server: the fields.edit switch).

const severalKinds: FieldKind[] = ["choice", "user", "link"];

export function AddField({
	type,
	kind: initialKind = "text",
	onCreated,
	onClose,
}: {
	type: RecordType;
	kind?: FieldKind;
	/** With the new field's key, e.g. to show it as a column. */
	onCreated?: (key: string) => void;
	onClose: () => void;
}) {
	const types = useTypes();
	const create = useMutation(api.fields.create);
	const [label, setLabel] = useState("");
	const [kind, setKind] = useState(initialKind);
	const [icon, setIcon] = useState<string>();
	const [options, setOptions] = useState<Draft[]>([]);
	const [added, setAdded] = useState("");
	const [linkTypeId, setLinkTypeId] = useState<string>("");
	const [multiple, setMultiple] = useState(false);
	const { error, run } = useRun();
	const submit = () =>
		run(
			create({
				typeId: type._id,
				label,
				kind,
				...(icon && { icon }),
				...(kind === "choice" && { options: withAdded(options, added, 0) }),
				...(kind === "link" && linkTypeId && { linkTypeId: linkTypeId as Id<"recordTypes"> }),
				...(severalKinds.includes(kind) && multiple && { multiple: true }),
			}).then((field) => onCreated?.(field.key)),
			onClose,
		);
	return (
		<Modal title={`Add a field to ${type.plural.toLowerCase()}`} onClose={onClose}>
			<Form onSubmit={() => submit()}>
				<Notice>{error}</Notice>
				<Settings>
					<Setting label="Name">
						<span className="flex gap-2">
							<IconPicker kind={kind} icon={icon} onChange={setIcon} />
							<input autoFocus aria-label="Name" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Roof type" className={`${wideControlClass} flex-1`} />
						</span>
					</Setting>
					<Setting label="Kind" hint="A field's kind can't change later.">
						<Select label="Kind" className={wideControlClass} value={kind} options={fieldKinds.map((k) => ({ value: k, label: kindLabels[k] }))} onChange={setKind} />
					</Setting>
					{kind === "choice" && (
						<Setting label="Options" wide>
							<OptionsEditor options={options} onChange={setOptions} added={added} onAdded={setAdded} before={0} />
						</Setting>
					)}
					{kind === "link" && (
						<Setting label="Links to">
							<Select
								label="Links to"
								className={wideControlClass}
								value={linkTypeId}
								placeholder="Pick a database…"
								options={(types ?? []).map((t) => ({ value: t._id as string, label: t.plural }))}
								onChange={setLinkTypeId}
							/>
						</Setting>
					)}
					{severalKinds.includes(kind) && (
						<Setting inline label="Holds several" hint="More than one value per record.">
							<Checkbox label="Holds several" checked={multiple} onChange={setMultiple} />
						</Setting>
					)}
				</Settings>
				<DialogButtons>
					<button type="button" onClick={onClose} className={secondaryButton}>Cancel</button>
					<button type="submit" className={primaryButton}>Add field</button>
				</DialogButtons>
			</Form>
		</Modal>
	);
}

/** Rename, change options (a removed option is retired: records keep it), or delete (to Trash). */
export function EditField({ field, onClose }: { field: TypeField; onClose: () => void }) {
	const update = useMutation(api.fields.update);
	const remove = useMutation(api.trash.move);
	const { confirm, dialog } = useConfirm();
	const [label, setLabel] = useState(field.label);
	const [icon, setIcon] = useState(field.icon);
	const [options, setOptions] = useState<Draft[]>(field.options?.filter((o) => !o.retired) ?? []);
	const [added, setAdded] = useState("");
	const { error, run } = useRun();
	const fieldId = field._id as Id<"recordFields">;
	const retired = field.options?.filter((o) => o.retired) ?? [];
	const save = () =>
		run(
			update({
				fieldId,
				label,
				...(icon !== field.icon && { icon: icon ?? null }),
				...(field.kind === "choice" && { options: withAdded(options, added, retired.length) }),
			}),
			onClose,
		);
	return (
		<Modal
			title={`Edit “${field.label}”`}
			onClose={onClose}
			menu={
				field.key !== "name"
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
				<Settings>
					<Setting label="Name" hint={`${kindLabels[field.kind]}${field.multiple ? ", holds several" : ""}`}>
						<span className="flex gap-2">
							<IconPicker kind={field.kind} icon={icon} onChange={setIcon} />
							<input autoFocus aria-label="Name" value={label} onChange={(e) => setLabel(e.target.value)} className={`${wideControlClass} flex-1`} />
						</span>
					</Setting>
					{field.kind === "choice" && (
						<Setting label="Options" hint="Removing an option keeps it on the records that have it, but it can't be picked again." wide>
							<OptionsEditor options={options} onChange={setOptions} added={added} onAdded={setAdded} before={retired.length}>
								{retired.length > 0 && <p className={metadataClass}>Removed: {retired.map((o) => o.label).join(", ")}</p>}
							</OptionsEditor>
						</Setting>
					)}
				</Settings>
				<DialogButtons>
					<button type="button" onClick={onClose} className={secondaryButton}>Cancel</button>
					<button type="submit" className={primaryButton}>Save</button>
				</DialogButtons>
			</Form>
		</Modal>
	);
}

/** An option being edited: an existing one keeps its `id`; a new one has none until it's saved. */
type Draft = { id?: string; label: string; color?: string };

/** The options to send: the rows, plus what's still typed in "New option" (in its turn's color). `before`: retired options, which count toward the turn. */
const withAdded = (options: Draft[], added: string, before: number): Draft[] =>
	added.trim() ? [...options, { label: added.trim(), color: autoColor(before + options.length) }] : options;

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
	options: Draft[];
	onChange: (options: Draft[]) => void;
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
						<TrashIcon size={16} />
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
