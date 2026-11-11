import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import { formatFileSize, fileKind } from "@companybot/core/files";
import { useState } from "react";
import { FolderIcon, PageIcon, UploadIcon } from "../../icons";
import { navigate } from "../../router";
import { EmptyState, Notice, listClass, listRowButton, metadataClass, useRun } from "../../ui";
import { DriveRows, UploadRows, useDriveLevel } from "../pages/PageTree";
import { FileKindIcon } from "./FileIcon";
import { useDriveMoves } from "./move";
import type { DriveUpload } from "./upload";

// What's in a folder (or at Drive's top level), on its screen: its folders, pages and files in the order
// people put them. Drop files on it to upload them here. Drag a row onto a folder to move it in (a page
// onto a page too), or up and down to reorder, as in the sidebar's tree of the same levels.

/** `uploads`: this folder's uploads in flight. `onDrop`: files dropped here, when the person can edit it. */
export function DriveListing({ parentId, uploads, onDrop, onDismissUpload, empty }: {
	parentId?: Id<"pages">;
	uploads: DriveUpload[];
	onDrop?: (files: File[]) => void;
	onDismissUpload: (key: string) => void;
	empty: React.ReactNode;
}) {
	const { error, run } = useRun();
	const level = useDriveLevel(parentId, "folder", { group: "drive-listing", moves: useDriveMoves(run) });
	const [over, setOver] = useState(false);
	const dropProps = onDrop && {
		onDragOver: (e: React.DragEvent) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); setOver(true); } },
		onDragLeave: () => setOver(false),
		onDrop: (e: React.DragEvent) => { e.preventDefault(); setOver(false); const files = [...e.dataTransfer.files]; if (files.length) onDrop(files); },
	};
	return (
		// The whole area takes drops; with nothing here, the empty state alone fills it (no bare card around it).
		<div {...dropProps} className={`flex flex-1 flex-col gap-3 rounded-xl ${over ? "outline-2 outline-dashed outline-neutral-300 outline-offset-4" : ""}`}>
			<Notice>{error}</Notice>
			{level.empty && !uploads.length ? (
				empty
			) : (
				<>
					<div className={`${listClass} empty:hidden`}>
						<DriveRows
							level={level}
							renderPage={(p, drag) => (
								<button key={p._id} type="button" {...drag?.item} onClick={() => navigate("pages", p._id)} className={`${listRowButton} items-center ${drag?.item.className ?? ""} ${drag?.over ? "bg-neutral-200" : ""}`}>
									<span className="shrink-0 text-neutral-500">{p.kind === "folder" ? <FolderIcon /> : <PageIcon />}</span>
									<span className="min-w-0 flex-1 truncate">{p.title}</span>
									<span className={`shrink-0 ${metadataClass}`}>{p.kind === "folder" ? "Folder" : "Page"}</span>
								</button>
							)}
							renderFile={(f, drag) => (
								<button key={f._id} type="button" {...drag?.item} onClick={() => navigate("files", f._id)} className={`${listRowButton} items-center ${drag?.item.className ?? ""}`}>
									<span className="shrink-0 text-neutral-500"><FileKindIcon type={f.type} name={f.name} /></span>
									<span className="min-w-0 flex-1 truncate">{f.name}</span>
									<span className={`shrink-0 ${metadataClass}`}>{fileKind(f.type)} · {formatFileSize(f.size)}</span>
								</button>
							)}
						/>
						<UploadRows uploads={uploads} onDismiss={onDismissUpload} />
					</div>
					{onDrop && (
						<p className={`flex items-center justify-center gap-1.5 py-2 ${metadataClass}`}>
							<UploadIcon /> Drop files here to upload them.
						</p>
					)}
				</>
			)}
		</div>
	);
}

/** `root`: Drive's top level, whose + is beside its name in the sidebar; a folder has New in its top bar. */
export const DriveEmpty = ({ canEdit, root }: { canEdit: boolean; root?: boolean }) => (
	<EmptyState icon={<FolderIcon />} title={root ? "Nothing in Drive yet" : "Nothing here yet"}>
		{canEdit ? `${root ? "Press + beside Drive" : "Press New"} to write a page, make a folder or upload files. You can also drop files here.` : "Pages, folders and files put here will show up."}
	</EmptyState>
);
