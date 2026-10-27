// Pictures people upload: workspace logos, profile photos and agent pictures. The app checks
// before uploading; the backend checks again, since the app can't be trusted to.

/** No SVG: it's a document that can carry scripts and links, not just pixels. */
export const imageTypes = ["image/png", "image/jpeg", "image/webp", "image/gif"];
export const imageMaxBytes = 2 * 1024 * 1024;

/** Why this file can't be a picture, or undefined if it can. */
export function imageError(file: { type?: string; size: number }) {
	if (!file.type || !imageTypes.includes(file.type)) return "Pick a PNG, JPEG, WebP or GIF image.";
	if (file.size > imageMaxBytes) return "Pick an image under 2 MB.";
}
