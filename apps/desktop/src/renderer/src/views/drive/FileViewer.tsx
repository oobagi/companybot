import { DOCX, PPTX, XLSX, isImageType } from "@companybot/core/files";
import { type Sheet, parseCsv, readPptx, readXlsx } from "@companybot/core/office-text";
import { useEffect, useRef, useState } from "react";
import { Markdown } from "../../markdown";
import { Loading, Notice, Tabs, metadataClass } from "../../ui";

// Shows a Drive file inline: pictures and PDFs as they are, Word through docx-preview, Excel, CSV
// and PowerPoint read with core's office-text readers (the same ones agents read with), text as text.
// Anything that can't be shown says so and points at Open in browser.

/** Past this many bytes, a spreadsheet or deck isn't fetched into the renderer; the file is still downloadable. */
const RENDER_MAX = 25 * 1024 * 1024;
const ROWS_MAX = 2000;
const COLS_MAX = 50;
const TEXT_MAX = 500_000;

export function FileViewer({ url, type, name }: { url: string; type: string; name: string }) {
	if (isImageType(type)) return <img src={url} alt={name} className="max-h-[80vh] max-w-full self-start rounded-xl border border-neutral-200" />;
	if (type === "application/pdf") return <iframe src={url} title={name} className="h-[80vh] w-full rounded-xl border border-neutral-200 bg-white" />;
	if (type === DOCX) return <DocxView url={url} />;
	if (type === XLSX) return <Fetched url={url} render={(bytes) => <SheetsView sheets={readXlsx(bytes)} />} />;
	if (type === PPTX) return <Fetched url={url} render={(bytes) => <SlidesView slides={readPptx(bytes)} />} />;
	if (type === "text/csv") return <Fetched url={url} render={(bytes) => <SheetsView sheets={[{ name, rows: parseCsv(decode(bytes)) }]} />} />;
	if (type === "text/markdown") return <Fetched url={url} render={(bytes) => <Markdown className="rounded-xl border border-neutral-200 bg-white px-8 py-6 text-sm leading-relaxed">{decode(bytes)}</Markdown>} />;
	if (type.startsWith("text/") || type === "application/json") return <Fetched url={url} render={(bytes) => <pre className="overflow-x-auto rounded-xl border border-neutral-200 bg-neutral-50 p-4 text-sm whitespace-pre-wrap">{decode(bytes)}</pre>} />;
	return <Notice>This kind of file can't be shown here. Open it in your browser to download it.</Notice>;
}

const decode = (bytes: Uint8Array) => {
	const text = new TextDecoder().decode(bytes);
	return text.length > TEXT_MAX ? `${text.slice(0, TEXT_MAX)}\n…` : text;
};

/** Fetches the file's bytes once, then renders them; a failed fetch or an oversized file says so. */
function Fetched({ url, render }: { url: string; render: (bytes: Uint8Array) => React.ReactNode }) {
	const [state, setState] = useState<{ bytes?: Uint8Array; error?: string }>({});
	useEffect(() => {
		let live = true;
		fetch(url)
			.then(async (r) => {
				if (!r.ok) throw new Error(`Couldn't load the file (${r.status}).`);
				const size = Number(r.headers.get("content-length") ?? 0);
				if (size > RENDER_MAX) throw new Error("It's too big to show here. Open it in your browser instead.");
				return new Uint8Array(await r.arrayBuffer());
			})
			.then((bytes) => live && setState({ bytes }), (e: unknown) => live && setState({ error: e instanceof Error ? e.message : "Couldn't load the file. Open it in your browser instead." }));
		return () => { live = false; };
	}, [url]);
	if (state.error) return <Notice>{state.error}</Notice>;
	if (!state.bytes) return <Loading />;
	return <>{render(state.bytes)}</>;
}

function DocxView({ url }: { url: string }) {
	const ref = useRef<HTMLDivElement>(null);
	const [error, setError] = useState<string>();
	return (
		<>
			<Notice>{error}</Notice>
			<Fetched url={url} render={(bytes) => <DocxBody bytes={bytes} container={ref} onError={setError} />} />
		</>
	);
}
function DocxBody({ bytes, container, onError }: { bytes: Uint8Array; container: React.RefObject<HTMLDivElement | null>; onError: (e: string) => void }) {
	useEffect(() => {
		const el = container.current;
		if (!el) return;
		let live = true;
		import("docx-preview")
			.then(({ renderAsync }) => live && renderAsync(bytes.slice().buffer, el, undefined, { ignoreFonts: true, inWrapper: false, ignoreWidth: true, ignoreHeight: true, useBase64URL: true }))
			.catch((e: unknown) => live && onError(e instanceof Error ? `Couldn't show the document: ${e.message}` : "Couldn't show the document."));
		return () => { live = false; el.replaceChildren(); };
	}, [bytes, container, onError]);
	return <div ref={container} className="rounded-xl border border-neutral-200 bg-white px-8 py-6 text-sm leading-relaxed" />;
}

/** A workbook's sheets as tabs over a table, or a CSV as one sheet. */
function SheetsView({ sheets }: { sheets: Sheet[] | undefined }) {
	const [index, setIndex] = useState(0);
	if (!sheets) return <Notice>It's too big to show here. Open it in your browser instead.</Notice>;
	if (!sheets.length) return <Notice>The workbook has no sheets.</Notice>;
	const open = Math.min(index, sheets.length - 1);
	const sheet = sheets[open]!;
	const rows = sheet.rows.slice(0, ROWS_MAX);
	const cols = Math.min(COLS_MAX, Math.max(1, ...rows.map((r) => r.length)));
	return (
		<div className="flex flex-col gap-3">
			{sheets.length > 1 && <Tabs tabs={sheets.map((s, i) => ({ id: String(i), label: s.name }))} value={String(open)} onChange={(id) => setIndex(Number(id))} />}
			{rows.length ? (
				<div className="overflow-auto rounded-xl border border-neutral-200">
					<table className="min-w-full border-collapse text-sm">
						<tbody>
							{rows.map((row, r) => (
								<tr key={r} className="odd:bg-white even:bg-neutral-50">
									{Array.from({ length: cols }, (_, c) => (
										<td key={c} className="max-w-xs truncate border-r border-b border-neutral-100 px-2 py-1 align-top whitespace-nowrap last:border-r-0">{row[c] ?? ""}</td>
									))}
								</tr>
							))}
						</tbody>
					</table>
				</div>
			) : <p className={metadataClass}>This sheet is empty.</p>}
			{(sheet.rows.length > ROWS_MAX || sheet.rows.some((r) => r.length > COLS_MAX)) && <p className={metadataClass}>Showing the first {ROWS_MAX} rows and {COLS_MAX} columns. Open it in your browser for all of it.</p>}
		</div>
	);
}

/** A deck's slides as cards of their text, in order. */
function SlidesView({ slides }: { slides: string[][] | undefined }) {
	if (!slides) return <Notice>It's too big to show here. Open it in your browser instead.</Notice>;
	if (!slides.length) return <Notice>The deck has no slides.</Notice>;
	return (
		<div className="flex flex-col gap-4">
			{slides.map((paragraphs, i) => (
				<section key={i} className="flex flex-col gap-2 rounded-xl border border-neutral-200 bg-white px-6 py-5">
					<p className={metadataClass}>Slide {i + 1}</p>
					{paragraphs.length ? paragraphs.map((p, j) => <p key={j} className={j === 0 ? "text-lg font-semibold" : "text-sm text-neutral-700"}>{p}</p>) : <p className={metadataClass}>No text on this slide.</p>}
				</section>
			))}
		</div>
	);
}
