import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import { useEffect, useState } from "react";
import { api } from "../api";
import { useMutation, useQuery } from "../convex";
import { navigate } from "../router";
import { ArchiveIcon, ArrowRightIcon, HistoryIcon, PageIcon, PlusIcon, PrivateIcon } from "../icons";
import { Loading, NotFound, Notice, Page, barPrimaryButton, useRun } from "../ui";
import { DriveEmpty, DriveListing } from "./drive/DriveListing";
import { useDriveUploads } from "./drive/upload";
import { MovePage, NewMenu, PageAccess } from "./pages/PageTree";
import { PageEditor } from "./pages/PageEditor";
import { PageHistory } from "./pages/PageHistory";
import { PageTitle } from "./pages/PageTitle";
import { MenuItem, archiveQuestion, useConfirm } from "./chat/common";
import { recordPath } from "./records/logic";
import { AccessLock } from "./access";
import { TrashNotice } from "./Trash";

// Drive: folders, standalone pages (wiki, SOPs, meeting notes) and files. Its sidebar is the tree;
// /pages is the top level, /pages/<id> opens a folder (its listing) or a page (its editor).
// Every page has one screen (`PageView`), Notion's way: a page in Drive, and a record's page, the same screen
// with the record's properties above its body (RecordPage). See wiki/drive.md and wiki/pages.md.

export { DriveNav, NewMenu } from "./pages/PageTree";

export function PagesView({ pageId, canEdit }: { pageId?: string; canEdit: boolean }) {
	if (!pageId) return <DriveRoot canEdit={canEdit} />;
	return <PageOrFolder key={pageId} pageId={pageId as Id<"pages">} />;
}

/**
 * The top level of Drive: what's there, taking dropped files. Titled Home, as its sidebar row; no heading
 * and no New, since the sidebar beside it has the +, as Databases with nothing open.
 */
function DriveRoot({ canEdit }: { canEdit: boolean }) {
	const uploads = useDriveUploads();
	return (
		<Page title="Home">
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
		actions: canEdit && <NewMenu onPage={() => add("page")} onFolder={() => add("folder")} onUpload={(files) => uploads.start(files, parentId)} className={barPrimaryButton} trigger={<><PlusIcon /> New</>} />,
		dialogs: <Notice>{error}</Notice>,
	};
}

/**
 * The page screen, Drive's and every record's: the title (Enter goes on into the body), the title's menu (its
 * actions), what sits above the body (a record's properties), then the body. `body`: undefined while it loads,
 * null for a record nobody has written in that you can't edit.
 */
export function PageView({ title, crumbs, editableTitle, onRename, menu, badge, notices, above, body, children }: {
	title: string;
	crumbs: Crumbs;
	editableTitle: boolean;
	onRename: (title: string) => Promise<unknown>;
	menu: (close: () => void) => React.ReactNode;
	badge?: React.ReactNode;
	notices?: React.ReactNode;
	above?: React.ReactNode;
	body: { pageId: Id<"pages">; editable: boolean } | null | undefined;
	/** Dialogs. */
	children?: React.ReactNode;
}) {
	const [focusBody, setFocusBody] = useState(0);
	return (
		<Page title={title} crumbs={crumbs} heading={<PageTitle title={title} editable={editableTitle} onSave={onRename} onEnter={() => setFocusBody((n) => n + 1)} />} menu={menu} badge={badge} gutter>
			{notices}
			{above}
			{body === undefined ? <Loading /> : body && <PageEditor pageId={body.pageId} editable={body.editable} focusKey={focusBody} />}
			{children}
		</Page>
	);
}

function PageOrFolder({ pageId }: { pageId: Id<"pages"> }) {
	const page = useQuery(api.pages.get, { pageId });
	// A record's own page opens as its record.
	const record = page?.record;
	const own = !!page?.recordId && record;
	useEffect(() => {
		if (own) navigate(...recordPath(own.typeKey, own._id));
	}, [own]);
	// The trail is the folders it's in (the sidebar already says Drive); inside a record's page: Database › Record › the pages between.
	const crumbs = [
		...(record ? [{ label: record.plural, to: recordPath(record.typeKey) }, { label: record.title, to: recordPath(record.typeKey, record._id) }] : []),
		...(page?.ancestors ?? []).map((p) => ({ label: p.title, to: ["pages", p._id] })),
	];
	if (!page) return <NotFound crumbs={crumbs} loaded={page === null} icon={<PageIcon />} title="Page not found" />;
	if (own) return null;
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
	// Archiving opens where it was: the page or folder above, else its record, else Drive.
	const back = () => navigate(...(page.ancestors.length ? ["pages", page.ancestors.at(-1)!._id] : page.record ? recordPath(page.record.typeKey, page.record._id) : ["pages"]));
	// The title's menu: the same items as the row's in the sidebar.
	const menu = (close: () => void) => (
		<>
			{page.canEdit && <MenuItem onClick={() => { close(); setMoving(true); }}><ArrowRightIcon /> Move to…</MenuItem>}
			<MenuItem onClick={() => { close(); setSharing(true); }}><PrivateIcon /> Who can access</MenuItem>
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
			menu={item.menu}
			badge={item.badge}
			actions={folder.actions}
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
	const item = useItemActions(page);
	return (
		<PageView
			title={page.title}
			crumbs={crumbs}
			editableTitle={page.canEdit}
			onRename={(title) => rename({ pageId, title })}
			menu={(close) => <>
				<MenuItem onClick={() => { close(); setHistory(true); }}><HistoryIcon /> History</MenuItem>
				{item.menu(close)}
			</>}
			badge={item.badge}
			notices={item.dialogs}
			body={{ pageId, editable: page.canEdit }}
		>
			{history && <PageHistory pageId={pageId} canRestore={page.canEdit} onClose={() => setHistory(false)} />}
		</PageView>
	);
}
