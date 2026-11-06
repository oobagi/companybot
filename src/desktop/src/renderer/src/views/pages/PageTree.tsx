import { useStoredIds } from "../../arrangements";
import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import { FILE_ACCEPT } from "@companybot/core/files";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../api";
import { useMutation, usePaginatedQuery, useQuery, useWorkspace } from "../../convex";
import { ArchiveIcon, ArrowRightIcon, ArrowUpIcon, FolderIcon, HouseIcon, PageIcon, PlusIcon, PrivateIcon, UploadIcon } from "../../icons";
import { AccessLock, WhoCanAccess } from "../access";
import { navigate } from "../../router";
import { type Section, type SectionId, dropAt, itemsGroup, unsectionedList, useSections } from "../../sections";
import { type Dragged, type RowDrag, useDragList, useDragStatic, useSortable } from "../../sortable";
import { LoadMore, Notice, compactControlClass, descriptionClass, metadataClass, useDebounced, useRun, trailingAction } from "../../ui";
import { GUIDE_WIDTH, Group, Item, SectionGroup, SectionsNav } from "../chat/Sidebar";
import { MenuItem, Modal, Popover, archiveQuestion, useConfirm } from "../chat/common";
import { FileKindIcon } from "../drive/FileIcon";
import { type DriveItem, type DriveMoves, useDriveMoves } from "../drive/move";
import { foldersFirst, useFoldersFirst } from "../drive/order";
import { type DriveUpload, useDriveUploads } from "../drive/upload";

// Drive's sidebar: a Home row for the top level (lit when that's what's open), then "All files", a
// section that folds, holding the tree of folders, pages and files (wiki/drive.md), then the sections
// people add, each holding top-level ones with what's under them. Folders hold all three; pages hold
// sub-pages; files sit in folders or at the top level. Each expanded level loads on its own. A
// section's + makes a page or folder at the top level, or uploads there, and puts it in that section.
// The whole sidebar is one drag group, drawn as a tree (`line` in sortable.ts): rows move between
// levels and sections, onto a folder or page, or onto Home (the top level).

type PageId = Id<"pages">;
type FileId = Id<"driveFiles">;
/** `canEdit`: Rename, Move, New inside and Archive (`pages.edit` and Edit in it), from the server. */
export type Row = { _id: PageId; kind?: "page" | "folder"; title: string; hasChildren?: boolean; parentId?: PageId | null; lock?: { who: string; edit: boolean } | null; canEdit?: boolean };
export type FileRow = { _id: FileId; name: string; type: string; size: number; parentId?: PageId | null; lock?: { who: string; edit: boolean } | null; canEdit?: boolean };
/** Something that can be moved: a page or folder (pages rows), or a file. */
export type Movable = { kind: "page" | "folder" | "file"; _id: string; title: string; parentId?: PageId | null };

const asItem = (from: Dragged) => from.data as DriveItem;

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
	const group = itemsGroup("drive");
	// Home is the top level: a row dropped on it leaves its folder.
	const home = useDragList({ group, enabled: false, line: true, holds: (_, from) => { const item = asItem(from); return item.canEdit && !!item.parentId; }, onDropOn: (from) => moves.into(asItem(from), undefined) });
	const toggle = (id: string, open = !expanded.has(id)) => changeExpanded({ op: open ? "add" : "remove", id });
	const sections = useSections("drive");
	/** `sectionId`: made by a section's +, so it goes in that section. */
	const add = (kind: "page" | "folder", parentId?: PageId, sectionId?: SectionId) =>
		run(create({ title: kind === "page" ? "Untitled" : "New folder", parentId, ...(kind === "folder" && { kind }) }).then((id) => { if (parentId) toggle(parentId, true); if (sectionId) sections.place(id, sectionId); navigate("pages", id); }));
	const picker = useFilePicker((files, parentId) => { uploads.start(files, parentId); if (parentId) toggle(parentId, true); });
	// The top level leaves out what sections hold, and takes their rows back where they're dropped.
	const [topOrder] = useStoredIds("pages");
	const top: TopLevel = { hide: sections.held, onReceive: (from, index, shown) => { const at = dropAt(topOrder, shown, from.id, index); sections.place(from.id, null, at.beforeId, at.fill); } };
	/** How a level's rows draw (`above`: for each level above this one, whether its line continues past these rows). A section's rows draw as the top level's. */
	const draw = (parent?: Row, above: boolean[] = []) => {
		const parentId = parent?._id;
		const guidesFor = (last: boolean) => (parentId ? [...above, !last] : []);
		return {
			renderPage: (p: Row, drag: RowDrag | undefined, last: boolean) => {
				const open = p.hasChildren && expanded.has(p._id);
				const guides = guidesFor(last);
				const folder = p.kind === "folder";
				// The box is the row and its open level: dragged, it fades as one.
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
			},
			renderFile: (f: FileRow, drag: RowDrag | undefined, last: boolean) => (
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
			),
		};
	};
	const level = (parent?: Row, above: boolean[] = []): React.ReactNode => (
		<DriveLevel
			parentId={parent?._id}
			parentKind={parent ? (parent.kind ?? "page") : undefined}
			drag={{ group, moves, line: true, inset: (parent ? above.length + 1 : 0) * GUIDE_WIDTH, open: !parent || !!parent.canEdit }}
			top={parent ? undefined : top}
			{...draw(parent, above)}
		/>
	);
	const { renderPage, renderFile } = draw();
	// Its header starts the top-level list, so a drop into it while empty draws its line under the title.
	const allFiles = useDragStatic(group, { startOf: unsectionedList("drive") });
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
				divider={allFiles}
				section={{ collapsed, onToggle: () => changeFolded({ op: collapsed ? "remove" : "add", id: "files" }) }}
				add={canEdit && <NewMenu onPage={() => add("page")} onFolder={() => add("folder")} onUpload={(files) => uploads.start(files)} />}
			>
				{!collapsed && level()}
				<UploadRows uploads={uploads.pending.filter((u) => !u.sectionId)} onDismiss={uploads.dismiss} />
			</Group>
			<SectionsNav tab="drive">
				{(section, at) => (
					<DriveSection key={section._id} section={section} at={at} moves={moves} renderPage={renderPage} renderFile={renderFile} keep={(id) => id === openId || id === openFileId}
						add={canEdit && <NewMenu onPage={() => add("page", undefined, section._id)} onFolder={() => add("folder", undefined, section._id)} onUpload={(files) => uploads.start(files, undefined, { id: section._id, onAdded: (fileId) => sections.place(fileId, section._id) })} />}>
						<UploadRows uploads={uploads.pending.filter((u) => u.sectionId === section._id)} onDismiss={uploads.dismiss} />
					</DriveSection>
				)}
			</SectionsNav>
			{picker.input}
			{dialog}
			<Notice>{error}</Notice>
			{moving && <MoveItem item={moving} onClose={() => setMoving(undefined)} />}
			{sharing && "pageId" in sharing && <PageAccess pageId={sharing.pageId} onClose={() => setSharing(undefined)} />}
			{sharing && "fileId" in sharing && <FileAccess fileId={sharing.fileId} onClose={() => setSharing(undefined)} />}
		</div>
	);
}

/**
 * A Drive section: its top-level pages, folders and files in its order, each with what's under it,
 * drawn like All files' rows. Top-level rows drag in from All files and other sections; its folders
 * and pages take rows dropped onto them like any.
 */
function DriveSection({ section, at, moves, renderPage, renderFile, keep, add, children }: {
	section: Section;
	at: { drag: RowDrag["item"] | undefined; first: boolean };
	moves: DriveMoves;
	renderPage: (row: Row, drag: RowDrag | undefined, last: boolean) => React.ReactNode;
	renderFile: (row: FileRow, drag: RowDrag | undefined, last: boolean) => React.ReactNode;
	keep: (id: string) => boolean;
	add: React.ReactNode;
	children: React.ReactNode;
}) {
	const found = useQuery(api.sidebarSections.driveRows, { sectionId: section._id });
	const pages = new Map<string, Row>(found?.pages.map((p) => [p._id, p]));
	const files = new Map<string, FileRow>(found?.files.map((f) => [f._id, f]));
	const held = section.ids.filter((id) => pages.has(id) || files.has(id));
	const rows = useFoldersFirst() ? foldersFirst(held, (id) => pages.get(id)?.kind === "folder") : held;
	const item = (id: string): DriveItem => { const p = pages.get(id); return { kind: p ? (p.kind ?? "page") : "file", id, canEdit: !!(p ?? files.get(id))?.canEdit }; };
	return (
		<SectionGroup {...at} tab="drive" section={section} rows={rows} keep={keep} add={add}
			rowDrag={{
				line: true,
				data: item,
				// Only top-level rows come in (a nested one goes to Home first); it leaves its old section with the move.
				accepts: (from) => !asItem(from).parentId,
				holds: (id, from) => { const p = pages.get(id); const dragged = asItem(from); return !!p?.canEdit && dragged.canEdit && dragged.id !== p._id && dragged.parentId !== p._id && (p.kind === "folder" || dragged.kind === "page"); },
				onDropOn: (from, id) => moves.into(asItem(from), id as PageId),
			}}
			render={(id, drag) => { const page = pages.get(id); return page ? renderPage(page, drag, false) : renderFile(files.get(id)!, drag, false); }}>
			{children}
		</SectionGroup>
	);
}

/** Drive's top level in the sidebar: it leaves out what sections hold, and `onReceive` takes their rows back. */
export type TopLevel = { hide: ReadonlySet<string>; onReceive: (from: Dragged, index: number, shown: string[]) => void };

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

/** Uploads in flight, under the rows they'll join: name and where it's at (waiting, progress, saving), or what went wrong (click to dismiss). */
export function UploadRows({ uploads, onDismiss }: { uploads: DriveUpload[]; onDismiss: (key: string) => void }) {
	return <>{uploads.map((u) => (
		<Item key={u.key} icon={<UploadIcon />} muted onClick={() => u.error && onDismiss(u.key)} title={u.error}>
			<span className="truncate">{u.name}</span>
			<span className={`ml-auto shrink-0 ${metadataClass} ${u.error ? "text-red-600" : ""}`}>{u.error ? "Failed" : u.state === "waiting" ? "Waiting" : u.state === "saving" ? "Saving…" : `${Math.round(u.progress * 100)}%`}</span>
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
 * `line` and `inset` draw the drag as a tree (sortable.ts).
 */
export type LevelDrag = { group: string; moves: DriveMoves; open?: boolean; line?: boolean; inset?: number };

/** A level's row: a page or folder, or a file. */
export type DriveRow = Row | FileRow;
export const isFile = (row: DriveRow): row is FileRow => "name" in row;
const kindOf = (row: DriveRow): DriveItem["kind"] => (isFile(row) ? "file" : (row.kind ?? "page"));
const isFolder = (row: DriveRow) => kindOf(row) === "folder";
/** Stable, so a level's sorted rows aren't rebuilt every render. */
const foldersOnTop = (rows: DriveRow[]) => foldersFirst(rows, isFolder);

/**
 * One level of Drive, loaded a page at a time: its folders, pages and files together in the level's
 * shared order (`pages` arrangement; what nobody has placed yet follows it, pages then files by name).
 * A page's level has no files. `empty` once it's known there's nothing. With `drag`, rows drag to
 * reorder and to other levels, and anything drags onto a folder (pages onto pages). `top`: the
 * sidebar's top level, which leaves out what sections hold and takes their rows back.
 */
export function useDriveLevel(parentId?: PageId, parentKind?: "page" | "folder", drag?: LevelDrag, top?: TopLevel) {
	const pages = usePaginatedQuery(api.pages.children, { parentId }, { initialNumItems: 30 });
	const withFiles = parentKind !== "page";
	const files = usePaginatedQuery(api.driveFiles.children, withFiles ? { parentId } : "skip", { initialNumItems: 30 });
	const hide = top?.hide;
	const rows = useMemo(() => {
		const all: DriveRow[] = withFiles ? [...pages.results, ...files.results] : pages.results;
		return hide ? all.filter((r) => !hide.has(r._id)) : all;
	}, [pages.results, files.results, withFiles, hide]);
	const find = (id: string) => rows.find((r) => r._id === id);
	const arrange = useFoldersFirst() ? foldersOnTop : undefined;
	// From another level: one that can move, into a level that's open to it (a page's level holds pages only).
	const comesIn = (item: DriveItem) => !!drag?.open && item.canEdit && (parentKind !== "page" || item.kind === "page");
	const list = useSortable("pages", rows, rowId, "y", parentId, {
		arrange,
		...(drag && {
		id: top ? unsectionedList("drive") : undefined,
		group: drag.group,
		line: drag.line,
		inset: drag.inset,
		data: (id): DriveItem => { const row = find(id); return { kind: row ? kindOf(row) : "page", id, canEdit: !!row?.canEdit, parentId }; },
		// Its own rows reorder (that needs only `sidebar.arrange`), and at the top a section's come back.
		accepts: (from) => { const item = asItem(from); return item.parentId === parentId || comesIn(item); },
		// A folder takes anything, a page only pages; not what's already in it.
		holds: (id, from) => { const p = find(id); const item = asItem(from); return !!p && !isFile(p) && !!p.canEdit && item.canEdit && item.id !== p._id && item.parentId !== p._id && (p.kind === "folder" || item.kind === "page"); },
		onReceive: (from, index, shown) => { const item = asItem(from); if (item.parentId === parentId) top?.onReceive(from, index, shown); else drag.moves.to(item, parentId, shown, index); },
		onDropOn: (from, id) => drag.moves.into(asItem(from), id as PageId),
		}),
	});
	const exhausted = pages.status === "Exhausted" && (!withFiles || files.status === "Exhausted");
	return {
		rows: list.sorted,
		drag: (row: DriveRow): RowDrag | undefined => drag && list.row(row._id),
		pagesStatus: pages.status,
		filesStatus: withFiles ? files.status : undefined,
		loadPages: () => pages.loadMore(30),
		loadFiles: () => files.loadMore(30),
		empty: exhausted && !list.sorted.length,
	};
}
export type DriveLevelData = ReturnType<typeof useDriveLevel>;

/** A level's rows, each with its drag when the level has one. `last` tells each row whether anything follows it. */
export function DriveRows({ level, renderPage, renderFile }: {
	level: DriveLevelData;
	renderPage: (row: Row, drag: RowDrag | undefined, last: boolean) => React.ReactNode;
	renderFile: (row: FileRow, drag: RowDrag | undefined, last: boolean) => React.ReactNode;
}) {
	const { rows, pagesStatus, filesStatus } = level;
	const more = pagesStatus === "CanLoadMore" || filesStatus === "CanLoadMore";
	return (
		<>
			{rows.map((row, i) => { const drag = level.drag(row); const last = i === rows.length - 1 && !more; return isFile(row) ? renderFile(row, drag, last) : renderPage(row, drag, last); })}
			<LoadMore status={pagesStatus} onMore={level.loadPages} />
			{filesStatus && <LoadMore status={filesStatus} onMore={level.loadFiles} />}
		</>
	);
}

/** One level, loaded and rendered in one go: the sidebar's tree and the Move dialog. */
export function DriveLevel({ parentId, parentKind, drag, top, renderPage, renderFile, empty }: {
	parentId?: PageId;
	parentKind?: "page" | "folder";
	drag?: LevelDrag;
	top?: TopLevel;
	renderPage: (row: Row, drag: RowDrag | undefined, last: boolean) => React.ReactNode;
	renderFile: (row: FileRow, drag: RowDrag | undefined, last: boolean) => React.ReactNode;
	empty?: React.ReactNode;
}) {
	const level = useDriveLevel(parentId, parentKind, drag, top);
	return (
		<>
			{level.empty && empty}
			<DriveRows level={level} renderPage={renderPage} renderFile={renderFile} />
		</>
	);
}

/** One level of pages and folders alone (a page's sub-pages in its editor). */
export function PageLevel({ parentId, render, empty }: { parentId?: PageId; render: (row: Row) => React.ReactNode; empty?: React.ReactNode }) {
	return <DriveLevel parentId={parentId} parentKind="page" renderPage={(p) => render(p)} renderFile={() => null} empty={empty} />;
}
const rowId = (row: DriveRow) => row._id;

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
