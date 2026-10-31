import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../../api";
import { useMutation, usePaginatedQuery, useQuery, useWorkspace } from "../../convex";
import { ArchiveIcon, CaretRightIcon, MoreIcon, PageIcon, PlusIcon } from "../../icons";
import { navigate } from "../../router";
import { LoadMore, Notice, primaryButton, secondaryButton, useRun } from "../../ui";
import { AddButton, Group, Item, type SectionProps, trailingAction } from "../chat/Sidebar";
import { MenuItem, Modal, Popover, archiveQuestion, useConfirm } from "../chat/common";
import { RenamePage } from "./PageTitle";

type PageId = Id<"pages">;
type Row = { _id: PageId; title: string; hasChildren?: boolean };

/** Each expanded level loads independently; no workspace-wide list or fixed tree-size cutoff. */
export function PagesNav({ openId, section }: { openId: string | undefined; section: SectionProps }) {
	const workspace = useWorkspace();
	return <PageNavTree key={workspace?.id} openId={openId} section={section} storageKey={`pages-expanded:${workspace?.id}`} />;
}
function PageNavTree({ openId, section, storageKey }: { openId?: string; section: SectionProps; storageKey: string }) {
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
	const [renaming, setRenaming] = useState<Row>();
	const create = useMutation(api.pages.create);
	const remove = useMutation(api.trash.move);
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
	const level = (parentId?: PageId, depth = 0): React.ReactNode => (
		<PageLevel parentId={parentId} empty={depth === 0 && <Item icon={<PlusIcon />} onClick={() => add()} muted>New page</Item>} render={(p) => {
			const open = p.hasChildren && expanded.has(p._id);
			const chevron = <button type="button" aria-label={`${open ? "Collapse" : "Expand"} ${p.title}`} aria-expanded={open} onClick={() => toggle(p._id)} className="relative z-10 hidden size-5 items-center justify-center text-neutral-400 hover:text-neutral-800 group-hover/item:flex"><CaretRightIcon className={open ? "rotate-90" : ""} /></button>;
			return (
				<Fragment key={p._id}>
					<Item icon={p.hasChildren ? <><PageIcon className="group-hover/item:hidden" />{chevron}</> : <PageIcon />} indent={depth} active={p._id === openId} onClick={() => navigate("pages", p._id)} actions={<>
						<Popover trigger={<MoreIcon />} label={`Page actions for ${p.title}`} className={trailingAction} panelClassName="w-44 p-1">
							{(close) => <><MenuItem onClick={() => { close(); setRenaming(p); }}>Rename</MenuItem><MenuItem onClick={() => { close(); setMoving(p); }}>Move to…</MenuItem><MenuItem onClick={() => { close(); confirm(archiveQuestion(p.title, () => remove({ kind: "page", id: p._id }), "Its sub-pages will be archived with it.")); }}><ArchiveIcon /> Archive</MenuItem></>}
						</Popover>
						<button type="button" title="Add a page inside" aria-label={`Add a page inside ${p.title}`} onClick={() => add(p._id)} className={trailingAction}><PlusIcon /></button>
					</>}>
						<span className="truncate">{p.title}</span>
					</Item>
					{open && level(p._id, depth + 1)}
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
			{renaming && <RenamePage page={renaming} onClose={() => setRenaming(undefined)} />}
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

export function PageLevel({ parentId, render, empty }: { parentId?: PageId; render: (row: Row) => React.ReactNode; empty?: React.ReactNode }) {
	const { results, status, loadMore } = usePaginatedQuery(api.pages.children, { parentId }, { initialNumItems: 30 });
	return <>{status === "Exhausted" && !results.length && empty}{results.map(render)}<LoadMore status={status} onMore={() => loadMore(30)} /></>;
}

/** Browse a destination a level at a time, including top-level Pages. Server checks cycles. */
export function MovePage({ page, onClose }: { page: Row; onClose: () => void }) {
	const [trail, setTrail] = useState<Row[]>([]);
	const move = useMutation(api.pages.move);
	const { error, busy, run } = useRun();
	const parent = trail.at(-1);
	return (
		<Modal title={`Move ${page.title}`} onClose={onClose}>
			<Notice>{error}</Notice>
			<nav className="flex flex-wrap gap-2 text-sm text-neutral-500">
				<button type="button" onClick={() => setTrail([])}>Pages</button>
				{trail.map((p, i) => <button key={p._id} type="button" onClick={() => setTrail(trail.slice(0, i + 1))}>/ {p.title}</button>)}
			</nav>
			<div className="flex max-h-72 flex-col overflow-y-auto">
				<PageLevel parentId={parent?._id} render={(p) => p._id !== page._id && <Item key={p._id} icon={<PageIcon />} onClick={() => setTrail([...trail, p])}><span className="truncate">{p.title}</span><CaretRightIcon className="ml-auto" /></Item>} />
			</div>
			<div className="flex justify-end gap-2">
				<button type="button" onClick={onClose} className={secondaryButton}>Cancel</button>
				<button type="button" disabled={busy} onClick={() => run(move({ pageId: page._id, parentId: parent?._id }), onClose)} className={primaryButton}>Move to {parent?.title ?? "Pages"}</button>
			</div>
		</Modal>
	);
}
