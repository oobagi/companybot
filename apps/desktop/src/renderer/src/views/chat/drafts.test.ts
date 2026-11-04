import type { JSONContent } from "@tiptap/core";
import { describe, expect, it } from "vitest";
import { DRAFT_TTL_MS, chatsWithDrafts, draftKey, loadDraft, saveDraft, sweepDrafts, textKey } from "./drafts";

const memory = () => {
	const data = new Map<string, string>();
	return {
		getItem: (k: string) => data.get(k) ?? null,
		setItem: (k: string, v: string) => void data.set(k, v),
		removeItem: (k: string) => void data.delete(k),
		key: (i: number) => [...data.keys()][i] ?? null,
		get length() {
			return data.size;
		},
	};
};

const doc = (text: string): JSONContent => ({
	type: "doc",
	content: [{ type: "paragraph", content: [{ type: "text", text }, { type: "token", attrs: { id: "u1", label: "Ada", kind: "user" } }] }],
});

describe("drafts", () => {
	it("keys a draft by workspace, chat and thread", () => {
		expect(draftKey("w1", "c1")).toBe("draft:w1:c1");
		expect(draftKey("w1", "c1", "t1")).toBe("draft:w1:c1:t1");
		expect(draftKey("w1", "c1")).not.toBe(draftKey("w2", "c1"));
	});

	it("saves each person's text apart", () => {
		expect(textKey("u1", draftKey("w1", "c1"))).toBe("text:u1:draft:w1:c1");
		const s = memory();
		saveDraft(s, textKey("u1", draftKey("w1", "c1")), doc("mine"));
		expect(loadDraft(s, textKey("u2", draftKey("w1", "c1")))).toBeNull();
		saveDraft(s, textKey("u2", draftKey("w1", "c1")), doc("theirs"));
		// Switching back finds yours.
		expect(loadDraft(s, textKey("u1", draftKey("w1", "c1")))).toEqual(doc("mine"));
	});

	it("brings back what was saved, chips included", () => {
		const s = memory();
		saveDraft(s, draftKey("w1", "c1"), doc("hi "));
		expect(loadDraft(s, draftKey("w1", "c1"))).toEqual(doc("hi "));
		expect(loadDraft(s, draftKey("w1", "c2"))).toBeNull();
	});

	it("keeps a thread's draft apart from its chat's", () => {
		const s = memory();
		saveDraft(s, draftKey("w1", "c1"), doc("chat"));
		saveDraft(s, draftKey("w1", "c1", "t1"), doc("thread"));
		expect(loadDraft(s, draftKey("w1", "c1", "t1"))).toEqual(doc("thread"));
	});

	it("forgets a draft saved as nothing (cleared on send)", () => {
		const s = memory();
		saveDraft(s, "draft:w1:c1", doc("hi"));
		saveDraft(s, "draft:w1:c1", null);
		expect(loadDraft(s, "draft:w1:c1")).toBeNull();
		expect(s.length).toBe(0);
	});

	it("drops a draft that is unreadable, not a document, or a month old", () => {
		const s = memory();
		s.setItem("draft:w1:a", "{");
		s.setItem("draft:w1:b", JSON.stringify({ doc: { type: "paragraph" }, at: Date.now() }));
		saveDraft(s, "draft:w1:c", doc("old"), 1000);
		for (const k of ["draft:w1:a", "draft:w1:b"]) expect(loadDraft(s, k)).toBeNull();
		expect(loadDraft(s, "draft:w1:c", 1000 + DRAFT_TTL_MS - 1)).not.toBeNull();
		expect(loadDraft(s, "draft:w1:c", 1000 + DRAFT_TTL_MS)).toBeNull();
		expect(s.length).toBe(0);
	});

	it("lists the chats where this person has a draft in this workspace, counting threads once", () => {
		const s = memory();
		const mine = (chat: string, thread?: string) => textKey("u1", draftKey("w1", chat, thread));
		saveDraft(s, mine("c1"), doc("a"));
		saveDraft(s, mine("c1", "t1"), doc("b"));
		saveDraft(s, mine("c2", "t9"), doc("c"));
		saveDraft(s, textKey("u1", draftKey("w2", "c3")), doc("other workspace"));
		saveDraft(s, textKey("u2", draftKey("w1", "c4")), doc("someone else"));
		saveDraft(s, draftKey("w1", "c5"), doc("nobody's"));
		s.setItem("sidebar.hidden", "true");
		expect(chatsWithDrafts(s, "u1", "w1")).toEqual(new Set(["c1", "c2"]));
		expect(chatsWithDrafts(s, "u2", "w1")).toEqual(new Set(["c4"]));
		expect(chatsWithDrafts(s, "u1", "w3")).toEqual(new Set());
	});

	it("drops drafts saved before they were per person, and expired ones, and nothing else", () => {
		const s = memory();
		saveDraft(s, draftKey("w1", "c1"), doc("nobody's"));
		saveDraft(s, draftKey("w1", "c1", "t1"), doc("nobody's thread"));
		saveDraft(s, textKey("u1", draftKey("w1", "c1")), doc("old"), 1000);
		saveDraft(s, textKey("u1", draftKey("w1", "c2")), doc("new"), 5000);
		s.setItem("files:u1:draft:w1:c1", "[]");
		s.setItem("sidebar.hidden", "true");
		sweepDrafts(s, 1000 + DRAFT_TTL_MS);
		expect([...Array(s.length)].map((_, i) => s.key(i))).toEqual(["text:u1:draft:w1:c2", "files:u1:draft:w1:c1", "sidebar.hidden"]);
	});
});
