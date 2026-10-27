/** Ordinary link marks keep page references readable by installed editors. */
// COMPAT(0.1.0-alpha.8): after alpha.7 support ends, use an inline page mention with a live title.
export const pageHref = (id: string) => `companybot://page/${id}`;
export const linkedPageId = (href: string) => /^companybot:\/\/page\/([a-z0-9]+)$/.exec(href)?.[1];

/** BlockNote 0.56's URI allowlist (not publicly exported), extended only for internal page links. */
export function validPageHref(href: string) {
	if (!href) return true;
	const clean = href.replace(/[\u0000-\u0020\u00a0\u1680\u180e\u2000-\u2029\u205f\u3000]/g, "");
	return !!linkedPageId(clean) || /^(?:(?:http|https|ftp|ftps|mailto|tel|callto|sms|cid|xmpp):|[^a-z]|[a-z0-9+.\-]+(?:[^a-z+.\-:]|$))/i.test(clean);
}
