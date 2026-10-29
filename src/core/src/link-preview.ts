// Which links in a message get a preview card (an unfurl). Pure: the backend fetches them
// (linkUnfurl.ts) and the app draws them. Links inside code, and anything that isn't http(s),
// get none: in-app `#/` addresses and page links (`companybot://page/…`) never match.

/** Previews per message, the first distinct links in order. */
export const PREVIEWS_PER_MESSAGE = 3;
const URL_MAX = 2048;

/** Fenced code (an unclosed fence runs to the end), then inline code spans. */
const code = /(```|~~~)[\s\S]*?(?:\1|$)|(`+)[\s\S]*?\2/g;
const link = /https?:\/\/[^\s<>"'`[\]]+/gi;

/** `https://…` as a preview key: no fragment, no username or password, no overlong or dotless host. Undefined if it can't be one. */
export function previewUrl(raw: string): string | undefined {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return undefined;
	}
	if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return undefined;
	if (!url.hostname.includes(".")) return undefined;
	url.hash = "";
	return url.href.length <= URL_MAX ? url.href : undefined;
}

/** A link's end, without the punctuation of the sentence or Markdown around it ("(see https://a.com/b)." → https://a.com/b). */
function trimmed(raw: string) {
	let end = raw.length;
	while (end > 0) {
		const last = raw[end - 1]!;
		const open = raw.slice(0, end).split("(").length - 1;
		const close = raw.slice(0, end).split(")").length - 1;
		if (/[.,;:!?*_~]/.test(last) || (last === ")" && close > open)) end--;
		else break;
	}
	return raw.slice(0, end);
}

/** The first links worth a preview, distinct, in the order written. */
export function previewLinks(text: string): string[] {
	const urls: string[] = [];
	for (const [raw] of text.replace(code, " ").matchAll(link)) {
		const url = previewUrl(trimmed(raw));
		if (url && !urls.includes(url)) urls.push(url);
		if (urls.length === PREVIEWS_PER_MESSAGE) break;
	}
	return urls;
}
