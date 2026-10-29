import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import { DOCX, FILES_PER_MESSAGE, XLSX, fileKind, formatFileSize, isImageType } from "@companybot/core/files";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useMutation } from "../../convex";
import { AttachIcon, CloseIcon, FileCsvIcon, FileDocIcon, FileIcon, FilePdfIcon, FileXlsIcon, PageIcon } from "../../icons";
import { useFileUpload } from "../../upload";
import { api } from "../../api";
import { useDismiss } from "./common";
import type { Message } from "./data";

// Files on messages: the composer's pending uploads (attach button, drop, paste), and the files
// a message shows (thumbnails that open larger, chips that open the file). Uploads go to the
// backend as they're added (files.ts); sending claims them.

type Pending = { key: string; name: string; size: number; preview?: string; progress: number; file?: Id<"_storage">; error?: string };

export type Attachments = ReturnType<typeof useAttachments>;

/** A composer's files: added, uploading, uploaded or failed. `ids` are the uploaded ones, to send. */
export function useAttachments() {
	const upload = useFileUpload();
	const discard = useMutation(api.files.discard);
	const [items, setItems] = useState<Pending[]>([]);
	const [notice, setNotice] = useState<string>();
	// Read by uploads finishing after their item was removed, and by cleanup on unmount.
	const current = useRef(items);
	current.current = items;
	const update = (key: string, patch: Partial<Pending>) => setItems((list) => list.map((i) => (i.key === key ? { ...i, ...patch } : i)));
	useEffect(() => () => current.current.forEach((i) => i.preview && URL.revokeObjectURL(i.preview)), []);

	const add = (files: File[]) => {
		const room = FILES_PER_MESSAGE - current.current.length;
		setNotice(files.length > room ? `Attach up to ${FILES_PER_MESSAGE} files to a message.` : undefined);
		for (const file of files.slice(0, Math.max(0, room))) {
			const key = crypto.randomUUID();
			const preview = isImageType(file.type) ? URL.createObjectURL(file) : undefined;
			current.current = [...current.current, { key, name: file.name, size: file.size, preview, progress: 0 }];
			setItems(current.current);
			upload(file, (progress) => update(key, { progress })).then(
				(id) => {
					if (current.current.some((i) => i.key === key)) update(key, { file: id, progress: 1 });
					else discard({ file: id }).catch(() => {});
				},
				(e: unknown) => update(key, { error: e instanceof Error ? e.message : String(e) }),
			);
		}
	};
	const remove = (key: string) => {
		const item = current.current.find((i) => i.key === key);
		if (item?.file) discard({ file: item.file }).catch(() => {});
		if (item?.preview) URL.revokeObjectURL(item.preview);
		setNotice(undefined);
		setItems((list) => list.filter((i) => i.key !== key));
	};
	/** After sending: the message has the files now. */
	const clear = () => {
		current.current.forEach((i) => i.preview && URL.revokeObjectURL(i.preview));
		setNotice(undefined);
		setItems([]);
	};
	return {
		items,
		notice,
		add,
		remove,
		clear,
		ids: items.flatMap((i) => (i.file ? [i.file] : [])),
		uploading: items.some((i) => !i.file && !i.error),
	};
}

/** The paperclip in the composer: picks files to attach. */
export function AttachButton({ attachments }: { attachments: Attachments }) {
	const input = useRef<HTMLInputElement>(null);
	return (
		<>
			<button
				type="button"
				onClick={() => input.current?.click()}
				title="Attach files"
				aria-label="Attach files"
				className="flex size-8 shrink-0 items-center justify-center rounded-full text-lg text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900"
			>
				<AttachIcon />
			</button>
			<input
				ref={input}
				type="file"
				multiple
				hidden
				onChange={(e) => {
					attachments.add([...(e.target.files ?? [])]);
					e.target.value = "";
				}}
			/>
		</>
	);
}

/** The composer's files, above what you type: a picture or icon, name, progress or error, and remove. */
export function PendingFiles({ attachments }: { attachments: Attachments }) {
	if (attachments.items.length === 0 && !attachments.notice) return null;
	return (
		<div className="flex basis-full flex-col gap-1.5 pb-1">
			{attachments.items.length > 0 && (
				<ul className="flex flex-wrap gap-2">
					{attachments.items.map((item) => (
						<li key={item.key} className={`relative flex h-12 max-w-60 items-center gap-2 rounded-lg border bg-white pr-7 pl-1.5 ${item.error ? "border-red-200" : "border-neutral-200"}`}>
							{item.preview ? <img src={item.preview} alt="" className="size-9 shrink-0 rounded object-cover" /> : <KindIcon name={item.name} />}
							<span className="flex min-w-0 flex-col">
								<span className="truncate text-sm">{item.name}</span>
								{item.error ? (
									<span className="truncate text-xs text-red-600" title={item.error}>{item.error}</span>
								) : item.file ? (
									<span className="text-xs text-neutral-400">{formatFileSize(item.size)}</span>
								) : (
									<span className="mt-1 h-1 w-24 overflow-hidden rounded-full bg-neutral-100" role="progressbar" aria-valuenow={Math.round(item.progress * 100)}>
										<span className="block h-full bg-neutral-900 transition-[width]" style={{ width: `${item.progress * 100}%` }} />
									</span>
								)}
							</span>
							<button
								type="button"
								onClick={() => attachments.remove(item.key)}
								title="Remove"
								aria-label={`Remove ${item.name}`}
								className="absolute top-1 right-1 flex size-5 items-center justify-center rounded-full text-xs text-neutral-400 hover:bg-neutral-100 hover:text-neutral-900"
							>
								<CloseIcon />
							</button>
						</li>
					))}
				</ul>
			)}
			{attachments.notice && <p className="text-xs text-red-600">{attachments.notice}</p>}
		</div>
	);
}

/** Wraps a chat or thread: files dropped anywhere on it are attached. */
export function FileDrop({ attachments, className, children }: { attachments?: Attachments; className: string; children: ReactNode }) {
	const [over, setOver] = useState(false);
	// dragenter and dragleave fire for every child crossed, so count them.
	const depth = useRef(0);
	const hasFiles = (e: React.DragEvent) => e.dataTransfer.types.includes("Files");
	if (!attachments) return <div className={className}>{children}</div>;
	return (
		<div
			className={`relative ${className}`}
			onDragEnter={(e) => {
				if (!hasFiles(e)) return;
				depth.current++;
				setOver(true);
			}}
			onDragOver={(e) => hasFiles(e) && e.preventDefault()}
			onDragLeave={(e) => {
				if (hasFiles(e) && --depth.current <= 0) setOver(false);
			}}
			onDrop={(e) => {
				if (!hasFiles(e)) return;
				e.preventDefault();
				depth.current = 0;
				setOver(false);
				attachments.add([...e.dataTransfer.files]);
			}}
		>
			{children}
			{over && (
				<div className="pointer-events-none absolute inset-2 z-30 flex items-center justify-center rounded-2xl border-2 border-dashed border-neutral-300 bg-white/80 text-sm text-neutral-600">
					Drop files to attach them
				</div>
			)}
		</div>
	);
}

/** An icon for a file's kind, by its type or (pending, untyped) its name. */
function KindIcon({ type, name }: { type?: string; name: string }) {
	const ext = name.toLowerCase().split(".").pop();
	const icon =
		type === "application/pdf" || ext === "pdf" ? <FilePdfIcon /> :
		type === DOCX || ext === "docx" ? <FileDocIcon /> :
		type === XLSX || ext === "xlsx" ? <FileXlsIcon /> :
		type === "text/csv" || ext === "csv" ? <FileCsvIcon /> :
		type?.startsWith("text/") || ext === "txt" || ext === "md" ? <PageIcon /> :
		<FileIcon />;
	return <span className="flex size-9 shrink-0 items-center justify-center rounded bg-neutral-100 text-xl text-neutral-500">{icon}</span>;
}

/** A message's files: pictures as thumbnails that open larger, the rest as chips that open the file. */
export function MessageFiles({ files }: { files: Message["attachments"] }) {
	const [open, setOpen] = useState<Message["attachments"][number]>();
	const pictures = files.filter((f) => isImageType(f.type) && f.url);
	const others = files.filter((f) => !pictures.includes(f));
	return (
		<div className="flex flex-col gap-1.5 pt-0.5">
			{pictures.length > 0 && (
				<div className="flex flex-wrap gap-2">
					{pictures.map((f, i) => (
						<button type="button" key={i} onClick={() => setOpen(f)} title={f.name} className="overflow-hidden rounded-lg border border-neutral-200 hover:border-neutral-300">
							<img src={f.url!} alt={f.name} loading="lazy" className="max-h-60 max-w-xs object-contain" />
						</button>
					))}
				</div>
			)}
			{others.length > 0 && (
				<div className="flex flex-wrap gap-2">
					{others.map((f, i) => (
						<a
							key={i}
							href={f.url ?? undefined}
							target="_blank"
							rel="noreferrer"
							title={f.url ? `Open ${f.name}` : "This file is gone."}
							className="flex h-12 max-w-72 items-center gap-2 rounded-lg border border-neutral-200 bg-white pr-3 pl-1.5 hover:border-neutral-300 hover:bg-neutral-50"
						>
							<KindIcon type={f.type} name={f.name} />
							<span className="flex min-w-0 flex-col">
								<span className="truncate text-sm">{f.name}</span>
								<span className="text-xs text-neutral-400">
									{fileKind(f.type)} · {formatFileSize(f.size)}
								</span>
							</span>
						</a>
					))}
				</div>
			)}
			{open && <Lightbox file={open} onClose={() => setOpen(undefined)} />}
		</div>
	);
}

/** A picture, big, over everything. A click outside or Escape closes it. */
function Lightbox({ file, onClose }: { file: Message["attachments"][number]; onClose: () => void }) {
	const ref = useDismiss<HTMLDivElement>(onClose);
	return (
		<div className="no-drag fixed inset-0 z-50 flex items-center justify-center bg-neutral-900/70 p-10">
			<div ref={ref} className="flex max-h-full max-w-full flex-col items-center gap-2">
				<img src={file.url!} alt={file.name} className="max-h-[80vh] max-w-full rounded-lg object-contain shadow-2xl" />
				<p className="flex items-center gap-3 text-sm text-white">
					<span className="truncate">{file.name}</span>
					<a href={file.url!} target="_blank" rel="noreferrer" className="text-white/70 underline hover:text-white">
						Open
					</a>
				</p>
			</div>
		</div>
	);
}
