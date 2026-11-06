import { useStoredIds } from "../../arrangements";
import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import { FILE_ACCEPT } from "@companybot/core/files";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../api";
import { useMutation, usePaginatedQuery, useQuery, useWorkspace } from "../../convex";
import { ArchiveIcon, ArrowRightIcon, ArrowUpIcon, FolderIcon, HouseIcon, PageIcon, PlusIcon, PrivateIcon, UploadIcon } from "../../icons";
import { AccessLock, WhoCanAccess } from "../access";
import { navigate } from "../../router";
import { type DragProps, type Dragged, useDragList, useDragStatic, useSortable } from "../../sortable";
import { LoadMore, Notice, compactControlClass, descriptionClass, metadataClass, useDebounced, useRun, trailingAction } from "../../ui";
import { Group, Item } from "../chat/Sidebar";
import { MenuItem, Modal, Popover, archiveQuestion, useConfirm } from "../chat/common";
import { FileKindIcon } from "../drive/FileIcon";
import { type DriveItem, type DriveMoves, useDriveMoves } from "../drive/move";
import { type DriveUpload, useDriveUploads } from "../drive/upload";

// Drive's sidebar: a Home row for the top level (lit when that's what's open), then "All files", a
// section that folds, holding the tree of folders, pages and files (wiki/drive.md). Folders hold all
// three; pages hold sub-pages; files sit in folders or at the top level. Each expanded level loads on
// its own. The section's + makes a page or folder at the top level, or uploads there. The whole tree
// is one drag group: rows move between levels, onto a folder or page, or onto Home (the top level).

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
	const [folded, changeFolded] = useStoredIds("folded");
	const collapsed = folded.includes("files");
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
	const moves = useDriveMoves(run);
	// Home is the top level: a row dropped on it leaves its folder.
	const home = useDragList({ group: "drive", enabled: false, holds: (_, from) => { const item = from.data as DriveItem; return item.canEdit && !!item.parentId; }, onDropOn: (from) => moves.into(from.data as DriveItem, undefined) });
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
				drag={{ group: "drive", moves, open: !parent || !!parent.canEdit }}
				renderPage={(p, drag, last) => {
					const open = p.hasChildren && expanded.has(p._id);
					const guides = guidesFor(last);
					const folder = p.kind === "folder";
					// The box carries the row and its open level when it's dragged; each row in it slides on its own.
					return (
						<div key={p._id} {...drag?.tree.box} className={`flex flex-col gap-px ${drag?.tree.box.className ?? ""}`}>
							<Item drag={drag?.tree.row} over={drag?.over} pin={`page:${p._id}`} icon={folder ? <FolderIcon /> : <PageIcon />} expanded={open} onToggle={p.hasChildren ? () => toggle(p._id) : undefined} label={p.title} guides={guides} active={p._id === openId} onClick={() => navigate("pages", p._id)}
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
						</div>
					);
				}}
				renderFile={(f, drag, last) => (
					<Item key={f._id} drag={drag?.item} pin={`file:${f._id}`} icon={<FileKindIcon type={f.type} name={f.name} />} label={f.name} guides={guidesFor(last)} active={f._id === openFileId} onClick={() => navigate("files", f._id)}
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
		// Home, then the section, spaced like Chat's channels and Direct messages (`SidebarList`).
		<div className="flex flex-col gap-4">
			{batches.map((ids, i) => <PruneExpanded key={i} ids={ids} onPrune={prune} />)}
			<div className="flex flex-col gap-px">
				<Item drag={home.item("home")} over={home.onto("home")} icon={<HouseIcon />} label="Home" active={!openId && !openFileId} onClick={() => navigate("pages")}>
					<span className="truncate">Home</span>
				</Item>
			</div>
			<Group
				title="All files"
				section={{ collapsed, onToggle: () => changeFolded({ op: collapsed ? "remove" : "add", id: "files" }) }}
				add={canEdit && <NewMenu onPage={() => add("page")} onFolder={() => add("folder")} onUpload={(files) => uploads.start(files)} />}
			>
				{!collapsed && level()}
				<UploadRows uploads={uploads.pending} onDismiss={uploads.dismiss} />
			</Group>
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
 * Dragging a level's rows (the sidebar's tree, a folder's listing): their group and what drops do.
 * `open`: rows from other levels may come in (its folder or page is editable; the top level always is).
 */
export type LevelDrag = { group: string; moves: DriveMoves; open?: boolean };
/** A row's drag: `item` on a flat row, or in the tree `tree.box` on its wrapper and `tree.row` on the row. `over`: letting go now puts the dragged row in it. */
export type RowDrag = { item: DragProps; tree: { box: DragProps; row: DragProps }; over: boolean };

const asItem = (from: Dragged) => from.data as DriveItem;

/**
 * A level's folders, or its pages, in the level's shared order (`pages` arrangement). Each kind
 * reorders among itself, takes its kind from other levels, and takes rows dropped onto its rows.
 */
function useKindRows(kind: "folder" | "page", rows: Row[], parentId: PageId | undefined, drag: LevelDrag | undefined) {
	const find = (id: string) => rows.find((p) => p._id === id);
	return useSortable("pages", rows, rowId, "y", parentId, drag && {
		group: drag.group,
		data: (id): DriveItem => ({ kind, id, canEdit: !!find(id)?.canEdit, parentId }),
		// Its own rows reorder (that needs only `sidebar.arrange`); another level's come in if they can move.
		accepts: (from) => { const item = asItem(from); return item.kind === kind && (item.parentId === parentId || (!!drag.open && item.canEdit)); },
		// A folder takes anything, a page only pages; not what's already in it.
		holds: (id, from) => { const p = find(id); const item = asItem(from); return !!p?.canEdit && item.canEdit && item.parentId !== p._id && (kind === "folder" || item.kind === "page"); },
		onReceive: (from, index, shown) => drag.moves.to(asItem(from), parentId, shown, index),
		onDropOn: (from, id) => drag.moves.into(asItem(from), id as PageId),
	});
}

/**
 * One level of Drive, loaded a page at a time: folders first, then pages (both in the level's shared
 * order), then files by name. A page's level has no files. `empty` once it's known there's nothing.
 * With `drag`, folders and pages drag to reorder and to other levels, and anything drags onto a folder
 * (pages onto pages); files, kept by name, only drag onto something.
 */
export function useDriveLevel(parentId?: PageId, parentKind?: "page" | "folder", drag?: LevelDrag) {
	const pages = usePaginatedQuery(api.pages.children, { parentId }, { initialNumItems: 30 });
	const withFiles = parentKind !== "page";
	const files = usePaginatedQuery(api.driveFiles.children, withFiles ? { parentId } : "skip", { initialNumItems: 30 });
	const folderRows = useMemo(() => pages.results.filter((p) => p.kind === "folder"), [pages.results]);
	const pageRows = useMemo(() => pages.results.filter((p) => p.kind !== "folder"), [pages.results]);
	const folders = useKindRows("folder", folderRows, parentId, drag);
	const subpages = useKindRows("page", pageRows, parentId, drag);
	const fileRows = withFiles ? files.results : [];
	const fileList = useDragList({
		group: drag?.group,
		enabled: !!drag,
		accepts: () => false,
		data: (id): DriveItem => ({ kind: "file", id, canEdit: !!fileRows.find((f) => f._id === id)?.canEdit, parentId }),
	});
	// Between the folders and the pages, so a row can land in either kind's list while it's empty.
	const boundary = useDragStatic(drag?.group ?? "", { endOf: folders.key, startOf: subpages.key });
	const exhausted = pages.status === "Exhausted" && (!withFiles || files.status === "Exhausted");
	const rows = [...folders.sorted, ...subpages.sorted];
	return {
		pages: rows,
		folderCount: folders.sorted.length,
		boundary,
		files: fileRows,
		pageDrag: (p: Row): RowDrag | undefined => {
			const list = p.kind === "folder" ? folders : subpages;
			return drag && { item: list.drag(p._id), tree: list.tree(p._id), over: list.onto(p._id) };
		},
		// Only a file you can edit picks up; the rest still slide.
		fileDrag: (f: FileRow): RowDrag | undefined => drag && { item: fileList.item(f._id, !!f.canEdit), tree: fileList.tree(f._id, !!f.canEdit), over: false },
		pagesStatus: pages.status,
		filesStatus: withFiles ? files.status : undefined,
		loadPages: () => pages.loadMore(30),
		loadFiles: () => files.loadMore(30),
		empty: exhausted && !rows.length && !fileRows.length,
	};
}
export type DriveLevelData = ReturnType<typeof useDriveLevel>;

/**
 * A level's rows, each with its drag when the level has one. `last` tells each row whether anything
 * follows it. `boundary`: in the tree, where rows come in from other levels, mark where folders end.
 */
export function DriveRows({ level, boundary, renderPage, renderFile }: {
	level: DriveLevelData;
	boundary?: boolean;
	renderPage: (row: Row, drag: RowDrag | undefined, last: boolean) => React.ReactNode;
	renderFile: (row: FileRow, drag: RowDrag | undefined, last: boolean) => React.ReactNode;
}) {
	const { pages, files, pagesStatus, filesStatus } = level;
	const morePages = pagesStatus === "CanLoadMore";
	const moreFiles = filesStatus === "CanLoadMore";
	const rows = pages.map((p, i) => renderPage(p, level.pageDrag(p), i === pages.length - 1 && !morePages && !files.length && !moreFiles));
	// No height of its own: it takes back the gap the list puts before it.
	if (boundary) rows.splice(level.folderCount, 0, <div key="boundary" {...level.boundary} className={`-mt-px ${level.boundary.className}`} />);
	return (
		<>
			{rows}
			<LoadMore status={pagesStatus} onMore={level.loadPages} />
			{files.map((f, i) => renderFile(f, level.fileDrag(f), i === files.length - 1 && !moreFiles))}
			{filesStatus && <LoadMore status={filesStatus} onMore={level.loadFiles} />}
		</>
	);
}

/** One level, loaded and rendered in one go: the sidebar's tree and the Move dialog. */
export function DriveLevel({ parentId, parentKind, drag, renderPage, renderFile, empty }: {
	parentId?: PageId;
	parentKind?: "page" | "folder";
	drag?: LevelDrag;
	renderPage: (row: Row, drag: RowDrag | undefined, last: boolean) => React.ReactNode;
	renderFile: (row: FileRow, drag: RowDrag | undefined, last: boolean) => React.ReactNode;
	empty?: React.ReactNode;
}) {
	const level = useDriveLevel(parentId, parentKind, drag);
	return (
		<>
			{level.empty && empty}
			<DriveRows level={level} boundary={!!drag} renderPage={renderPage} renderFile={renderFile} />
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
			<input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder={item.kind === "page" ? "Search pages and folders…" : "Search folders…"} aria-label="Search" className={`${compactControlClass} w-full`} />
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
		<Modal title={page ? page.title || "Untitled" : "Who can access"} onClose={onClose}>
			{page?.recordId ? (
				<p className={descriptionClass}>A record's page follows its database's list.</p>
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
