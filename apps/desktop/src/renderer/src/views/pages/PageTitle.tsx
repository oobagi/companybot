import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import { useState } from "react";
import { api } from "../../api";
import { useMutation } from "../../convex";
import { Form, Notice, inputClass, primaryButton, secondaryButton, useRun, useSynced } from "../../ui";
import { Modal } from "../chat/common";

/** The title, edited in place; saved when you leave it or press Enter. */
export function PageTitle({ title, editable, onSave, onEnter }: { title: string; editable: boolean; onSave: (title: string) => Promise<unknown>; onEnter?: () => void }) {
	const [draft, setDraft] = useSynced(title);
	const { error, run } = useRun();
	if (!editable) return <span className="text-4xl font-bold">{title}</span>;
	const save = () => draft.trim() && draft !== title && run(onSave(draft));
	return (
		<>
			<input
				value={draft}
				onChange={(e) => setDraft(e.target.value)}
				onBlur={save}
				onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); e.currentTarget.blur(); onEnter?.(); } }}
				autoFocus={title === "Untitled"}
				onFocus={(e) => title === "Untitled" && e.currentTarget.select()}
				aria-label="Title"
				className="w-full bg-transparent text-4xl font-bold outline-none"
			/>
			{error && <span className="block text-xs font-normal text-red-600">{error}</span>}
		</>
	);
}

export function RenamePage({ page, onClose }: { page: { _id: Id<"pages">; title: string }; onClose: () => void }) {
	const [title, setTitle] = useState(page.title);
	const rename = useMutation(api.pages.rename);
	const { error, busy, run } = useRun();
	return <Modal title="Rename page" onClose={onClose}>
		<Form onSubmit={() => run(rename({ pageId: page._id, title: title.trim() }), onClose)}>
			<Notice>{error}</Notice>
			<input autoFocus aria-label="Page title" maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} onFocus={(e) => e.currentTarget.select()} className={inputClass} />
			<div className="flex justify-end gap-2">
				<button type="button" className={secondaryButton} onClick={onClose}>Cancel</button>
				<button type="submit" className={primaryButton} disabled={busy || !title.trim()}>Rename</button>
			</div>
		</Form>
	</Modal>;
}
