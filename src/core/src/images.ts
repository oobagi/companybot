// Pictures people upload: workspace logos, profile photos and agent pictures. A file's type is
// read from its first bytes, never from what the uploader says it is. The app checks before
// uploading; the backend's upload endpoint checks again, since the app can't be trusted to.

/** No SVG: it's a document that can carry scripts and links, not just pixels. */
export const imageTypes = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
export type ImageType = (typeof imageTypes)[number];
export const imageMaxBytes = 2 * 1024 * 1024;
/** How many leading bytes `sniffImage` needs. */
export const imageHeadBytes = 12;

const startsWith = (bytes: Uint8Array, at: number, sig: number[]) => sig.every((b, i) => bytes[at + i] === b);
const ascii = (text: string) => [...text].map((c) => c.charCodeAt(0));

/** The picture type a file's first bytes say it is, or undefined if they aren't one we take. */
export function sniffImage(head: Uint8Array): ImageType | undefined {
	if (startsWith(head, 0, [0x89, 0x50, 0x4e, 0x47])) return "image/png";
	if (startsWith(head, 0, [0xff, 0xd8, 0xff])) return "image/jpeg";
	if (startsWith(head, 0, ascii("GIF87a")) || startsWith(head, 0, ascii("GIF89a"))) return "image/gif";
	if (startsWith(head, 0, ascii("RIFF")) && startsWith(head, 8, ascii("WEBP"))) return "image/webp";
}

/** Why this file can't be a picture, or undefined if it can. `head` is at least its first `imageHeadBytes`. */
export function imageError(head: Uint8Array, size: number) {
	if (!sniffImage(head)) return "Pick a PNG, JPEG, WebP or GIF image.";
	if (size > imageMaxBytes) return "Pick an image under 2 MB.";
}
