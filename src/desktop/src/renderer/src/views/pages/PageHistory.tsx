import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import { useState } from "react";
import { api } from "../../api";
import { useMutation, usePaginatedQuery, useQuery } from "../../convex";
import { LoadMore, Loading, Notice, descriptionClass, metadataClass, primaryButton, useRun } from "../../ui";
import { Modal, clock, dayLabel } from "../chat/common";
import { whoLabel } from "../records/logic";
import { VersionPreview } from "./PageEditor";

// A page's versions, like Notion's: one per run of edits, crediting everyone who edited in it.
// Pick one to see it; restoring it saves it as the newest version, so nothing is lost.

const when = (ms: number) => `${dayLabel(ms)}, ${clock(ms)}`;

export function PageHistory({ pageId, canRestore, onClose, tabs }: { pageId: Id<"pages">; canRestore: boolean; onClose: () => void; tabs?: React.ReactNode }) {
	const { results, status, loadMore } = usePaginatedQuery(api.pages.history, { pageId }, { initialNumItems: 20 });
	const [picked, setPicked] = useState<Id<"pageVersions">>();
	const restore = useMutation(api.pages.restore);
	const { error, run } = useRun();
	const shown = picked ?? results[0]?._id;
	return (
		<Modal title="History" wide onClose={onClose}>
			{tabs}
			{error && <Notice>{error}</Notice>}
			{status === "LoadingFirstPage" ? (
				<Loading />
			) : results.length === 0 ? (
				<p className={descriptionClass}>No edits yet.</p>
			) : (
				<div className="flex min-h-0 gap-6">
					<div className="min-w-0 flex-1 overflow-y-auto">{shown && <Preview versionId={shown} />}</div>
					<div className="flex w-64 shrink-0 flex-col gap-1 overflow-y-auto">
						{results.map((v, i) => (
							<button
								key={v._id}
								type="button"
								onClick={() => setPicked(v._id)}
								className={`flex flex-col rounded-lg px-3 py-2 text-left text-sm ${v._id === shown ? "bg-neutral-100" : "hover:bg-neutral-50"}`}
							>
								<span className="font-medium">{when(v.time)}</span>
								<span className="text-neutral-600">
									{v.restored ? "Restored" : "Edited"} by {[v, ...v.others].map(whoLabel).join(", ")}
								</span>
								{v.restored && <span className={metadataClass}>the version from {when(v.restored)}</span>}
								{i === 0 && <span className={metadataClass}>Current</span>}
							</button>
						))}
						<LoadMore status={status} onMore={() => loadMore(20)} />
					</div>
				</div>
			)}
			{canRestore && shown && shown !== results[0]?._id && (
				<button type="button" onClick={() => run(restore({ versionId: shown }), onClose)} className={`${primaryButton} self-end`}>
					Restore this version
				</button>
			)}
		</Modal>
	);
}

function Preview({ versionId }: { versionId: Id<"pageVersions"> }) {
	const content = useQuery(api.pages.version, { versionId });
	if (content === undefined) return <Loading />;
	if (content === null) return <p className={descriptionClass}>This version is no longer available.</p>;
	return <VersionPreview key={versionId} content={content} />;
}
