import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import { useState } from "react";
import { api } from "../api";
import { useMutation, useQuery } from "../convex";
import { navigate } from "../router";
import { HistoryIcon, PageIcon, PlusIcon, TrashIcon } from "../icons";
import { Loading, NotFound, Notice, Page, barButton, barDangerButton, barPrimaryButton, descriptionClass, metadataClass, timeAgo, useRun } from "../ui";
import { Group, Item } from "./chat/Sidebar";
import { PageEditor } from "./pages/PageEditor";
import { PageHistory } from "./pages/PageHistory";
import { PageTitle } from "./pages/PageTitle";
import { TrashNotice } from "./Trash";

// Standalone pages (wiki, SOPs, meeting notes): /pages lists them, /pages/<id> opens one.
// Records' page bodies use the same editor on the record's page. See wiki/pages.md.

/** The sidebar's Pages section: every live page, and + to start one. */
export function PagesNav({ openId }: { openId: string | undefined }) {
	const pages = useQuery(api.pages.list, {});
	const create = useMutation(api.pages.create);
	const { error, run } = useRun();
	const newPage = () => run(create({ title: "Untitled" }).then((id) => navigate("pages", id)));
	return (
		<Group title="Pages" onTitle={() => navigate("pages")} onAdd={() => void newPage()} addLabel="New page">
			{pages?.map((p) => (
				<Item key={p._id} icon={<PageIcon />} active={p._id === openId} onClick={() => navigate("pages", p._id)}>
					<span className="truncate">{p.title}</span>
				</Item>
			))}
			<Item icon={<PlusIcon />} onClick={() => void newPage()} muted>New page</Item>
			{error && <Notice>{error}</Notice>}
		</Group>
	);
}

export function PagesView({ pageId, canEdit }: { pageId?: string; canEdit: boolean }) {
	return pageId ? <PageScreen key={pageId} pageId={pageId as Id<"pages">} canEdit={canEdit} /> : <PagesIndex canEdit={canEdit} />;
}

/** Every page. Deleted ones are in Trash. */
function PagesIndex({ canEdit }: { canEdit: boolean }) {
	const pages = useQuery(api.pages.list, {});
	const create = useMutation(api.pages.create);
	const { error, run } = useRun();
	const actions = canEdit && (
		<button type="button" onClick={() => run(create({ title: "Untitled" }).then((id) => navigate("pages", id)))} className={barPrimaryButton}>
			<PlusIcon /> New page
		</button>
	);
	return (
		<Page title="Pages" subtitle="Wiki pages, how-tos and meeting notes. Every record has a page too." actions={actions}>
			{error && <Notice>{error}</Notice>}
			{!pages ? (
				<Loading />
			) : pages.length > 0 ? (
				<div className="flex flex-col divide-y divide-neutral-100 rounded-xl border border-neutral-200">
					{pages.map((p) => (
						<button key={p._id} type="button" onClick={() => navigate("pages", p._id)} className="flex items-baseline gap-3 px-4 py-2 text-left text-sm hover:bg-neutral-50">
							<PageIcon className="shrink-0 self-center text-neutral-400" />
							<span className="font-medium">{p.title}</span>
							<span className={`ml-auto ${metadataClass}`}>{timeAgo(p.updatedAt)}</span>
						</button>
					))}
				</div>
			) : (
				<p className={descriptionClass}>No pages yet.</p>
			)}
		</Page>
	);
}

function PageScreen({ pageId, canEdit }: { pageId: Id<"pages">; canEdit: boolean }) {
	const page = useQuery(api.pages.get, { pageId });
	const rename = useMutation(api.pages.rename);
	const remove = useMutation(api.trash.move);
	const [history, setHistory] = useState(false);
	const { error, run } = useRun();
	const crumbs = [{ label: "Pages", to: ["pages"] }];
	if (!page) return <NotFound crumbs={crumbs} loaded={page === null}>This page was deleted, or isn't in this workspace.</NotFound>;
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
					{canEdit && !page.archived && (
						<button type="button" onClick={() => run(remove({ kind: "page", id: pageId }), () => navigate("pages"))} className={barDangerButton}>
							<TrashIcon /> Delete
						</button>
					)}
				</>
			}
		>
			{error && <Notice>{error}</Notice>}
			{page.trash && <TrashNotice trash={page.trash} />}
			<PageEditor pageId={pageId} editable={page.canEdit} />
			{history && <PageHistory pageId={pageId} canRestore={page.canEdit} onClose={() => setHistory(false)} />}
		</Page>
	);
}
