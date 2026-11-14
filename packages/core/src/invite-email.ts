// The email someone gets when they're invited. Plain enough for any inbox.

/** Where friends get the app: the newest release on GitHub. */
export const DOWNLOAD_URL = "https://github.com/oobagi/companybot/releases/latest";

/** Invite emails a workspace may send per day, and how long before the same address can get another. */
export const INVITE_EMAILS_PER_DAY = 20;
export const INVITE_RESEND_MS = 10 * 60_000;

const escape = (text: string) =>
	text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** One line of plain text: names are typed by people, and the subject is an email header. */
const oneLine = (text: string) => text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").trim().slice(0, 100);

/** The web app's address, if it's a plain web link (Convex env `WEB_APP_URL`); anything else is ignored. */
function webLink(url: string | undefined) {
	try {
		const parsed = url ? new URL(url) : undefined;
		return parsed && /^https?:$/.test(parsed.protocol) ? parsed.href : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The invite. With the web app's address (`webUrl`), it links there, so an invitee can start in
 * their browser and install nothing; the desktop app is offered too. Without one, it's the download.
 */
export function inviteEmail(names: { inviter: string; workspace: string; email: string }, webUrl?: string) {
	const inviter = oneLine(names.inviter);
	const workspace = oneLine(names.workspace);
	const email = oneLine(names.email);
	const web = webLink(webUrl);
	const subject = `${inviter} invited you to ${workspace} on Companybot`;
	const steps = web
		? [`Open Companybot: ${web}`, `Sign in with ${email}. You'll join ${workspace} right away.`]
		: [`Download Companybot: ${DOWNLOAD_URL}`, `Open it and sign in with ${email}. You'll join ${workspace} right away.`];
	const text = [
		`${inviter} invited you to join ${workspace} on Companybot, where the team and its AI agents chat and work together.`,
		"",
		...steps.map((s, i) => `${i + 1}. ${s}`),
		...(web ? ["", `Prefer an app? Get Companybot for Mac: ${DOWNLOAD_URL}`] : []),
		"",
		"Already using Companybot? Open it and accept the invite from the workspace menu.",
	].join("\n");
	const button = (href: string, label: string) =>
		`<p><a href="${escape(href)}" style="display:inline-block;background:#171717;color:#fff;padding:10px 16px;border-radius:12px;text-decoration:none">${label}</a></p>`;
	const html = `<div style="font:15px/1.5 system-ui,sans-serif;color:#171717;max-width:32rem">
<p><strong>${escape(inviter)}</strong> invited you to join <strong>${escape(workspace)}</strong> on Companybot, where the team and its AI agents chat and work together.</p>
${web ? button(web, "Open Companybot") : button(DOWNLOAD_URL, "Download Companybot")}
<p>${web ? "Then sign in" : "Then open it and sign in"} with <strong>${escape(email)}</strong>. You'll join ${escape(workspace)} right away.</p>
${web ? `<p style="color:#737373;font-size:13px">Prefer an app? <a href="${DOWNLOAD_URL}" style="color:#737373">Get Companybot for Mac</a>.</p>\n` : ""}<p style="color:#737373;font-size:13px">Already using Companybot? Open it and accept the invite from the workspace menu.</p>
</div>`;
	return { subject, text, html };
}
