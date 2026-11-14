import { actionLabel, alwaysAllowText, askText, describeAllowed, readableValue, toolLine } from "./action-words";
import { describe, expect, it } from "vitest";


describe("action wording", () => {
	it("says exactly what Always covers, and how a call was allowed", () => {
		const gmail = { name: "Gmail", connection: "personal" as const };
		expect(alwaysAllowText("gmail.send_email", gmail)).toBe(
			"Always allow: agents can send email from your Gmail without asking you first. Only when acting for you. Change it anytime in Settings → Your preferences.",
		);
		expect(alwaysAllowText("crm.send_sms", { name: "CRM", connection: "workspace" }, { automation: "Morning brief", whereToChange: false })).toBe(
			"Always allow: agents can send SMS with the workspace's CRM when running Morning brief without asking you first. Only when acting for you.",
		);
		expect(alwaysAllowText("crm.charge", gmail, { title: "Charge a card" })).toContain("agents can charge a card from your Gmail");
		const at = Date.UTC(2026, 9, 25, 12);
		expect(describeAllowed({ how: "always", by: "u1", at }, "Jaden", "UTC")).toBe("Always allowed by Jaden, Oct 25");
		expect(describeAllowed({ how: "automation", by: "u1", at, automation: "Morning brief" }, "Jaden", "UTC")).toBe(
			"Allowed by Jaden for Morning brief, Oct 25",
		);
		expect(describeAllowed({ how: "once", by: "u1", at }, "Jaden", "UTC")).toBe("Approved by Jaden, Oct 25");
	});

	it("names actions in plain words: the server's title, else the name with acronyms kept", () => {
		expect(actionLabel("fake-crm.send_sms")).toBe("Send SMS");
		expect(actionLabel("fake-crm.charge_card")).toBe("Charge card");
		expect(actionLabel("crm.getContactById")).toBe("Get contact by ID");
		expect(actionLabel("crm.export-csv-url")).toBe("Export CSV URL");
		expect(actionLabel("crm.send_sms", " Text a customer ")).toBe("Text a customer");
		expect(actionLabel("crm.send_sms", "")).toBe("Send SMS");
	});

	it("asks in a natural sentence, with phone numbers laid out", () => {
		const crm = { name: "Fake CRM", connection: "personal" as const };
		expect(askText("fake-crm.send_sms", crm, { to: "+15550100100", text: "hi" })).toBe("I'd like to send an SMS to +1 (555) 010-0100 from your Fake CRM.");
		expect(askText("fake-crm.charge_card", crm, { amount: 40, customer: "Dana" })).toBe("I'd like to charge a card in your Fake CRM.");
		expect(askText("gmail.send_email", { name: "Gmail", connection: "workspace" }, { to: ["a@x.co", "b@x.co"] })).toBe(
			"I'd like to send an email to a@x.co, b@x.co with the workspace's Gmail.",
		);
		expect(askText("crm.list_deals", crm, {})).toBe("I'd like to list deals in your Fake CRM.");
		expect(askText("crm.send_money", crm, {})).toBe("I'd like to send money in your Fake CRM.");
		expect(askText("crm.x", crm, {}, { title: "Update a contact's stage" })).toBe("I'd like to update a contact's stage in your Fake CRM.");
		expect(askText("memory.forget", null, {})).toBe("I'd like to forget in Companybot.");
		// The tool's words for the call name who; an automation's run says whose run it is and that it acts as you.
		expect(askText("members.remove", null, {}, { said: "Remove ben@acme.com from the workspace" })).toBe("I'd like to remove ben@acme.com from the workspace.");
		expect(askText("chat.manage", null, {}, { said: "Post in #general", automation: "Monday sales summary" })).toBe("Monday sales summary wants to post in #general as you.");
		expect(askText("records.save", null, {}, { title: "Save a record", automation: "Digest" })).toBe("Digest wants to save a record as you.");
		expect(askText("fake-crm.send_sms", crm, { to: "+15550100100" }, { automation: "Digest" })).toBe("Digest wants to send an SMS to +1 (555) 010-0100 from your Fake CRM.");
	});

	it("lays out phone numbers for reading, and leaves everything else alone", () => {
		expect(readableValue("+15550100100")).toBe("+1 (555) 010-0100");
		expect(readableValue("+1 555 010 0100")).toBe("+1 (555) 010-0100");
		expect(readableValue("555-010-0100")).toBe("(555) 010-0100");
		expect(readableValue("+44 20 7946 0958")).toBe("+44 20 7946 0958");
		expect(readableValue("5550100100")).toBe("5550100100");
		expect(readableValue("40")).toBe("40");
		expect(readableValue("Running late, see you at 3.")).toBe("Running late, see you at 3.");
	});

	it("says what a tool did, in the right tense", () => {
		expect(toolLine("Send SMS with Fake CRM", "done")).toBe("Sent SMS with Fake CRM");
		expect(toolLine("Send SMS with Fake CRM", "running")).toBe("Sending SMS with Fake CRM…");
		expect(toolLine("Send SMS with Fake CRM", "error")).toBe("Couldn't send SMS with Fake CRM");
		expect(toolLine("Look up Fake CRM actions", "done")).toBe("Looked up Fake CRM actions");
		expect(toolLine("Charge card", "running")).toBe("Charging card…");
		expect(toolLine("Reply", "done")).toBe("Replied");
		expect(toolLine("Contact lookup", "done")).toBe("Used Contact lookup");
		expect(toolLine("Contact lookup", "error")).toBe("Failed: Contact lookup");
	});

});
