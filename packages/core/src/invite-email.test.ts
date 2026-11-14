import { expect, it } from "vitest";
import { DOWNLOAD_URL, inviteEmail } from "./invite-email";

// Names in an invite are typed by people, and the email goes to someone outside the workspace.

it("escapes names in the HTML, so a workspace name can't add links or markup", () => {
	const { html } = inviteEmail({ inviter: "Ada", workspace: '<a href="https://evil.com">Pay here</a>', email: "ben@co.com" });
	expect(html).not.toContain('<a href="https://evil.com"');
	expect(html).toContain("&lt;a href=&quot;https://evil.com&quot;&gt;");
});

it("keeps the subject to one line, so a name can't add email headers", () => {
	const { subject } = inviteEmail({ inviter: "Ada\r\nBcc: everyone@co.com", workspace: `Acme${String.fromCharCode(0x2028)}Co`, email: "ben@co.com" });
	expect(subject).toBe("Ada Bcc: everyone@co.com invited you to Acme Co on Companybot");
});

it("links to the web app when there is one, so an invitee needs to install nothing, and keeps the download", () => {
	const names = { inviter: "Ada", workspace: "Acme", email: "ben@co.com" };
	const web = inviteEmail(names, "https://app.example.com");
	expect(web.text).toContain("https://app.example.com/");
	expect(web.html).toContain('href="https://app.example.com/"');
	expect(web.text).toContain(DOWNLOAD_URL);
	// No address, or one that isn't a web link, and it's the download as before.
	for (const url of [undefined, "", "javascript:alert(1)", "not a url"]) {
		const { text, html } = inviteEmail(names, url);
		expect(text).toContain(DOWNLOAD_URL);
		expect(html).not.toContain("javascript:");
		expect(text).not.toContain("Open Companybot:");
	}
});
