import { DOCX, PPTX, XLSX, isImageType } from "@companybot/core/files";
import { FileCsvIcon, FileDocIcon, FileIcon, FilePdfIcon, FilePptIcon, FileXlsIcon, ImageIcon, PageIcon } from "../../icons";

/** An icon for a file's kind, by its type or (pending, untyped) its name. Sizes to the text around it, like every icon. */
export function FileKindIcon({ type, name, size }: { type?: string; name: string; size?: number }) {
	const ext = name.toLowerCase().split(".").pop();
	if (type === "application/pdf" || (!type && ext === "pdf")) return <FilePdfIcon size={size} />;
	if (type === DOCX || (!type && ext === "docx")) return <FileDocIcon size={size} />;
	if (type === XLSX || (!type && ext === "xlsx")) return <FileXlsIcon size={size} />;
	if (type === PPTX || (!type && ext === "pptx")) return <FilePptIcon size={size} />;
	if (type === "text/csv" || (!type && ext === "csv")) return <FileCsvIcon size={size} />;
	if ((type && isImageType(type)) || (!type && ["png", "jpg", "jpeg", "gif", "webp"].includes(ext ?? ""))) return <ImageIcon size={size} />;
	if (type?.startsWith("text/") || type === "application/json" || (!type && ["txt", "md", "markdown", "json"].includes(ext ?? ""))) return <PageIcon size={size} />;
	return <FileIcon size={size} />;
}
