import { useEffect, useState } from "react";
import { api } from "../../api";
import { useMutation } from "../../convex";
import { navigate } from "../../router";
import { ConflictNotice, Field, Form, Notice, secondaryButton, inputClass, primaryButton, useDraft, useRun } from "../../ui";
import { Modal, archiveQuestion, useConfirm } from "../chat/common";
import { type RecordType, useTypes } from "./data";
import { recordPath } from "./logic";
import { WhoCanAccess } from "../access";

export function DatabaseDialog({ type, onClose }: { type?: RecordType; onClose: () => void }) {
	const types = useTypes();
	const [created, setCreated] = useState<string>();
	useEffect(() => {
		const next = types?.find((t) => t._id === created);
		if (next) { navigate(...recordPath(next.key)); onClose(); }
	}, [types, created, onClose]);
	const create = useMutation(api.recordTypes.create);
	const update = useMutation(api.recordTypes.update);
	const setAccess = useMutation(api.recordTypes.setAccess);
	const remove = useMutation(api.trash.move);
	const draft = useDraft(`database:${type?._id ?? "new"}`, { name: type?.name ?? "", plural: type?.plural ?? "" }, type?.version ?? 0);
	const { error, run } = useRun();
	const { confirm, dialog } = useConfirm();
	return (
		<Modal title={type ? "Edit database" : "New database"} onClose={onClose}>
			<Form
				onSubmit={() => {
					if (type) run(update({ typeId: type._id, ...draft.value, version: draft.base }), () => { draft.discard(); onClose(); });
					else run(create({ plural: draft.value.plural }).then((id) => { draft.discard(); setCreated(id); }));
				}}
			>
				<Notice>{error}</Notice>
				{dialog}
				<ConflictNotice draft={draft} />
				<Field label="Name">
					<input autoFocus required maxLength={120} placeholder="e.g. Projects" className={inputClass} value={draft.value.plural} onChange={(e) => draft.set({ ...draft.value, plural: e.target.value })} />
				</Field>
				{type && (
					<Field label="One entry">
						<input required maxLength={120} placeholder="e.g. Project" className={inputClass} value={draft.value.name} onChange={(e) => draft.set({ ...draft.value, name: e.target.value })} />
					</Field>
				)}
				{type && (
					<div className="flex flex-col gap-1.5">
						<span className="text-sm font-medium">Who can access</span>
						<span className="text-xs text-neutral-500">Its records and their pages follow this too.</span>
						<WhoCanAccess access={type.access} onSave={(access) => setAccess({ typeId: type._id, access })} />
					</div>
				)}
				<div className="flex items-center gap-2">
					<button type="submit" disabled={draft.stale} className={primaryButton}>{type ? "Save" : "Create database"}</button>
					{type && <button type="button" className={secondaryButton} onClick={() => confirm(archiveQuestion(type.plural, () => remove({ kind: "database", id: type._id }).then(() => { onClose(); navigate("records"); }), "Its records and fields will be archived with it."))}>Archive database</button>}
				</div>
			</Form>
		</Modal>
	);
}
