import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../../api";
import { useMutation, usePaginatedQuery, useQuery, useWorkspace } from "../../convex";
import { ArchiveIcon, ArrowRightIcon, ArrowUpIcon, PageIcon, PlusIcon } from "../../icons";
import { navigate } from "../../router";
import { type DragProps, useSortable } from "../../sortable";
import { LoadMore, Notice, inputClass, useDebounced, useRun } from "../../ui";
import { AddButton, Group, Item, type SectionProps, trailingAction } from "../chat/Sidebar";
import { MenuItem, Modal, archiveQuestion, useConfirm } from "../chat/common";

type PageId = Id<"pages">;
type Row = { _id: PageId; title: string; hasChildren?: boolean; parentId?: PageId | null };

/** Each expanded level loads independently; no workspace-wide list or fixed tree-size cutoff. */
export function PagesNav({ openId, canEdit, section }: { openId: string | undefined; canEdit: boolean; section: SectionProps }) {
	const workspace = useWorkspace();
	return <PageNavTree key={workspace?.id} openId={openId} canEdit={canEdit} section={section} workspaceId={workspace?.id ?? ""} />;
}
function PageNavTree({ openId, canEdit, section, workspaceId }: { openId?: string; canEdit: boolean; section: SectionProps; workspaceId: string }) {
	const storageKey = `pages-expanded:${workspaceId}`;
	const [expanded, setExpanded] = useState<Set<string>>(() => {
		try { const saved = JSON.parse(localStorage.getItem(storageKey) ?? "[]"); return new Set(Array.isArray(saved) ? saved.filter((id): id is string => typeof id === "string") : []); } catch { return new Set(); }
	});
	useEffect(() => {
		try { localStorage.setItem(storageKey, JSON.stringify([...expanded])); } catch { /* Storage may be unavailable. */ }
	}, [expanded, storageKey]);
	const batches = useMemo(() => {
		const ids = [...expanded];
		return Array.from({ length: Math.ceil(ids.length / 100) }, (_, i) => ids.slice(i * 100, (i + 1) * 100));
	}, [expanded]);
	const prune = useCallback((ids: string[]) => {
		if (!ids.length) return;
		setExpanded((before) => {
			const next = new Set(before);
			for (const id of ids) next.delete(id);
			return next.size === before.size ? before : next;
		});
	}, []);
	const [moving, setMoving] = useState<Row>();
	const create = useMutation(api.pages.create);
	const remove = useMutation(api.trash.move);
	const rename = useMutation(api.pages.rename);
	const { confirm, dialog } = useConfirm();
	const { error, run } = useRun();
	const toggle = (id: string, open = !expanded.has(id)) => {
		setExpanded((before) => {
			const next = new Set(before);
			if (open) next.add(id); else next.delete(id);
			return next;
		});
	};
	const add = (parentId?: PageId) => run(create({ title: "Untitled", parentId }).then((id) => { if (parentId) toggle(parentId, true); navigate("pages", id); }));
	/** `above`: for each level above this one, whether its line continues past these rows. */
	const level = (parentId?: PageId, above: boolean[] = []): React.ReactNode => (
		<PageLevel parentId={parentId} sortKey={`sidebar.pages:${workspaceId}:${parentId ?? "top"}`} empty={!above.length && <Item icon={<PlusIcon />} onClick={() => add()} muted>New page</Item>} render={(p, drag, last) => {
			const open = p.hasChildren && expanded.has(p._id);
			const guides = parentId ? [...above, !last] : [];
			return (
				<Fragment key={p._id}>
					<Item drag={drag} icon={<PageIcon />} expanded={open} onToggle={p.hasChildren ? () => toggle(p._id) : undefined} label={p.title} guides={guides} active={p._id === openId} onClick={() => navigate("pages", p._id)}
						rename={canEdit ? { value: p.title, onSave: (title) => run(rename({ pageId: p._id, title })) } : undefined}
						menu={(close) => <>
							<MenuItem onClick={() => { close(); add(p._id); }}><PlusIcon /> New page inside</MenuItem>
							<MenuItem onClick={() => { close(); setMoving({ ...p, parentId }); }}><ArrowRightIcon /> Move to…</MenuItem>
							<MenuItem onClick={() => { close(); confirm(archiveQuestion(p.title, () => remove({ kind: "page", id: p._id }), "Its sub-pages will be archived with it.")); }}><ArchiveIcon /> Archive</MenuItem>
						</>}
						actions={<button type="button" title="Add a page inside" aria-label={`Add a page inside ${p.title}`} onClick={() => add(p._id)} className={trailingAction}><PlusIcon /></button>}>
						<span className="truncate">{p.title}</span>
					</Item>
					{open && level(p._id, guides)}
				</Fragment>
			);
		}} />
	);
	return (
		<Group title="Pages" section={section} add={<AddButton label="New page" onClick={() => add()} />}>
			{batches.map((ids, i) => <PruneExpanded key={i} ids={ids} onPrune={prune} />)}
			{!section.collapsed && level()}
			{dialog}
			<Notice>{error}</Notice>
			{moving && <MovePage page={moving} onClose={() => setMoving(undefined)} />}
		</Group>
	);
}

function PruneExpanded({ ids, onPrune }: { ids: string[]; onPrune: (ids: string[]) => void }) {
	const live = useQuery(api.pages.liveIds, { ids });
	useEffect(() => {
		if (live) { const kept = new Set(live); onPrune(ids.filter((id) => !kept.has(id))); }
	}, [live, ids, onPrune]);
	return null;
}

/** One level of the tree. With `sortKey`, drag rows to reorder them within the level; the order is yours, kept on this computer (`useSortable`). */
export function PageLevel({ parentId, sortKey = "", render, empty }: { parentId?: PageId; sortKey?: string; render: (row: Row, drag: DragProps | undefined, last: boolean) => React.ReactNode; empty?: React.ReactNode }) {
	const { results, status, loadMore } = usePaginatedQuery(api.pages.children, { parentId }, { initialNumItems: 30 });
	const { sorted, drag } = useSortable(sortKey, results, rowId);
	return <>{status === "Exhausted" && !results.length && empty}{sorted.map((p, i) => render(p, sortKey ? drag(p._id) : undefined, i === sorted.length - 1 && status !== "CanLoadMore"))}<LoadMore status={status} onMore={() => loadMore(30)} /></>;
}
const rowId = (p: Row) => p._id;

/**
 * Where a page goes: the top level, a top-level page, or any page found by title (nested ones
 * show their path). One click moves it; the server checks cycles and depth.
 */
export function MovePage({ page, onClose }: { page: Row; onClose: () => void }) {
	const [query, setQuery] = useState("");
	const text = useDebounced(query.trim());
	const found = useQuery(api.pages.search, text ? { query: text } : "skip");
	const move = useMutation(api.pages.move);
	const { error, busy, run } = useRun();
	const here = page.parentId ?? null;
	const moveTo = (parentId: PageId | null) => !busy && parentId !== here && run(move({ pageId: page._id, parentId: parentId ?? undefined }), onClose);
	const destination = (p: Row & { path?: string[] }) => (
		<Item key={p._id} icon={<PageIcon />} muted={p._id === here} onClick={() => moveTo(p._id)}>
			<span className="truncate">
				{!!p.path?.length && <span className="text-neutral-400">{p.path.join(" / ")} / </span>}
				{p.title}
			</span>
			{p._id === here && <Current />}
		</Item>
	);
	return (
		<Modal title={`Move ${page.title}`} onClose={onClose}>
			<input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search pages…" aria-label="Search pages" className={inputClass} />
			<Notice>{error}</Notice>
			<div className="flex max-h-72 flex-col overflow-y-auto">
				{text ? (
					<>
						{found?.filter((p) => p._id !== page._id).map(destination)}
						{found && !found.some((p) => p._id !== page._id) && <p className="px-2 py-1 text-sm text-neutral-400">No pages match.</p>}
					</>
				) : (
					<>
						<Item icon={<ArrowUpIcon />} muted={here === null} onClick={() => moveTo(null)}>
							<span className="truncate">Top level</span>
							{here === null && <Current />}
						</Item>
						<PageLevel parentId={undefined} render={(p) => p._id !== page._id && destination(p)} />
					</>
				)}
			</div>
		</Modal>
	);
}

const Current = () => <span className="ml-auto text-xs text-neutral-400">Current</span>;
