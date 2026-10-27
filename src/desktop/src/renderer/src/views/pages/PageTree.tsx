import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import { Fragment, useState } from "react";
import { api } from "../../api";
import { useMutation, usePaginatedQuery, useWorkspace } from "../../convex";
import { CaretRightIcon, MoreIcon, PageIcon, PlusIcon, TrashIcon } from "../../icons";
import { navigate } from "../../router";
import { LoadMore, Notice, primaryButton, secondaryButton, useRun } from "../../ui";
import { Group, Item, trailingAction } from "../chat/Sidebar";
import { MenuItem, Modal, Popover } from "../chat/common";

type PageId = Id<"pages">;
type Row = { _id: PageId; title: string; hasChildren?: boolean };

/** Each expanded level loads independently; no workspace-wide list or fixed tree-size cutoff. */
export function PagesNav({ openId }: { openId: string | undefined }) {
	const workspace = useWorkspace();
	return <PageNavTree key={workspace?.id} openId={openId} storageKey={`pages-expanded:${workspace?.id}`} />;
}
function PageNavTree({ openId, storageKey }: { openId?: string; storageKey: string }) {
	const [expanded, setExpanded] = useState<Set<string>>(() => {
		try { return new Set(JSON.parse(localStorage.getItem(storageKey) ?? "[]")); } catch { return new Set(); }
	});
	const [moving, setMoving] = useState<Row>();
	const create = useMutation(api.pages.create);
	const remove = useMutation(api.trash.move);
	const { error, run } = useRun();
	const toggle = (id: string, open = !expanded.has(id)) => {
		setExpanded((before) => {
			const next = new Set(before);
			if (open) next.add(id); else next.delete(id);
			try { localStorage.setItem(storageKey, JSON.stringify([...next])); } catch { /* Storage may be unavailable. */ }
			return next;
		});
	};
	const add = (parentId?: PageId) => run(create({ title: "Untitled", parentId }).then((id) => { if (parentId) toggle(parentId, true); navigate("pages", id); }));
	const level = (parentId?: PageId, depth = 0): React.ReactNode => (
		<PageLevel parentId={parentId} render={(p) => {
			const open = p.hasChildren && expanded.has(p._id);
			const chevron = <button type="button" aria-label={`${open ? "Collapse" : "Expand"} ${p.title}`} aria-expanded={open} onClick={() => toggle(p._id)} className="relative z-10 hidden size-5 items-center justify-center text-neutral-400 hover:text-neutral-800 group-hover/item:flex"><CaretRightIcon className={open ? "rotate-90" : ""} /></button>;
			return (
				<Fragment key={p._id}>
					<Item icon={p.hasChildren ? <><PageIcon className="group-hover/item:hidden" />{chevron}</> : <PageIcon />} indent={depth} active={p._id === openId} onClick={() => navigate("pages", p._id)} actions={<>
						<Popover trigger={<MoreIcon />} label={`Page actions for ${p.title}`} className={trailingAction} panelClassName="w-44 p-1">
							{(close) => <><MenuItem onClick={() => { close(); setMoving(p); }}>Move to…</MenuItem><MenuItem danger onClick={() => { close(); run(remove({ kind: "page", id: p._id })); }}><TrashIcon /> Delete</MenuItem></>}
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
		<Group title="Pages" onTitle={() => navigate("pages")} onAdd={() => add()} addLabel="New page">
			{level()}
			<Item icon={<PlusIcon />} onClick={() => add()} muted>New page</Item>
			{error && <Notice>{error}</Notice>}
			{moving && <MovePage page={moving} onClose={() => setMoving(undefined)} />}
		</Group>
	);
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
			{error && <Notice>{error}</Notice>}
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
