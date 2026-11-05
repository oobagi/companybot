import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import { Checkbox, Select } from "../../controls";
import { type FieldKind, fieldKinds } from "@companybot/core/records";
import { useState } from "react";
import { api } from "../../api";
import { useMutation } from "../../convex";
import { Form, Notice, Setting, Settings, compactControlClass, iconDangerButton, metadataClass, primaryButton, secondaryButton, useRun, wideControlClass } from "../../ui";
import { ArchiveIcon, TrashIcon } from "../../icons";
import { DialogButtons, MenuItem, Modal, archiveQuestion, useConfirm } from "../chat/common";
import { type RecordType, useTypes } from "./data";
import { type TypeField, kindLabels } from "./logic";

// Adding a field to a type (anyone with `fields.edit`), and renaming, re-optioning or
// deleting one (`canEdit` from the server: the fields.edit switch).

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
	const [options, setOptions] = useState("");
	const [linkTypeId, setLinkTypeId] = useState<string>("");
	const [multiple, setMultiple] = useState(false);
	const { error, run } = useRun();
	const submit = () =>
		run(
			create({
				typeId: type._id,
				label,
				kind,
				...(kind === "choice" && { options: options.split("\n").map((l) => ({ label: l.trim() })).filter((o) => o.label) }),
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
						<input autoFocus aria-label="Name" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Roof type" className={wideControlClass} />
					</Setting>
					<Setting label="Kind" hint="A field's kind can't change later.">
						<Select label="Kind" className={wideControlClass} value={kind} options={fieldKinds.map((k) => ({ value: k, label: kindLabels[k] }))} onChange={setKind} />
					</Setting>
					{kind === "choice" && (
						<Setting label="Options" hint="One per line." wide>
							<textarea aria-label="Options" value={options} onChange={(e) => setOptions(e.target.value)} rows={4} placeholder={"Shingle\nMetal\nTile"} className={`${compactControlClass} w-full`} />
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
						<Setting label="Holds several" hint="More than one value per record.">
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
	const [options, setOptions] = useState(field.options?.filter((o) => !o.retired) ?? []);
	const [added, setAdded] = useState("");
	const { error, run } = useRun();
	const fieldId = field._id as Id<"recordFields">;
	const retired = field.options?.filter((o) => o.retired) ?? [];
	const save = () =>
		run(
			update({
				fieldId,
				label,
				...(field.kind === "choice" && { options: [...options, ...(added.trim() ? [{ label: added.trim() }] : [])] }),
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
						<input autoFocus aria-label="Name" value={label} onChange={(e) => setLabel(e.target.value)} className={wideControlClass} />
					</Setting>
					{field.kind === "choice" && (
						<Setting label="Options" hint="Removing an option keeps it on the records that have it, but it can't be picked again." wide>
							<div className="flex w-full flex-col gap-2">
								{options.map((o, i) => (
									<span key={o.id} className="flex items-center gap-2">
										<input
											aria-label={`Option ${i + 1}`}
											value={o.label}
											onChange={(e) => setOptions(options.map((p, j) => (j === i ? { ...p, label: e.target.value } : p)))}
											className={`${compactControlClass} flex-1`}
										/>
										<button type="button" onClick={() => setOptions(options.filter((_, j) => j !== i))} aria-label="Remove" title="Remove option" className={iconDangerButton}>
											<TrashIcon size={16} />
										</button>
									</span>
								))}
								<input aria-label="New option" value={added} onChange={(e) => setAdded(e.target.value)} placeholder="New option" className={compactControlClass} />
								{retired.length > 0 && <p className={metadataClass}>Removed: {retired.map((o) => o.label).join(", ")}</p>}
							</div>
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
