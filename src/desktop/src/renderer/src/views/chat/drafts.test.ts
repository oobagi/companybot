import type { JSONContent } from "@tiptap/core";
import { describe, expect, it } from "vitest";
import { DRAFT_TTL_MS, chatsWithDrafts, draftKey, loadDraft, saveDraft } from "./drafts";

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

	it("lists the chats with a draft in this workspace, counting threads once", () => {
		const s = memory();
		saveDraft(s, draftKey("w1", "c1"), doc("a"));
		saveDraft(s, draftKey("w1", "c1", "t1"), doc("b"));
		saveDraft(s, draftKey("w1", "c2", "t9"), doc("c"));
		saveDraft(s, draftKey("w2", "c3"), doc("other workspace"));
		s.setItem("sidebar.hidden", "true");
		expect(chatsWithDrafts(s, "w1")).toEqual(new Set(["c1", "c2"]));
		expect(chatsWithDrafts(s, "w3")).toEqual(new Set());
	});
});
