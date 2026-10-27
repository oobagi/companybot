import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import { type FieldKind, fieldKinds } from "@companybot/core/records";
import { useState } from "react";
import { api } from "../../api";
import { useMutation } from "../../convex";
import { Field, Notice, inputClass, primaryButton, useRun } from "../../ui";
import { Modal } from "../chat/common";
import { type RecordType, useTypes } from "./data";
import { type TypeField, kindLabels } from "./logic";

// Adding a field to a type (anyone with `fields.create`), and renaming, re-optioning or
// deleting one (its maker or an owner: `canEdit` from the server).

const severalKinds: FieldKind[] = ["choice", "user", "link"];

export function AddField({ type, onClose }: { type: RecordType; onClose: () => void }) {
	const types = useTypes();
	const create = useMutation(api.fields.create);
	const [label, setLabel] = useState("");
	const [kind, setKind] = useState<FieldKind>("text");
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
			}),
			onClose,
		);
	return (
		<Modal title={`Add a field to ${type.plural.toLowerCase()}`} onClose={onClose}>
			<form
				className="flex flex-col gap-4"
				onSubmit={(e) => {
					e.preventDefault();
					submit();
				}}
			>
				{error && <Notice>{error}</Notice>}
				<Field label="Name">
					<input autoFocus value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Roof type" className={inputClass} />
				</Field>
				<Field label="Kind" hint="A field's kind can't change later.">
					<select value={kind} onChange={(e) => setKind(e.target.value as FieldKind)} className={inputClass}>
						{fieldKinds.map((k) => (
							<option key={k} value={k}>
								{kindLabels[k]}
							</option>
						))}
					</select>
				</Field>
				{kind === "choice" && (
					<Field label="Options" hint="One per line.">
						<textarea value={options} onChange={(e) => setOptions(e.target.value)} rows={4} placeholder={"Shingle\nMetal\nTile"} className={inputClass} />
					</Field>
				)}
				{kind === "link" && (
					<Field label="Links to">
						<select value={linkTypeId} onChange={(e) => setLinkTypeId(e.target.value)} className={inputClass}>
							<option value="">Pick a database…</option>
							{types?.map((t) => (
								<option key={t._id} value={t._id}>
									{t.plural}
								</option>
							))}
						</select>
					</Field>
				)}
				{severalKinds.includes(kind) && (
					<label className="flex items-center gap-2 text-sm">
						<input type="checkbox" checked={multiple} onChange={(e) => setMultiple(e.target.checked)} />
						Holds several
					</label>
				)}
				<button type="submit" className={`${primaryButton} self-start`}>
					Add field
				</button>
			</form>
		</Modal>
	);
}

/** Rename, change options (a removed option is retired: records keep it), or delete (to Trash). */
export function EditField({ field, onClose }: { field: TypeField; onClose: () => void }) {
	const update = useMutation(api.fields.update);
	const remove = useMutation(api.trash.move);
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
		<Modal title={`Edit “${field.label}”`} onClose={onClose}>
			<form
				className="flex flex-col gap-4"
				onSubmit={(e) => {
					e.preventDefault();
					save();
				}}
			>
				{error && <Notice>{error}</Notice>}
				<Field label="Name" hint={`${kindLabels[field.kind]}${field.multiple ? ", holds several" : ""}`}>
					<input autoFocus value={label} onChange={(e) => setLabel(e.target.value)} className={inputClass} />
				</Field>
				{field.kind === "choice" && (
					<Field label="Options" hint="Removing an option keeps it on the records that have it, but it can't be picked again.">
						<div className="flex flex-col gap-2">
							{options.map((o, i) => (
								<span key={o.id} className="flex items-center gap-2">
									<input
										value={o.label}
										onChange={(e) => setOptions(options.map((p, j) => (j === i ? { ...p, label: e.target.value } : p)))}
										className={`${inputClass} flex-1 py-1.5`}
									/>
									<button type="button" onClick={() => setOptions(options.filter((_, j) => j !== i))} className="text-sm text-neutral-400 hover:text-neutral-700">
										Remove
									</button>
								</span>
							))}
							<input value={added} onChange={(e) => setAdded(e.target.value)} placeholder="New option" className={`${inputClass} py-1.5`} />
							{retired.length > 0 && <p className="text-xs text-neutral-400">Removed: {retired.map((o) => o.label).join(", ")}</p>}
						</div>
					</Field>
				)}
				<div className="flex items-center justify-between">
					<button type="submit" className={primaryButton}>
						Save
					</button>
					{field.key !== "name" && (
						<button
							type="button"
							onClick={() => run(remove({ kind: "field", id: fieldId }), onClose)}
							className="text-sm text-neutral-500 hover:text-red-600"
						>
							Delete field
						</button>
					)}
				</div>
			</form>
		</Modal>
	);
}
