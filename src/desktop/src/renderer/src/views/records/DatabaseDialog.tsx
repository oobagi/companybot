import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import { useEffect, useRef, useState } from "react";
import { api } from "../../api";
import { useMutation } from "../../convex";
import { navigate } from "../../router";
import { ConflictNotice, Form, Notice, Setting, Settings, compactButton, compactPrimaryButton, primaryButton, secondaryButton, useDraft, useRun, wideControlClass, fullControlClass } from "../../ui";
import { ArchiveIcon } from "../../icons";
import { DialogButtons, MenuItem, Modal, archiveQuestion, useConfirm } from "../chat/common";
import { type RecordType, useTypes } from "./data";
import { recordPath } from "./logic";
import { WhoCanAccess } from "../access";

/** `onCreated`: a new database's id, as soon as it's made (a section's + puts it there). */
export function DatabaseDialog({ type, onCreated, onClose }: { type?: RecordType; onCreated?: (id: Id<"recordTypes">) => void; onClose: () => void }) {
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
	const discard = useRef(draft.discard);
	discard.current = draft.discard;
	useEffect(() => () => discard.current(), []);
	const close = () => { draft.discard(); onClose(); };
	const { error, busy, run } = useRun();
	const { confirm, dialog } = useConfirm();
	const archive = () => type && confirm(archiveQuestion(type.plural, () => remove({ kind: "database", id: type._id }).then(() => { onClose(); navigate("records"); }), "Its records and fields will be archived with it."));
	const set = (key: "plural" | "name") => (e: React.ChangeEvent<HTMLInputElement>) => draft.set({ ...draft.value, [key]: e.target.value });
	if (!type)
		return (
			<Modal title="New database" size="md" onClose={close}>
				<Form onSubmit={() => run(create({ plural: draft.value.plural }).then((id) => { draft.discard(); setCreated(id); onCreated?.(id); }))}>
					<Notice>{error}</Notice>
					<input autoFocus aria-label="Name" required maxLength={120} placeholder="e.g. Projects" className={fullControlClass} value={draft.value.plural} onChange={set("plural")} />
					<DialogButtons>
						<button type="button" onClick={close} className={secondaryButton}>Cancel</button>
						<button type="submit" disabled={busy} className={primaryButton}>Create database</button>
					</DialogButtons>
				</Form>
			</Modal>
		);
	return (
		<Modal title={type.plural} onClose={close} menu={(closeMenu) => <MenuItem onClick={() => (closeMenu(), archive())}><ArchiveIcon /> Archive database</MenuItem>}>
			{dialog}
			<Form className="flex flex-col gap-3" onSubmit={() => run(update({ typeId: type._id, ...draft.value, version: draft.base }), () => draft.discard())}>
				<ConflictNotice draft={draft} />
				<Settings title="Database">
					<Setting label="Name">
						<input aria-label="Name" required maxLength={120} placeholder="e.g. Projects" className={wideControlClass} value={draft.value.plural} onChange={set("plural")} />
					</Setting>
					<Setting label="One entry" hint="What one of them is called.">
						<input aria-label="One entry" required maxLength={120} placeholder="e.g. Project" className={wideControlClass} value={draft.value.name} onChange={set("name")} />
					</Setting>
				</Settings>
				<Notice>{error}</Notice>
				{draft.dirty && (
					<DialogButtons>
						<button type="button" onClick={draft.discard} className={compactButton}>Discard</button>
						<button type="submit" disabled={busy || draft.stale} className={compactPrimaryButton}>Save</button>
					</DialogButtons>
				)}
			</Form>
			<WhoCanAccess kind="database" hint="Its records and their pages follow this too." access={type.access} onSave={(access) => setAccess({ typeId: type._id, access })} />
		</Modal>
	);
}
