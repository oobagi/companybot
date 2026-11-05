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
import { Group, Item, type SectionProps, trailingAction } from "../chat/Sidebar";
import { MenuItem, Modal, Popover, archiveQuestion, useConfirm } from "../chat/common";
import { FileKindIcon } from "../drive/FileIcon";
import { type DriveUpload, useDriveUploads } from "../drive/upload";

// Drive's sidebar: a tree of folders, pages and files (wiki/drive.md). Folders hold all three;
// pages hold sub-pages; files sit in folders or at the top level. Each expanded level loads on its own.

type PageId = Id<"pages">;
type FileId = Id<"driveFiles">;
/** `canEdit`: Rename, Move, New inside and Archive (`pages.edit` and Edit in it), from the server. */
export type Row = { _id: PageId; kind?: "page" | "folder"; title: string; hasChildren?: boolean; parentId?: PageId | null; lock?: { who: string; edit: boolean } | null; canEdit?: boolean };
export type FileRow = { _id: FileId; name: string; type: string; size: number; parentId?: PageId | null; lock?: { who: string; edit: boolean } | null; canEdit?: boolean };
/** Something that can be moved: a page or folder (pages rows), or a file. */
export type Movable = { kind: "page" | "folder" | "file"; _id: string; title: string; parentId?: PageId | null };

export function DriveNav({ openId, openFileId, canEdit, section }: { openId: string | undefined; openFileId: string | undefined; canEdit: boolean; section?: SectionProps }) {
	const workspace = useWorkspace();
	return <DriveNavTree key={workspace?.id} openId={openId} openFileId={openFileId} canEdit={canEdit} section={section} />;
}
function DriveNavTree({ openId, openFileId, canEdit, section }: { openId?: string; openFileId?: string; canEdit: boolean; section?: SectionProps }) {
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
				empty={!above.length && canEdit && <Item icon={<PlusIcon />} onClick={() => add("page")} muted>New page</Item>}
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
								actions={p.canEdit ? <button type="button" title={folder ? "Add a page inside" : "Add a page inside"} aria-label={`Add a page inside ${p.title}`} onClick={() => add("page", p._id)} className={trailingAction}><PlusIcon /></button> : undefined}>
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
		<Group title="Drive" section={section} add={canEdit && <NewMenu onPage={() => add("page")} onFolder={() => add("folder")} onUpload={() => picker.open(undefined)} />}>
			{batches.map((ids, i) => <PruneExpanded key={i} ids={ids} onPrune={prune} />)}
			{!section?.collapsed && level()}
			{!section?.collapsed && <UploadRows uploads={uploads.pending} onDismiss={uploads.dismiss} />}
			{picker.input}
			{dialog}
			<Notice>{error}</Notice>
			{moving && <MoveItem item={moving} onClose={() => setMoving(undefined)} />}
			{sharing && "pageId" in sharing && <PageAccess pageId={sharing.pageId} onClose={() => setSharing(undefined)} />}
			{sharing && "fileId" in sharing && <FileAccess fileId={sharing.fileId} onClose={() => setSharing(undefined)} />}
		</Group>
	);
}

/** The + on Drive's header and screens: a new page or folder here, or files to upload here. */
export function NewMenu({ onPage, onFolder, onUpload, className = trailingAction, trigger = <PlusIcon /> }: { onPage: () => void; onFolder: () => void; onUpload: () => void; className?: string; trigger?: React.ReactNode }) {
	return (
		<Popover trigger={trigger} label="New" className={className} panelClassName="w-44 p-1 text-sm">
			{(close) => <>
				<MenuItem onClick={() => { close(); onPage(); }}><PageIcon /> New page</MenuItem>
				<MenuItem onClick={() => { close(); onFolder(); }}><FolderIcon /> New folder</MenuItem>
				<MenuItem onClick={() => { close(); onUpload(); }}><UploadIcon /> Upload files</MenuItem>
			</>}
		</Popover>
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
 * One level of Drive: folders first, then pages (both in the level's shared order; drag to reorder with
 * `sortable`), then files by name. A page's level has no files. `last` tells each row whether anything follows it.
 */
export function DriveLevel({ parentId, parentKind, sortable = false, renderPage, renderFile, empty }: {
	parentId?: PageId;
	parentKind?: "page" | "folder";
	sortable?: boolean;
	renderPage: (row: Row, drag: DragProps | undefined, last: boolean) => React.ReactNode;
	renderFile: (row: FileRow, last: boolean) => React.ReactNode;
	empty?: React.ReactNode;
}) {
	const pages = usePaginatedQuery(api.pages.children, { parentId }, { initialNumItems: 30 });
	const withFiles = parentKind !== "page";
	const files = usePaginatedQuery(api.driveFiles.children, withFiles ? { parentId } : "skip", { initialNumItems: 30 });
	const { sorted, drag } = useSortable("pages", pages.results, rowId, "y", parentId);
	const ordered = [...sorted.filter((p) => p.kind === "folder"), ...sorted.filter((p) => p.kind !== "folder")];
	const fileRows = withFiles ? files.results : [];
	const morePages = pages.status === "CanLoadMore";
	const moreFiles = withFiles && files.status === "CanLoadMore";
	const exhausted = pages.status === "Exhausted" && (!withFiles || files.status === "Exhausted");
	return (
		<>
			{exhausted && !ordered.length && !fileRows.length && empty}
			{ordered.map((p, i) => renderPage(p, sortable ? drag(p._id) : undefined, i === ordered.length - 1 && !morePages && !fileRows.length && !moreFiles))}
			<LoadMore status={pages.status} onMore={() => pages.loadMore(30)} />
			{fileRows.map((f, i) => renderFile(f, i === fileRows.length - 1 && !moreFiles))}
			{withFiles && <LoadMore status={files.status} onMore={() => files.loadMore(30)} />}
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
	return (
		<Modal title={page ? `Who can access ${page.title || `this ${what}`}` : "Who can access"} onClose={onClose}>
			{page?.recordId ? (
				<p className="text-sm text-neutral-500">A record's page follows its database's list.</p>
			) : (
				page && (
					<WhoCanAccess
						access={page.access}
						onSave={page.canManageAccess ? (access) => setAccess({ pageId, access }) : undefined}
						follow={page.canManageAccess ? { following: !page.ownAccess, onFollow: () => setAccess({ pageId, access: null }), label: page.parentId ? "Same as its parent" : "Same as Drive" } : undefined}
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
					access={file.access}
					onSave={file.canManageAccess ? (access) => setAccess({ fileId, access }) : undefined}
					follow={file.canManageAccess ? { following: !file.ownAccess, onFollow: () => setAccess({ fileId, access: null }), label: file.parentId ? "Same as its folder" : "Same as Drive" } : undefined}
				/>
			)}
		</Modal>
	);
}
