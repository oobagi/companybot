import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import { useState } from "react";
import { api } from "../api";
import { useMutation, useQuery } from "../convex";
import { navigate } from "../router";
import { ArchiveIcon, HistoryIcon, PageIcon, PlusIcon, PrivateIcon } from "../icons";
import { NotFound, Notice, Page, barButton, useRun } from "../ui";
import { DriveEmpty, DriveListing } from "./drive/DriveListing";
import { useDriveUploads } from "./drive/upload";
import { MovePage, NewMenu, PageAccess, useFilePicker } from "./pages/PageTree";
import { PageEditor } from "./pages/PageEditor";
import { PageHistory } from "./pages/PageHistory";
import { PageTitle } from "./pages/PageTitle";
import { archiveQuestion, useConfirm } from "./chat/common";
import { TrashNotice } from "./Trash";

// Drive: folders, standalone pages (wiki, SOPs, meeting notes) and files. Its sidebar is the tree;
// /pages is the top level, /pages/<id> opens a folder (its listing) or a page (its editor).
// Records' page bodies use the same editor on the record's page. See wiki/drive.md and wiki/pages.md.

export { DriveNav } from "./pages/PageTree";

const drive = { label: "Drive", to: ["pages"] };

export function PagesView({ pageId, canEdit }: { pageId?: string; canEdit: boolean }) {
	if (!pageId) return <DriveRoot canEdit={canEdit} />;
	return <PageOrFolder key={pageId} pageId={pageId as Id<"pages">} />;
}

/** The top level of Drive: what's there, with New and Upload. */
function DriveRoot({ canEdit }: { canEdit: boolean }) {
	const folder = useFolderActions(undefined, canEdit);
	return (
		<Page title="Drive" heading="Drive" wide actions={folder.actions}>
			{folder.dialogs}
			<DriveListing parentId={undefined} uploads={folder.uploads.pending} onDismissUpload={folder.uploads.dismiss} onDrop={canEdit ? folder.drop : undefined} empty={<DriveEmpty canEdit={canEdit} />} />
		</Page>
	);
}

/** New page, New folder and Upload into `parentId`, plus the uploads they start. */
function useFolderActions(parentId: Id<"pages"> | undefined, canEdit: boolean) {
	const create = useMutation(api.pages.create);
	const uploads = useDriveUploads();
	const { error, run } = useRun();
	const picker = useFilePicker((files) => uploads.start(files, parentId));
	const add = (kind: "page" | "folder") => run(create({ title: kind === "page" ? "Untitled" : "New folder", parentId, ...(kind === "folder" && { kind }) }).then((id) => navigate("pages", id)));
	return {
		uploads,
		drop: (files: File[]) => uploads.start(files, parentId),
		actions: canEdit && <NewMenu onPage={() => add("page")} onFolder={() => add("folder")} onUpload={() => picker.open(parentId)} className={barButton} trigger={<><PlusIcon /> New</>} />,
		dialogs: <>{picker.input}<Notice>{error}</Notice></>,
	};
}

function PageOrFolder({ pageId }: { pageId: Id<"pages"> }) {
	const page = useQuery(api.pages.get, { pageId });
	const crumbs = [drive, ...(page?.ancestors ?? []).map((p) => ({ label: p.title, to: ["pages", p._id] }))];
	if (!page) return <NotFound crumbs={crumbs} loaded={page === null} icon={<PageIcon />} title="Page not found" />;
	return page.kind === "folder" ? <FolderScreen page={page} crumbs={crumbs} /> : <PageScreen page={page} crumbs={crumbs} />;
}

type Loaded = NonNullable<ReturnType<typeof useQuery<typeof api.pages.get>>>;
type Crumbs = { label: string; to: string[] }[];

/** Rename, Move to…, Who can access and Archive, shared by page and folder screens. */
function useItemActions(page: Loaded) {
	const remove = useMutation(api.trash.move);
	const [moving, setMoving] = useState(false);
	const [sharing, setSharing] = useState(false);
	const { error, run } = useRun();
	const { confirm, dialog } = useConfirm();
	const folder = page.kind === "folder";
	const back = () => navigate(...(page.ancestors.length ? ["pages", page.ancestors.at(-1)!._id] : ["pages"]));
	const actions = (
		<>
			{page.canEdit && <button type="button" onClick={() => setMoving(true)} className={barButton}>Move to…</button>}
			{!page.recordId && (
				<button type="button" onClick={() => setSharing(true)} title={page.lock ? (page.lock.edit ? `Only ${page.lock.who} can edit it` : `Only ${page.lock.who} can see it`) : "Everyone can access it"} className={barButton}>
					{page.restricted && <PrivateIcon />} Who can access
				</button>
			)}
			{page.canEdit && !page.archived && (
				<button type="button" onClick={() => confirm(archiveQuestion(page.title, () => run(remove({ kind: page.kind, id: page._id }), back), folder ? "Everything in it will be archived with it." : "Its sub-pages will be archived with it."))} className={barButton}>
					<ArchiveIcon /> Archive
				</button>
			)}
		</>
	);
	const dialogs = (
		<>
			{dialog}
			<Notice>{error}</Notice>
			{page.trash && <TrashNotice trash={page.trash} />}
			{page.archived && !page.trash && <Notice>It's in Archive with a {folder ? "folder" : "page"} you can't see.</Notice>}
			{moving && <MovePage page={page} onClose={() => setMoving(false)} />}
			{sharing && <PageAccess pageId={page._id} onClose={() => setSharing(false)} />}
		</>
	);
	return { actions, dialogs };
}

function FolderScreen({ page, crumbs }: { page: Loaded; crumbs: Crumbs }) {
	const rename = useMutation(api.pages.rename);
	const item = useItemActions(page);
	const folder = useFolderActions(page._id, page.canEdit && !page.archived);
	return (
		<Page
			title={page.title}
			crumbs={crumbs}
			heading={<PageTitle title={page.title} editable={page.canEdit} onSave={(title) => rename({ pageId: page._id, title })} />}
			wide
			actions={<>{folder.actions}{item.actions}</>}
		>
			{folder.dialogs}
			{item.dialogs}
			<DriveListing parentId={page._id} uploads={folder.uploads.pending} onDismissUpload={folder.uploads.dismiss} onDrop={page.canEdit && !page.archived ? folder.drop : undefined} empty={<DriveEmpty canEdit={page.canEdit && !page.archived} />} />
		</Page>
	);
}

function PageScreen({ page, crumbs }: { page: Loaded; crumbs: Crumbs }) {
	const pageId = page._id;
	const rename = useMutation(api.pages.rename);
	const [history, setHistory] = useState(false);
	const [focusBody, setFocusBody] = useState(0);
	const item = useItemActions(page);
	return (
		<Page
			title={page.title}
			crumbs={crumbs}
			heading={<PageTitle title={page.title} editable={page.canEdit} onSave={(title) => rename({ pageId, title })} onEnter={() => setFocusBody((n) => n + 1)} />}
			actions={
				<>
					<button type="button" onClick={() => setHistory(true)} className={barButton}>
						<HistoryIcon /> History
					</button>
					{item.actions}
				</>
			}
		>
			{item.dialogs}
			<PageEditor pageId={pageId} editable={page.canEdit} standalone={!page.recordId} focusKey={focusBody} />
			{history && <PageHistory pageId={pageId} canRestore={page.canEdit} onClose={() => setHistory(false)} />}
		</Page>
	);
}
