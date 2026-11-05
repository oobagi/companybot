import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import { useState } from "react";
import { api } from "../api";
import { useMutation, useQuery } from "../convex";
import { navigate } from "../router";
import { ArchiveIcon, DriveIcon, HistoryIcon, PageIcon, PrivateIcon } from "../icons";
import { EmptyState, NotFound, Notice, Page, barButton, useRun } from "../ui";
import { MovePage, PageAccess } from "./pages/PageTree";
import { PageEditor } from "./pages/PageEditor";
import { PageHistory } from "./pages/PageHistory";
import { PageTitle } from "./pages/PageTitle";
import { archiveQuestion, useConfirm } from "./chat/common";
import { TrashNotice } from "./Trash";

// Standalone pages (wiki, SOPs, meeting notes), in Drive: its sidebar lists them, /pages/<id> opens one.
// Records' page bodies use the same editor on the record's page. See wiki/pages.md.

export { PagesNav } from "./pages/PageTree";

/** Pages are opened from Drive's sidebar; /pages alone (Drive with none open) says so. */
export function PagesView({ pageId }: { pageId?: string }) {
	if (!pageId)
		return (
			// No title: the sidebar beside it already says Drive, as Chat with nothing open.
			<Page title="">
				<EmptyState icon={<DriveIcon />} title="No page open">
					Open a page from the sidebar, or press + beside Drive to write one.
				</EmptyState>
			</Page>
		);
	return <PageScreen key={pageId} pageId={pageId as Id<"pages">} />;
}

function PageScreen({ pageId }: { pageId: Id<"pages"> }) {
	const page = useQuery(api.pages.get, { pageId });
	const rename = useMutation(api.pages.rename);
	const remove = useMutation(api.trash.move);
	const [history, setHistory] = useState(false);
	const [moving, setMoving] = useState(false);
	const [sharing, setSharing] = useState(false);
	const [focusBody, setFocusBody] = useState(0);
	const { error } = useRun();
	const { confirm, dialog } = useConfirm();
	const crumbs = (page?.ancestors ?? []).map((p) => ({ label: p.title, to: ["pages", p._id] }));
	if (!page) return <NotFound crumbs={crumbs} loaded={page === null} icon={<PageIcon />} title="Page not found" />;
	return (
		<Page
			title={page.title}
			crumbs={crumbs}
			heading={<PageTitle title={page.title} editable={page.canEdit} onSave={(title) => rename({ pageId, title })} onEnter={() => setFocusBody((n) => n + 1)} />}
			actions={
				<>
					<button type="button" onClick={() => setHistory(true)} className={barButton}>
						<HistoryIcon /> History
					</button>
					{page.canEdit && <button type="button" onClick={() => setMoving(true)} className={barButton}>Move to…</button>}
					{!page.recordId && (
						<button type="button" onClick={() => setSharing(true)} title={page.lock ? (page.lock.edit ? `Only ${page.lock.who} can edit it` : `Only ${page.lock.who} can see it`) : "Everyone can access it"} className={barButton}>
							{page.restricted && <PrivateIcon />} Who can access
						</button>
					)}
					{page.canEdit && !page.archived && (
						<button type="button" onClick={() => confirm(archiveQuestion(page.title, () => remove({ kind: "page", id: pageId }).then(() => navigate(...(page.ancestors.length ? ["pages", page.ancestors.at(-1)!._id] : ["pages"]))), "Its sub-pages will be archived with it."))} className={barButton}>
							<ArchiveIcon /> Archive
						</button>
					)}
				</>
			}
		>
			{dialog}
			<Notice>{error}</Notice>
			{page.trash && <TrashNotice trash={page.trash} />}
			{page.archived && !page.trash && <Notice>It's in Archive with a page you can't see.</Notice>}
			<PageEditor pageId={pageId} editable={page.canEdit} standalone={!page.recordId} focusKey={focusBody} />
			{sharing && <PageAccess pageId={pageId} onClose={() => setSharing(false)} />}
			{moving && <MovePage page={page} onClose={() => setMoving(false)} />}
			{history && <PageHistory pageId={pageId} canRestore={page.canEdit} onClose={() => setHistory(false)} />}
		</Page>
	);
}
