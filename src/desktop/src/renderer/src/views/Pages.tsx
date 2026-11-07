import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import { useEffect, useState } from "react";
import { api } from "../api";
import { useMutation, useQuery } from "../convex";
import { navigate } from "../router";
import { ArchiveIcon, DriveIcon, HistoryIcon, MembersIcon, MoveIcon, PageIcon, PrivateIcon } from "../icons";
import { type Crumb, EmptyState, Loading, NotFound, Notice, Page, barButton, useRun } from "../ui";
import { MovePage, PageAccess } from "./pages/PageTree";
import { PageEditor } from "./pages/PageEditor";
import { PageHistory } from "./pages/PageHistory";
import { PageTitle } from "./pages/PageTitle";
import { archiveQuestion, useConfirm } from "./chat/common";
import { recordPath } from "./records/logic";
import { TrashNotice } from "./Trash";

// Every page has one screen, Notion's way: a page in Drive, and a record's page, which is the same screen
// with the record's properties above its body (RecordPage). See wiki/pages.md.

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

/**
 * The page screen, Drive's and every record's: the title (Enter goes on into the body), what sits above the
 * body (a record's properties), then the body. `body`: undefined while it loads, null for a record nobody
 * has written in that you can't edit.
 */
export function PageView({ title, crumbs, editableTitle, onRename, actions, notices, above, body, children }: {
	title: string;
	crumbs: Crumb[];
	editableTitle: boolean;
	onRename: (title: string) => Promise<unknown>;
	actions: React.ReactNode;
	notices?: React.ReactNode;
	above?: React.ReactNode;
	body: { pageId: Id<"pages">; editable: boolean } | null | undefined;
	/** Dialogs. */
	children?: React.ReactNode;
}) {
	const [focusBody, setFocusBody] = useState(0);
	return (
		<Page
			title={title}
			crumbs={crumbs}
			heading={<PageTitle title={title} editable={editableTitle} onSave={onRename} onEnter={() => setFocusBody((n) => n + 1)} />}
			actions={actions}
		>
			{notices}
			{above}
			{body === undefined ? <Loading /> : body && <PageEditor pageId={body.pageId} editable={body.editable} focusKey={focusBody} />}
			{children}
		</Page>
	);
}

function PageScreen({ pageId }: { pageId: Id<"pages"> }) {
	const page = useQuery(api.pages.get, { pageId });
	const rename = useMutation(api.pages.rename);
	const remove = useMutation(api.trash.move);
	const [history, setHistory] = useState(false);
	const [moving, setMoving] = useState(false);
	const [sharing, setSharing] = useState(false);
	const { error } = useRun();
	const { confirm, dialog } = useConfirm();
	// A record's own page opens as its record.
	const record = page?.record;
	const own = !!page?.recordId && record;
	useEffect(() => {
		if (own) navigate(...recordPath(own.typeKey, own._id));
	}, [own]);
	// Inside a record's page: Database › Record › the pages between.
	const crumbs = [
		...(record ? [{ label: record.plural, to: recordPath(record.typeKey) }, { label: record.title, to: recordPath(record.typeKey, record._id) }] : []),
		...(page?.ancestors ?? []).map((p) => ({ label: p.title, to: ["pages", p._id] })),
	];
	if (!page) return <NotFound crumbs={crumbs} loaded={page === null} icon={<PageIcon />} title="Page not found" />;
	if (own) return null;
	// Archiving opens where it was: the page above, else its record, else Drive.
	const up = page.ancestors.length ? ["pages", page.ancestors.at(-1)!._id] : record ? recordPath(record.typeKey, record._id) : ["pages"];
	return (
		<PageView
			title={page.title}
			crumbs={crumbs}
			editableTitle={page.canEdit}
			onRename={(title) => rename({ pageId, title })}
			actions={
				<>
					<button type="button" onClick={() => setHistory(true)} className={barButton}>
						<HistoryIcon /> History
					</button>
					{page.canEdit && <button type="button" onClick={() => setMoving(true)} className={barButton}><MoveIcon /> Move to…</button>}
					<button type="button" onClick={() => setSharing(true)} title={page.lock ? (page.lock.edit ? `Only ${page.lock.who} can edit it` : `Only ${page.lock.who} can see it`) : "Everyone can access it"} className={barButton}>
						{page.restricted ? <PrivateIcon /> : <MembersIcon />} Who can access
					</button>
					{page.canEdit && !page.archived && (
						<button type="button" onClick={() => confirm(archiveQuestion(page.title, () => remove({ kind: "page", id: pageId }).then(() => navigate(...up)), "Its sub-pages will be archived with it."))} className={barButton}>
							<ArchiveIcon /> Archive
						</button>
					)}
				</>
			}
			notices={
				<>
					{dialog}
					<Notice>{error}</Notice>
					{page.trash && <TrashNotice trash={page.trash} />}
					{page.archived && !page.trash && <Notice>It's in Archive with a page you can't see.</Notice>}
				</>
			}
			body={{ pageId, editable: page.canEdit }}
		>
			{sharing && <PageAccess pageId={pageId} onClose={() => setSharing(false)} />}
			{moving && <MovePage page={page} onClose={() => setMoving(false)} />}
			{history && <PageHistory pageId={pageId} canRestore={page.canEdit} onClose={() => setHistory(false)} />}
		</PageView>
	);
}
