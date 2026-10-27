import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import { useState } from "react";
import { api } from "../api";
import { useMutation, useQuery } from "../convex";
import { navigate } from "../router";
import { Loading, Notice, Page, descriptionClass, metadataClass, timeAgo, useRun } from "../ui";
import { Group, Item } from "./chat/Sidebar";
import { PageEditor } from "./pages/PageEditor";
import { PageHistory } from "./pages/PageHistory";
import { PageTitle } from "./pages/PageTitle";

// Standalone pages (wiki, SOPs, meeting notes): /pages lists them, /pages/<id> opens one.
// Records' page bodies use the same editor on the record's page. See wiki/pages.md.

/** The sidebar's Pages section: every live page, and + to start one. */
export function PagesNav({ openId }: { openId: string | undefined }) {
	const pages = useQuery(api.pages.list, {});
	const create = useMutation(api.pages.create);
	const { error, run } = useRun();
	const newPage = () => run(create({ title: "Untitled" }).then((id) => navigate("pages", id)));
	return (
		<Group title="Pages" onTitle={() => navigate("pages")}>
			{pages?.map((p) => (
				<Item key={p._id} active={p._id === openId} onClick={() => navigate("pages", p._id)}>
					<span className="truncate">{p.title}</span>
				</Item>
			))}
			<Item onClick={() => void newPage()} muted>+ New page</Item>
			{error && <Notice>{error}</Notice>}
		</Group>
	);
}

export function PagesView({ pageId, canEdit }: { pageId?: string; canEdit: boolean }) {
	return pageId ? <PageScreen key={pageId} pageId={pageId as Id<"pages">} canEdit={canEdit} /> : <PagesIndex />;
}

/** Every page, live then archived. */
function PagesIndex() {
	const live = useQuery(api.pages.list, {});
	const archived = useQuery(api.pages.list, { archived: true });
	if (!live || !archived) return <Loading />;
	const rows = (pages: typeof live) => (
		<div className="flex flex-col divide-y divide-neutral-100 rounded-xl border border-neutral-200">
			{pages.map((p) => (
				<button key={p._id} type="button" onClick={() => navigate("pages", p._id)} className="flex items-baseline gap-3 px-4 py-2 text-left text-sm hover:bg-neutral-50">
					<span className="font-medium">{p.title}</span>
					<span className={`ml-auto ${metadataClass}`}>{timeAgo(p.updatedAt)}</span>
				</button>
			))}
		</div>
	);
	return (
		<Page title="Pages" subtitle="Wiki pages, how-tos and meeting notes. Every record has a page too.">
			{live.length > 0 ? rows(live) : <p className={descriptionClass}>No pages yet. Start one with + next to Pages.</p>}
			{archived.length > 0 && (
				<>
					<h2 className="font-medium">Archived</h2>
					{rows(archived)}
				</>
			)}
		</Page>
	);
}

function PageScreen({ pageId, canEdit }: { pageId: Id<"pages">; canEdit: boolean }) {
	const page = useQuery(api.pages.get, { pageId });
	const setArchived = useMutation(api.pages.setArchived);
	const rename = useMutation(api.pages.rename);
	const remove = useMutation(api.pages.remove);
	const [history, setHistory] = useState(false);
	const { error, run } = useRun();
	const back = { label: "Pages", to: ["pages"] };
	if (page === undefined) return <Page title="" back={back}><Loading /></Page>;
	if (page === null) {
		return (
			<Page title="Not found" back={back}>
				<p className={descriptionClass}>This page was deleted, or isn't in this workspace.</p>
			</Page>
		);
	}
	const action = `${descriptionClass} hover:text-neutral-900`;
	return (
		<Page
			title={<PageTitle title={page.title} editable={page.canEdit} onSave={(title) => rename({ pageId, title })} />}
			subtitle={page.archived ? "Archived" : undefined}
			back={back}
			actions={
				<div className="flex shrink-0 gap-4">
					<button type="button" onClick={() => setHistory(true)} className={action}>
						History
					</button>
					{canEdit && (
						<button type="button" onClick={() => run(setArchived({ pageId, archived: !page.archived }))} className={action}>
							{page.archived ? "Restore" : "Archive"}
						</button>
					)}
					{canEdit && page.archived && (
						<button type="button" onClick={() => confirm(`Delete “${page.title}”? The page and its history will be deleted for good.`) && run(remove({ pageId }), () => navigate("pages"))} className={`${descriptionClass} hover:text-red-600`}>
							Delete
						</button>
					)}
				</div>
			}
		>
			{error && <Notice>{error}</Notice>}
			<PageEditor pageId={pageId} editable={page.canEdit} />
			{history && <PageHistory pageId={pageId} canRestore={page.canEdit} onClose={() => setHistory(false)} />}
		</Page>
	);
}
