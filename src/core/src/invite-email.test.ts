import { expect, it } from "vitest";
import { inviteEmail } from "./invite-email";

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
