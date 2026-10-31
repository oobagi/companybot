import { useEffect, useState } from "react";
import { api } from "../../api";
import { useMutation } from "../../convex";
import { navigate } from "../../router";
import { ConflictNotice, Field, Form, Notice, secondaryButton, inputClass, primaryButton, useDraft, useRun } from "../../ui";
import { Modal, archiveQuestion, useConfirm } from "../chat/common";
import { type RecordType, useTypes } from "./data";
import { recordPath } from "./logic";

export function DatabaseDialog({ type, onClose }: { type?: RecordType; onClose: () => void }) {
	const types = useTypes();
	const [created, setCreated] = useState<string>();
	useEffect(() => {
		const next = types?.find((t) => t._id === created);
		if (next) { navigate(...recordPath(next.key)); onClose(); }
	}, [types, created, onClose]);
	const create = useMutation(api.recordTypes.create);
	const update = useMutation(api.recordTypes.update);
	const remove = useMutation(api.trash.move);
	const draft = useDraft({ name: type?.name ?? "", plural: type?.plural ?? "" }, type?.version ?? 0);
	const { error, run } = useRun();
	const { confirm, dialog } = useConfirm();
	return (
		<Modal title={type ? "Edit database" : "New database"} onClose={onClose}>
			<Form
				onSubmit={() => {
					if (type) run(update({ typeId: type._id, ...draft.value, version: draft.base }), onClose);
					else run(create({ plural: draft.value.plural }).then(setCreated));
				}}
			>
				<Notice>{error}</Notice>
				{dialog}
				<ConflictNotice draft={draft} />
				<Field label="Name" hint="For example Projects.">
					<input autoFocus required maxLength={120} className={inputClass} value={draft.value.plural} onChange={(e) => draft.set({ ...draft.value, plural: e.target.value })} />
				</Field>
				{type && (
					<Field label="One entry" hint="For example Project.">
						<input required maxLength={120} className={inputClass} value={draft.value.name} onChange={(e) => draft.set({ ...draft.value, name: e.target.value })} />
					</Field>
				)}
				<div className="flex items-center gap-2">
					<button type="submit" disabled={draft.stale} className={primaryButton}>{type ? "Save" : "Create database"}</button>
					{type && <button type="button" className={secondaryButton} onClick={() => confirm(archiveQuestion(type.plural, () => remove({ kind: "database", id: type._id }).then(() => { onClose(); navigate("chat"); }), "Its records and fields will be archived with it."))}>Archive database</button>}
				</div>
			</Form>
		</Modal>
	);
}
