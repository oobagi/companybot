import { useStoredIds } from "../../arrangements";
import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import { FILE_ACCEPT } from "@companybot/core/files";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../api";
import { useMutation, usePaginatedQuery, useQuery, useWorkspace } from "../../convex";
import { ArchiveIcon, ArrowRightIcon, ArrowUpIcon, FolderIcon, PageIcon, PlusIcon, PrivateIcon, UploadIcon } from "../../icons";
import { AccessLock, WhoCanAccess } from "../access";
import { navigate } from "../../router";
import { type DragProps, useSortable } from "../../sortable";
import { LoadMore, Notice, inputClass, metadataClass, useDebounced, useRun } from "../../ui";
import { Item, trailingAction } from "../chat/Sidebar";
import { MenuItem, Modal, Popover, archiveQuestion, useConfirm } from "../chat/common";
import { FileKindIcon } from "../drive/FileIcon";
import { type DriveUpload, useDriveUploads } from "../drive/upload";

// Drive's sidebar: a tree of folders, pages and files (wiki/drive.md). Folders hold all three;
// pages hold sub-pages; files sit in folders or at the top level. Each expanded level loads on its
// own. The + beside the tab's name (App.tsx) makes a page or folder at the top level, or uploads there.

type PageId = Id<"pages">;
type FileId = Id<"driveFiles">;
/** `canEdit`: Rename, Move, New inside and Archive (`pages.edit` and Edit in it), from the server. */
export type Row = { _id: PageId; kind?: "page" | "folder"; title: string; hasChildren?: boolean; parentId?: PageId | null; lock?: { who: string; edit: boolean } | null; canEdit?: boolean };
export type FileRow = { _id: FileId; name: string; type: string; size: number; parentId?: PageId | null; lock?: { who: string; edit: boolean } | null; canEdit?: boolean };
/** Something that can be moved: a page or folder (pages rows), or a file. */
export type Movable = { kind: "page" | "folder" | "file"; _id: string; title: string; parentId?: PageId | null };

export function DriveNav({ openId, openFileId, canEdit }: { openId: string | undefined; openFileId: string | undefined; canEdit: boolean }) {
	const workspace = useWorkspace();
	return <DriveNavTree key={workspace?.id} openId={openId} openFileId={openFileId} canEdit={canEdit} />;
}
function DriveNavTree({ openId, openFileId, canEdit }: { openId?: string; openFileId?: string; canEdit: boolean }) {
	const [expandedIds, changeExpanded] = useStoredIds("expanded");
	const expanded = useMemo(() => new Set(expandedIds), [expandedIds]);
	const batches = useMemo(() => {
		const ids = [...expanded];
		return Array.from({ length: Math.ceil(ids.length / 100) }, (_, i) => ids.slice(i * 100, (i + 1) * 100));
	}, [expanded]);
	const prune = useCallback((ids: string[]) => {
		for (const id of ids) changeExpanded({ op: "remove", id });
	}, [changeExpanded]);
	const [moving, setMoving] = useState<Movable>();
	const [sharing, setSharing] = useState<{ pageId: PageId } | { fileId: FileId }>();
	const create = useMutation(api.pages.create);
	const remove = useMutation(api.trash.move);
	const rename = useMutation(api.pages.rename);
	const renameFile = useMutation(api.driveFiles.rename);
	const uploads = useDriveUploads();
	const { confirm, dialog } = useConfirm();
	const { error, run } = useRun();
	const toggle = (id: string, open = !expanded.has(id)) => changeExpanded({ op: open ? "add" : "remove", id });
	const add = (kind: "page" | "folder", parentId?: PageId) =>
		run(create({ title: kind === "page" ? "Untitled" : "New folder", parentId, ...(kind === "folder" && { kind }) }).then((id) => { if (parentId) toggle(parentId, true); navigate("pages", id); }));
	const picker = useFilePicker((files, parentId) => { uploads.start(files, parentId); if (parentId) toggle(parentId, true); });
	/** `above`: for each level above this one, whether its line continues past these rows. */
	const level = (parent?: Row, above: boolean[] = []): React.ReactNode => {
		const parentId = parent?._id;
		const guidesFor = (last: boolean) => (parentId ? [...above, !last] : []);
		return (
			<DriveLevel
				parentId={parentId}
				parentKind={parent ? (parent.kind ?? "page") : undefined}
				sortable
				renderPage={(p, drag, last) => {
					const open = p.hasChildren && expanded.has(p._id);
					const guides = guidesFor(last);
					const folder = p.kind === "folder";
					return (
						<Fragment key={p._id}>
							<Item drag={drag} pin={`page:${p._id}`} icon={folder ? <FolderIcon /> : <PageIcon />} expanded={open} onToggle={p.hasChildren ? () => toggle(p._id) : undefined} label={p.title} guides={guides} active={p._id === openId} onClick={() => navigate("pages", p._id)}
								rename={p.canEdit ? { value: p.title, onSave: (title) => run(rename({ pageId: p._id, title })) } : undefined}
								menu={p.canEdit ? (close) => <>
									<MenuItem onClick={() => { close(); add("page", p._id); }}><PlusIcon /> New page inside</MenuItem>
									{folder && <MenuItem onClick={() => { close(); add("folder", p._id); }}><FolderIcon /> New folder inside</MenuItem>}
									{folder && <MenuItem onClick={() => { close(); picker.open(p._id); }}><UploadIcon /> Upload here</MenuItem>}
									<MenuItem onClick={() => { close(); setMoving({ ...p, kind: p.kind ?? "page", parentId }); }}><ArrowRightIcon /> Move to…</MenuItem>
									<MenuItem onClick={() => { close(); setSharing({ pageId: p._id }); }}><PrivateIcon /> Who can access</MenuItem>
									<MenuItem onClick={() => { close(); confirm(archiveQuestion(p.title, () => remove({ kind: p.kind ?? "page", id: p._id }), folder ? "Everything in it will be archived with it." : "Its sub-pages will be archived with it.")); }}><ArchiveIcon /> Archive</MenuItem>
								</> : undefined}
								actions={p.canEdit ? <button type="button" title="Add a page inside" aria-label={`Add a page inside ${p.title}`} onClick={() => add("page", p._id)} className={trailingAction}><PlusIcon /></button> : undefined}>
								<span className="truncate">{p.title}</span>
								<AccessLock lock={p.lock ?? null} />
							</Item>
							{open && level(p, guides)}
						</Fragment>
					);
				}}
				renderFile={(f, last) => (
					<Item key={f._id} pin={`file:${f._id}`} icon={<FileKindIcon type={f.type} name={f.name} />} label={f.name} guides={guidesFor(last)} active={f._id === openFileId} onClick={() => navigate("files", f._id)}
						rename={f.canEdit ? { value: f.name, onSave: (name) => run(renameFile({ fileId: f._id, name })) } : undefined}
						menu={f.canEdit ? (close) => <>
							<MenuItem onClick={() => { close(); setMoving({ kind: "file", _id: f._id, title: f.name, parentId }); }}><ArrowRightIcon /> Move to…</MenuItem>
							<MenuItem onClick={() => { close(); setSharing({ fileId: f._id }); }}><PrivateIcon /> Who can access</MenuItem>
							<MenuItem onClick={() => { close(); confirm(archiveQuestion(f.name, () => remove({ kind: "file", id: f._id }))); }}><ArchiveIcon /> Archive</MenuItem>
						</> : undefined}>
						<span className="truncate">{f.name}</span>
						<AccessLock lock={f.lock ?? null} />
					</Item>
				)}
			/>
		);
	};
	return (
		<div className="flex flex-col gap-px">
			{batches.map((ids, i) => <PruneExpanded key={i} ids={ids} onPrune={prune} />)}
			{level()}
			<UploadRows uploads={uploads.pending} onDismiss={uploads.dismiss} />
			{picker.input}
			{dialog}
			<Notice>{error}</Notice>
			{moving && <MoveItem item={moving} onClose={() => setMoving(undefined)} />}
			{sharing && "pageId" in sharing && <PageAccess pageId={sharing.pageId} onClose={() => setSharing(undefined)} />}
			{sharing && "fileId" in sharing && <FileAccess fileId={sharing.fileId} onClose={() => setSharing(undefined)} />}
		</div>
	);
}

/** The + beside Drive's name and on its screens: a new page or folder here, or files to upload here (it asks for them). */
export function NewMenu({ onPage, onFolder, onUpload, className = trailingAction, trigger = <PlusIcon /> }: { onPage: () => void; onFolder: () => void; onUpload: (files: File[]) => void; className?: string; trigger?: React.ReactNode }) {
	const picker = useFilePicker(onUpload);
	return (
		<>
			<Popover trigger={trigger} label="New" className={className} panelClassName="w-44 p-1 text-sm">
				{(close) => <>
					<MenuItem onClick={() => { close(); onPage(); }}><PageIcon /> New page</MenuItem>
					<MenuItem onClick={() => { close(); onFolder(); }}><FolderIcon /> New folder</MenuItem>
					<MenuItem onClick={() => { close(); picker.open(); }}><UploadIcon /> Upload files</MenuItem>
				</>}
			</Popover>
			{picker.input}
		</>
	);
}

/** A hidden file input: `open(parentId)` asks for files, which `onFiles` gets for that folder. */
export function useFilePicker(onFiles: (files: File[], parentId?: PageId) => void) {
	const ref = useRef<HTMLInputElement>(null);
	const target = useRef<PageId>(undefined);
	const input = (
		<input ref={ref} type="file" multiple accept={FILE_ACCEPT} className="hidden" aria-hidden onChange={(e) => { const files = [...(e.target.files ?? [])]; e.target.value = ""; if (files.length) onFiles(files, target.current); }} />
	);
	return { input, open: (parentId?: PageId) => { target.current = parentId; ref.current?.click(); } };
}

/** Uploads in flight, under the rows they'll join: name and progress, or what went wrong (click to dismiss). */
export function UploadRows({ uploads, onDismiss }: { uploads: DriveUpload[]; onDismiss: (key: string) => void }) {
	return <>{uploads.map((u) => (
		<Item key={u.key} icon={<UploadIcon />} muted onClick={() => u.error && onDismiss(u.key)} title={u.error}>
			<span className="truncate">{u.name}</span>
			<span className={`ml-auto shrink-0 ${metadataClass} ${u.error ? "text-red-600" : ""}`}>{u.error ? "Failed" : `${Math.round(u.progress * 100)}%`}</span>
		</Item>
	))}</>;
}

function PruneExpanded({ ids, onPrune }: { ids: string[]; onPrune: (ids: string[]) => void }) {
	const live = useQuery(api.pages.liveIds, { ids });
	useEffect(() => {
		if (live) { const kept = new Set(live); onPrune(ids.filter((id) => !kept.has(id))); }
	}, [live, ids, onPrune]);
	return null;
}

/**
 * One level of Drive, loaded a page at a time: folders first, then pages (both in the level's shared
 * order), then files by name. A page's level has no files. `empty` once it's known there's nothing.
 */
export function useDriveLevel(parentId?: PageId, parentKind?: "page" | "folder") {
	const pages = usePaginatedQuery(api.pages.children, { parentId }, { initialNumItems: 30 });
	const withFiles = parentKind !== "page";
	const files = usePaginatedQuery(api.driveFiles.children, withFiles ? { parentId } : "skip", { initialNumItems: 30 });
	const { sorted, drag } = useSortable("pages", pages.results, rowId, "y", parentId);
	const rows = [...sorted.filter((p) => p.kind === "folder"), ...sorted.filter((p) => p.kind !== "folder")];
	const fileRows = withFiles ? files.results : [];
	const exhausted = pages.status === "Exhausted" && (!withFiles || files.status === "Exhausted");
	return {
		pages: rows,
		files: fileRows,
		drag,
		pagesStatus: pages.status,
		filesStatus: withFiles ? files.status : undefined,
		loadPages: () => pages.loadMore(30),
		loadFiles: () => files.loadMore(30),
		empty: exhausted && !rows.length && !fileRows.length,
	};
}
export type DriveLevelData = ReturnType<typeof useDriveLevel>;

/** A level's rows. With `sortable`, drag folders and pages to reorder them. `last` tells each row whether anything follows it. */
export function DriveRows({ level, sortable = false, renderPage, renderFile }: {
	level: DriveLevelData;
	sortable?: boolean;
	renderPage: (row: Row, drag: DragProps | undefined, last: boolean) => React.ReactNode;
	renderFile: (row: FileRow, last: boolean) => React.ReactNode;
}) {
	const { pages, files, drag, pagesStatus, filesStatus } = level;
	const morePages = pagesStatus === "CanLoadMore";
	const moreFiles = filesStatus === "CanLoadMore";
	return (
		<>
			{pages.map((p, i) => renderPage(p, sortable ? drag(p._id) : undefined, i === pages.length - 1 && !morePages && !files.length && !moreFiles))}
			<LoadMore status={pagesStatus} onMore={level.loadPages} />
			{files.map((f, i) => renderFile(f, i === files.length - 1 && !moreFiles))}
			{filesStatus && <LoadMore status={filesStatus} onMore={level.loadFiles} />}
		</>
	);
}

/** One level, loaded and rendered in one go: the sidebar's tree and the Move dialog. */
export function DriveLevel({ parentId, parentKind, sortable, renderPage, renderFile, empty }: {
	parentId?: PageId;
	parentKind?: "page" | "folder";
	sortable?: boolean;
	renderPage: (row: Row, drag: DragProps | undefined, last: boolean) => React.ReactNode;
	renderFile: (row: FileRow, last: boolean) => React.ReactNode;
	empty?: React.ReactNode;
}) {
	const level = useDriveLevel(parentId, parentKind);
	return (
		<>
			{level.empty && empty}
			<DriveRows level={level} sortable={sortable} renderPage={renderPage} renderFile={renderFile} />
		</>
	);
}

/** One level of pages and folders alone (a page's sub-pages in its editor). */
export function PageLevel({ parentId, render, empty }: { parentId?: PageId; render: (row: Row) => React.ReactNode; empty?: React.ReactNode }) {
	return <DriveLevel parentId={parentId} parentKind="page" renderPage={(p) => render(p)} renderFile={() => null} empty={empty} />;
}
const rowId = (p: Row) => p._id;

/**
 * Where something goes: the top level, a top-level folder or page, or any found by title (nested ones
 * show their path). Pages go in pages or folders; folders and files go in folders only. One click
 * moves it; the server checks cycles and depth.
 */
export function MoveItem({ item, onClose }: { item: Movable; onClose: () => void }) {
	const [query, setQuery] = useState("");
	const text = useDebounced(query.trim());
	const found = useQuery(api.pages.search, text ? { query: text } : "skip");
	const movePage = useMutation(api.pages.move);
	const moveFile = useMutation(api.driveFiles.move);
	const { error, busy, run } = useRun();
	const here = item.parentId ?? null;
	const takes = (p: Row) => p._id !== item._id && (item.kind === "page" || p.kind === "folder");
	const moveTo = (parentId: PageId | null) =>
		!busy && parentId !== here && run(item.kind === "file" ? moveFile({ fileId: item._id as FileId, parentId: parentId ?? undefined }) : movePage({ pageId: item._id as PageId, parentId: parentId ?? undefined }), onClose);
	const destination = (p: Row & { path?: string[] }) => (
		<Item key={p._id} icon={p.kind === "folder" ? <FolderIcon /> : <PageIcon />} muted={p._id === here || !p.canEdit} onClick={() => p.canEdit && moveTo(p._id)}>
			<span className="truncate">
				{!!p.path?.length && <span className="text-neutral-400">{p.path.join(" / ")} / </span>}
				{p.title}
			</span>
			{p._id === here && <Current />}
		</Item>
	);
	const matches = found?.filter(takes);
	return (
		<Modal title={`Move ${item.title}`} onClose={onClose}>
			<input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder={item.kind === "page" ? "Search pages and folders…" : "Search folders…"} aria-label="Search" className={inputClass} />
			<Notice>{error}</Notice>
			<div className="flex max-h-72 flex-col overflow-y-auto">
				{text ? (
					<>
						{matches?.map(destination)}
						{matches && !matches.length && <p className="px-2 py-1 text-sm text-neutral-400">No {item.kind === "page" ? "pages or folders" : "folders"} match.</p>}
					</>
				) : (
					<>
						<Item icon={<ArrowUpIcon />} muted={here === null} onClick={() => moveTo(null)}>
							<span className="truncate">Top level</span>
							{here === null && <Current />}
						</Item>
						<DriveLevel parentId={undefined} renderPage={(p) => takes(p) && destination(p)} renderFile={() => null} />
					</>
				)}
			</div>
		</Modal>
	);
}

/** Move to… for a page or folder, from its block or screen. */
export const MovePage = ({ page, onClose }: { page: Row; onClose: () => void }) => <MoveItem item={{ ...page, kind: page.kind ?? "page" }} onClose={onClose} />;

const Current = () => <span className="ml-auto text-xs text-neutral-400">Current</span>;

/**
 * Who can access a page or folder: its own list, or its parent's (a top-level one's "parent" is Everyone
 * at Edit). Everyone who sees it sees who's on it; people who can edit it change it.
 */
export function PageAccess({ pageId, onClose }: { pageId: PageId; onClose: () => void }) {
	const page = useQuery(api.pages.get, { pageId });
	const setAccess = useMutation(api.pages.setAccess);
	const what = page?.kind === "folder" ? "folder" : "page";
	const parent = page?.ancestors.at(-1);
	return (
		<Modal title={page ? `Who can access ${page.title || `this ${what}`}` : "Who can access"} onClose={onClose}>
			{page?.recordId ? (
				<p className="text-sm text-neutral-500">A record's page follows its database's list.</p>
			) : (
				page && (
					<WhoCanAccess
						kind="page"
						access={page.access}
						onSave={page.canManageAccess ? (access) => setAccess({ pageId, access }) : undefined}
						follow={page.canManageAccess ? { following: !page.ownAccess, parent: parent && (parent.kind === "folder" ? "folder" : "page"), what, onFollow: () => setAccess({ pageId, access: null }) } : undefined}
					/>
				)
			)}
		</Modal>
	);
}

/** Who can access a file: its own list, or its folder's. */
export function FileAccess({ fileId, onClose }: { fileId: FileId; onClose: () => void }) {
	const file = useQuery(api.driveFiles.get, { fileId });
	const setAccess = useMutation(api.driveFiles.setAccess);
	return (
		<Modal title={file ? `Who can access ${file.name}` : "Who can access"} onClose={onClose}>
			{file && (
				<WhoCanAccess
					kind="page"
					access={file.access}
					onSave={file.canManageAccess ? (access) => setAccess({ fileId, access }) : undefined}
					follow={file.canManageAccess ? { following: !file.ownAccess, parent: file.parentId ? "folder" : undefined, what: "file", onFollow: () => setAccess({ fileId, access: null }) } : undefined}
				/>
			)}
		</Modal>
	);
}
