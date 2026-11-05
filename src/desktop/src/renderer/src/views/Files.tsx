import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import { formatFileSize } from "@companybot/core/files";
import { useState } from "react";
import { api } from "../api";
import { useMutation, useQuery } from "../convex";
import { navigate } from "../router";
import { ArchiveIcon, FileIcon, OpenOutsideIcon, PrivateIcon } from "../icons";
import { NotFound, Notice, Page, barButton, useRun } from "../ui";
import { FileViewer } from "./drive/FileViewer";
import { FileAccess, MoveItem } from "./pages/PageTree";
import { PageTitle } from "./pages/PageTitle";
import { archiveQuestion, useConfirm } from "./chat/common";
import { TrashNotice } from "./Trash";

// A file in Drive, at /files/<id>: shown inline where we can, with rename, move, access and Archive
// like a page. See wiki/drive.md.

export function FileView({ fileId }: { fileId?: string }) {
	if (!fileId) { navigate("pages"); return null; }
	return <FileScreen key={fileId} fileId={fileId as Id<"driveFiles">} />;
}

function FileScreen({ fileId }: { fileId: Id<"driveFiles"> }) {
	const file = useQuery(api.driveFiles.get, { fileId });
	const rename = useMutation(api.driveFiles.rename);
	const remove = useMutation(api.trash.move);
	const [moving, setMoving] = useState(false);
	const [sharing, setSharing] = useState(false);
	const { error, run } = useRun();
	const { confirm, dialog } = useConfirm();
	const crumbs = [{ label: "Drive", to: ["pages"] }, ...(file?.ancestors ?? []).map((p) => ({ label: p.title, to: ["pages", p._id] }))];
	if (!file) return <NotFound crumbs={crumbs} loaded={file === null} icon={<FileIcon />} title="File not found" />;
	const back = () => navigate(...(file.ancestors.length ? ["pages", file.ancestors.at(-1)!._id] : ["pages"]));
	return (
		<Page
			title={file.name}
			crumbs={crumbs}
			heading={<PageTitle title={file.name} editable={file.canEdit} onSave={(name) => rename({ fileId, name })} />}
			description={`${file.kind} · ${formatFileSize(file.size)}`}
			wide
			actions={
				<>
					{file.url && (
						<button type="button" onClick={() => window.open(file.url!, "_blank")} className={barButton}>
							<OpenOutsideIcon /> Open in browser
						</button>
					)}
					{file.canEdit && <button type="button" onClick={() => setMoving(true)} className={barButton}>Move to…</button>}
					<button type="button" onClick={() => setSharing(true)} title={file.lock ? (file.lock.edit ? `Only ${file.lock.who} can edit it` : `Only ${file.lock.who} can see it`) : "Everyone can access it"} className={barButton}>
						{file.restricted && <PrivateIcon />} Who can access
					</button>
					{file.canEdit && !file.archived && (
						<button type="button" onClick={() => confirm(archiveQuestion(file.name, () => run(remove({ kind: "file", id: fileId }), back)))} className={barButton}>
							<ArchiveIcon /> Archive
						</button>
					)}
				</>
			}
		>
			{dialog}
			<Notice>{error}</Notice>
			{file.trash && <TrashNotice trash={file.trash} />}
			{file.archived && !file.trash && <Notice>It's in Archive with a folder you can't see.</Notice>}
			{file.url ? <FileViewer url={file.url} type={file.type} name={file.name} /> : <Notice>The file's content is missing.</Notice>}
			{moving && <MoveItem item={{ kind: "file", _id: fileId, title: file.name, parentId: file.parentId }} onClose={() => setMoving(false)} />}
			{sharing && <FileAccess fileId={fileId} onClose={() => setSharing(false)} />}
		</Page>
	);
}
