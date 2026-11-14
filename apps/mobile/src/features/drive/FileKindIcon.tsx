import { DOCX, PPTX, XLSX, isImageType } from '@companybot/core/files';
import { CsvFileIcon, DocFileIcon, FileIcon, ImageFileIcon, PageIcon, PdfFileIcon, SheetFileIcon, SlidesFileIcon } from '@/design/icons';

/** A file's icon by its type, or by its name while it's still uploading. Same mapping as desktop. */
export function FileKindIcon({ type, name, size, color }: { type?: string; name: string; size: number; color: string }) {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  const props = { size, color };
  if (type === 'application/pdf' || (!type && ext === 'pdf')) return <PdfFileIcon {...props} />;
  if (type === DOCX || (!type && ext === 'docx')) return <DocFileIcon {...props} />;
  if (type === XLSX || (!type && ext === 'xlsx')) return <SheetFileIcon {...props} />;
  if (type === PPTX || (!type && ext === 'pptx')) return <SlidesFileIcon {...props} />;
  if (type === 'text/csv' || (!type && ext === 'csv')) return <CsvFileIcon {...props} />;
  if ((type && isImageType(type)) || (!type && ['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext))) return <ImageFileIcon {...props} />;
  if (type?.startsWith('text/') || type === 'application/json' || (!type && ['txt', 'md', 'markdown', 'json'].includes(ext))) return <PageIcon {...props} />;
  return <FileIcon {...props} />;
}
