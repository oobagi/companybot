// The email someone gets when an owner invites them. Plain enough for any inbox.

/** Where friends get the app: the newest release on GitHub. */
export const DOWNLOAD_URL = "https://github.com/oobagi/companybot/releases/latest";

/** Invite emails a workspace may send per day, and how long before the same address can get another. */
export const INVITE_EMAILS_PER_DAY = 20;
export const INVITE_RESEND_MS = 10 * 60_000;

const escape = (text: string) =>
	text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** One line of plain text: names are typed by people, and the subject is an email header. */
const oneLine = (text: string) => text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").trim().slice(0, 100);

export function inviteEmail(names: { inviter: string; workspace: string; email: string }) {
	const inviter = oneLine(names.inviter);
	const workspace = oneLine(names.workspace);
	const email = oneLine(names.email);
	const subject = `${inviter} invited you to ${workspace} on Companybot`;
	const steps = [`Download Companybot: ${DOWNLOAD_URL}`, `Open it and sign in with ${email}. You'll join ${workspace} right away.`];
	const text = [
		`${inviter} invited you to join ${workspace} on Companybot, where the team and its AI agents chat and work together.`,
		"",
		...steps.map((s, i) => `${i + 1}. ${s}`),
		"",
		"Already using Companybot? Open it and accept the invite from the workspace menu.",
	].join("\n");
	const html = `<div style="font:15px/1.5 system-ui,sans-serif;color:#171717;max-width:32rem">
<p><strong>${escape(inviter)}</strong> invited you to join <strong>${escape(workspace)}</strong> on Companybot, where the team and its AI agents chat and work together.</p>
<p><a href="${DOWNLOAD_URL}" style="display:inline-block;background:#171717;color:#fff;padding:10px 16px;border-radius:12px;text-decoration:none">Download Companybot</a></p>
<p>Then open it and sign in with <strong>${escape(email)}</strong>. You'll join ${escape(workspace)} right away.</p>
<p style="color:#737373;font-size:13px">Already using Companybot? Open it and accept the invite from the workspace menu.</p>
</div>`;
	return { subject, text, html };
}
