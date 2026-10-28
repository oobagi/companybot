import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import { useState } from "react";
import { api } from "../api";
import { useMutation, usePaginatedQuery, useQuery } from "../convex";
import { navigate } from "../router";
import { HistoryIcon, PageIcon, TrashIcon } from "../icons";
import { EmptyState, LoadMore, Loading, NewButton, NotFound, Notice, Page, barButton, barDangerButton, listClass, metadataClass, timeAgo, useRun } from "../ui";
import { MovePage } from "./pages/PageTree";
import { PageEditor } from "./pages/PageEditor";
import { PageHistory } from "./pages/PageHistory";
import { PageTitle } from "./pages/PageTitle";
import { TrashNotice } from "./Trash";

// Standalone pages (wiki, SOPs, meeting notes): /pages lists them, /pages/<id> opens one.
// Records' page bodies use the same editor on the record's page. See wiki/pages.md.

export { PagesNav } from "./pages/PageTree";

export function PagesView({ pageId, canEdit }: { pageId?: string; canEdit: boolean }) {
	return pageId ? <PageScreen key={pageId} pageId={pageId as Id<"pages">} canEdit={canEdit} /> : <PagesIndex canEdit={canEdit} />;
}

/** Every page. Deleted ones are in Trash. */
function PagesIndex({ canEdit }: { canEdit: boolean }) {
	const { results: pages, status, loadMore } = usePaginatedQuery(api.pages.children, {}, { initialNumItems: 30 });
	const create = useMutation(api.pages.create);
	const { error, run } = useRun();
	const actions = canEdit && <NewButton label="New page" onClick={() => run(create({ title: "Untitled" }).then((id) => navigate("pages", id)))} />;
	return (
		<Page title="Pages" description="Wiki pages, how-tos and meeting notes. Every record has a page too." actions={actions}>
			<Notice>{error}</Notice>
			{status === "LoadingFirstPage" ? (
				<Loading />
			) : pages.length > 0 ? (
				<div className={listClass}>
					{pages.map((p) => (
						<button key={p._id} type="button" onClick={() => navigate("pages", p._id)} className="flex items-baseline gap-3 px-4 py-2 text-left text-sm hover:bg-neutral-50">
							<PageIcon className="shrink-0 self-center text-neutral-400" />
							<span className="font-medium">{p.title}</span>
							<span className={`ml-auto ${metadataClass}`}>{timeAgo(p.updatedAt)}</span>
						</button>
					))}
				</div>
			) : (
				<EmptyState icon={<PageIcon />} title="No pages yet">Write down how your team works.</EmptyState>
			)}
			<LoadMore status={status} onMore={() => loadMore(30)} />
		</Page>
	);
}

function PageScreen({ pageId, canEdit }: { pageId: Id<"pages">; canEdit: boolean }) {
	const page = useQuery(api.pages.get, { pageId });
	const rename = useMutation(api.pages.rename);
	const remove = useMutation(api.trash.move);
	const [history, setHistory] = useState(false);
	const [moving, setMoving] = useState(false);
	const { error, run } = useRun();
	const crumbs = [{ label: "Pages", to: ["pages"] }, ...(page?.ancestors ?? []).map((p) => ({ label: p.title, to: ["pages", p._id] }))];
	if (!page) return <NotFound crumbs={crumbs} loaded={page === null} icon={<PageIcon />} title="Page not found" />;
	return (
		<Page
			title={page.title}
			crumbs={crumbs}
			heading={<PageTitle title={page.title} editable={page.canEdit} onSave={(title) => rename({ pageId, title })} />}
			actions={
				<>
					<button type="button" onClick={() => setHistory(true)} className={barButton}>
						<HistoryIcon /> History
					</button>
					{page.canEdit && <button type="button" onClick={() => setMoving(true)} className={barButton}>Move to…</button>}
					{canEdit && !page.archived && (
						<button type="button" onClick={() => run(remove({ kind: "page", id: pageId }), () => navigate("pages"))} className={barDangerButton}>
							<TrashIcon /> Delete
						</button>
					)}
				</>
			}
		>
			<Notice>{error}</Notice>
			{page.trash && <TrashNotice trash={page.trash} />}
			<PageEditor pageId={pageId} editable={page.canEdit} standalone={!page.recordId} />
			{moving && <MovePage page={page} onClose={() => setMoving(false)} />}
			{history && <PageHistory pageId={pageId} canRestore={page.canEdit} onClose={() => setHistory(false)} />}
		</Page>
	);
}
