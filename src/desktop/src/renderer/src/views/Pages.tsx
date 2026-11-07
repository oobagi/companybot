import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import { useState } from "react";
import { api } from "../api";
import { useMutation, useQuery } from "../convex";
import { navigate } from "../router";
import { ArchiveIcon, ArrowRightIcon, HistoryIcon, PageIcon, PlusIcon, PrivateIcon } from "../icons";
import { NotFound, Notice, Page, barButton, useRun } from "../ui";
import { DriveEmpty, DriveListing } from "./drive/DriveListing";
import { useDriveUploads } from "./drive/upload";
import { MovePage, NewMenu, PageAccess } from "./pages/PageTree";
import { PageEditor } from "./pages/PageEditor";
import { PageHistory } from "./pages/PageHistory";
import { PageTitle } from "./pages/PageTitle";
import { MenuItem, MoreMenu, archiveQuestion, useConfirm } from "./chat/common";
import { AccessLock } from "./access";
import { TrashNotice } from "./Trash";

// Drive: folders, standalone pages (wiki, SOPs, meeting notes) and files. Its sidebar is the tree;
// /pages is the top level, /pages/<id> opens a folder (its listing) or a page (its editor).
// Records' page bodies use the same editor on the record's page. See wiki/drive.md and wiki/pages.md.

export { DriveNav, NewMenu } from "./pages/PageTree";

const drive = { label: "Drive", to: ["pages"] };

export function PagesView({ pageId, canEdit }: { pageId?: string; canEdit: boolean }) {
	if (!pageId) return <DriveRoot canEdit={canEdit} />;
	return <PageOrFolder key={pageId} pageId={pageId as Id<"pages">} />;
}

/**
 * The top level of Drive: what's there, taking dropped files. No title and no New: the sidebar beside it
 * already says Drive and has the +, as Databases with nothing open.
 */
function DriveRoot({ canEdit }: { canEdit: boolean }) {
	const uploads = useDriveUploads();
	return (
		<Page title="Drive">
			<DriveListing parentId={undefined} uploads={uploads.into(undefined)} onDismissUpload={uploads.dismiss} onDrop={canEdit ? (files) => uploads.start(files) : undefined} empty={<DriveEmpty canEdit={canEdit} root />} />
		</Page>
	);
}

/** New page, New folder and Upload into `parentId`, plus the uploads going there. */
function useFolderActions(parentId: Id<"pages"> | undefined, canEdit: boolean) {
	const create = useMutation(api.pages.create);
	const uploads = useDriveUploads();
	const { error, run } = useRun();
	const add = (kind: "page" | "folder") => run(create({ title: kind === "page" ? "Untitled" : "New folder", parentId, ...(kind === "folder" && { kind }) }).then((id) => navigate("pages", id)));
	return {
		uploads: uploads.into(parentId),
		dismissUpload: uploads.dismiss,
		drop: (files: File[]) => uploads.start(files, parentId),
		actions: canEdit && <NewMenu onPage={() => add("page")} onFolder={() => add("folder")} onUpload={(files) => uploads.start(files, parentId)} className={barButton} trigger={<><PlusIcon /> New</>} />,
		dialogs: <Notice>{error}</Notice>,
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

/** Move to…, Who can access and Archive, shared by page and folder screens. */
function useItemActions(page: Loaded) {
	const remove = useMutation(api.trash.move);
	const [moving, setMoving] = useState(false);
	const [sharing, setSharing] = useState(false);
	const { error, run } = useRun();
	const { confirm, dialog } = useConfirm();
	const folder = page.kind === "folder";
	const back = () => navigate(...(page.ancestors.length ? ["pages", page.ancestors.at(-1)!._id] : ["pages"]));
	// The bar's ⋯ menu: the same items as the row's in the sidebar.
	const menu = (close: () => void) => (
		<>
			{page.canEdit && <MenuItem onClick={() => { close(); setMoving(true); }}><ArrowRightIcon /> Move to…</MenuItem>}
			{!page.recordId && <MenuItem onClick={() => { close(); setSharing(true); }}><PrivateIcon /> Who can access</MenuItem>}
			{page.canEdit && !page.archived && (
				<MenuItem onClick={() => { close(); confirm(archiveQuestion(page.title, () => run(remove({ kind: page.kind, id: page._id }), back), folder ? "Everything in it will be archived with it." : "Its sub-pages will be archived with it.")); }}>
					<ArchiveIcon /> Archive
				</MenuItem>
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
	return { menu, badge: <AccessLock lock={page.lock ?? null} />, dialogs };
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
			badge={item.badge}
			actions={<>{folder.actions}<MoreMenu label="Folder actions">{item.menu}</MoreMenu></>}
		>
			{folder.dialogs}
			{item.dialogs}
			<DriveListing parentId={page._id} uploads={folder.uploads} onDismissUpload={folder.dismissUpload} onDrop={page.canEdit && !page.archived ? folder.drop : undefined} empty={<DriveEmpty canEdit={page.canEdit && !page.archived} />} />
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
			badge={item.badge}
			actions={
				<MoreMenu label="Page actions">
					{(close) => <>
						<MenuItem onClick={() => { close(); setHistory(true); }}><HistoryIcon /> History</MenuItem>
						{item.menu(close)}
					</>}
				</MoreMenu>
			}
		>
			{item.dialogs}
			<PageEditor pageId={pageId} editable={page.canEdit} standalone={!page.recordId} focusKey={focusBody} />
			{history && <PageHistory pageId={pageId} canRestore={page.canEdit} onClose={() => setHistory(false)} />}
		</Page>
	);
}
