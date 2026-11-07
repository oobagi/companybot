import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import { formatFileSize } from "@companybot/core/files";
import { useState } from "react";
import { api } from "../api";
import { useMutation, useQuery } from "../convex";
import { navigate } from "../router";
import { ArchiveIcon, ArrowRightIcon, FileIcon, OpenOutsideIcon, PrivateIcon } from "../icons";
import { NotFound, Notice, Page, useRun } from "../ui";
import { FileViewer } from "./drive/FileViewer";
import { FileAccess, MoveItem } from "./pages/PageTree";
import { PageTitle } from "./pages/PageTitle";
import { MenuItem, archiveQuestion, useConfirm } from "./chat/common";
import { AccessLock } from "./access";
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
	const crumbs = (file?.ancestors ?? []).map((p) => ({ label: p.title, to: ["pages", p._id] }));
	if (!file) return <NotFound crumbs={crumbs} loaded={file === null} icon={<FileIcon />} title="File not found" />;
	const back = () => navigate(...(file.ancestors.length ? ["pages", file.ancestors.at(-1)!._id] : ["pages"]));
	return (
		<Page
			title={file.name}
			crumbs={crumbs}
			heading={<PageTitle title={file.name} editable={file.canEdit} onSave={(name) => rename({ fileId, name })} />}
			description={`${file.kind} · ${formatFileSize(file.size)}`}
			wide
			badge={<AccessLock lock={file.lock ?? null} />}
			menu={(close) => <>
						{file.url && <MenuItem onClick={() => { close(); window.open(file.url!, "_blank"); }}><OpenOutsideIcon /> Open in browser</MenuItem>}
						{file.canEdit && <MenuItem onClick={() => { close(); setMoving(true); }}><ArrowRightIcon /> Move to…</MenuItem>}
						<MenuItem onClick={() => { close(); setSharing(true); }}><PrivateIcon /> Who can access</MenuItem>
						{file.canEdit && !file.archived && <MenuItem onClick={() => { close(); confirm(archiveQuestion(file.name, () => run(remove({ kind: "file", id: fileId }), back))); }}><ArchiveIcon /> Archive</MenuItem>}
			</>}
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
