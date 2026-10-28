import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import { useEffect, useState } from "react";
import { api } from "../api";
import { useMutation, useQuery } from "../convex";
import { navigate } from "../router";
import { HistoryIcon, PageIcon, TrashIcon } from "../icons";
import { NotFound, Notice, Page, barButton, barDangerButton, useRun } from "../ui";
import { MovePage } from "./pages/PageTree";
import { PageEditor } from "./pages/PageEditor";
import { PageHistory } from "./pages/PageHistory";
import { PageTitle } from "./pages/PageTitle";
import { TrashNotice } from "./Trash";

// Standalone pages (wiki, SOPs, meeting notes): /pages lists them, /pages/<id> opens one.
// Records' page bodies use the same editor on the record's page. See wiki/pages.md.

export { PagesNav } from "./pages/PageTree";

/** Pages are opened from the sidebar; /pages alone has nothing to show, so it goes to chat. */
export function PagesView({ pageId, canEdit }: { pageId?: string; canEdit: boolean }) {
	useEffect(() => {
		if (!pageId) navigate("chat");
	}, [pageId]);
	return pageId ? <PageScreen key={pageId} pageId={pageId as Id<"pages">} canEdit={canEdit} /> : null;
}

function PageScreen({ pageId, canEdit }: { pageId: Id<"pages">; canEdit: boolean }) {
	const page = useQuery(api.pages.get, { pageId });
	const rename = useMutation(api.pages.rename);
	const remove = useMutation(api.trash.move);
	const [history, setHistory] = useState(false);
	const [moving, setMoving] = useState(false);
	const { error, run } = useRun();
	const crumbs = (page?.ancestors ?? []).map((p) => ({ label: p.title, to: ["pages", p._id] }));
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
						<button type="button" onClick={() => run(remove({ kind: "page", id: pageId }), () => navigate(...(page.ancestors.length ? ["pages", page.ancestors.at(-1)!._id] : ["chat"])))} className={barDangerButton}>
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
