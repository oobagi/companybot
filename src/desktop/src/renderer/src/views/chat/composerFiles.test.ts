import { describe, expect, it } from "vitest";
import { PENDING_TTL_MS, type Pending, createPendingStore, loadPending, pastedFiles, pendingKey, savePending } from "./composerFiles";
import { draftKey } from "./drafts";

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

const uploaded = (name: string, at = 1000): Pending => ({ key: name, name, size: 10, progress: 1, file: `id-${name}` as Pending["file"], at });
const uploading = (name: string): Pending => ({ key: name, name, size: 10, progress: 0.5 });

describe("pending files", () => {
	it("keys them by person and composer", () => {
		const chat = draftKey("w1", "c1");
		expect(pendingKey("u1", chat)).toBe("files:u1:draft:w1:c1");
		expect(pendingKey("u1", chat)).not.toBe(pendingKey("u2", chat));
		expect(pendingKey("u1", chat)).not.toBe(pendingKey("u1", draftKey("w2", "c1")));
		expect(pendingKey("u1", chat)).not.toBe(pendingKey("u1", draftKey("w1", "c1", "t1")));
	});

	it("saves only uploaded ones, and forgets the key when none are left", () => {
		const s = memory();
		const key = pendingKey("u1", draftKey("w1", "c1"));
		savePending(s, key, [uploaded("a.pdf"), uploading("b.pdf"), { ...uploaded("c.pdf"), error: "no" }]);
		expect(loadPending(s, key, 2000).map((i) => [i.name, i.file])).toEqual([["a.pdf", "id-a.pdf"]]);
		savePending(s, key, [uploading("b.pdf")]);
		expect(s.length).toBe(0);
	});

	it("drops ones whose upload the server has swept, and unreadable ones", () => {
		const s = memory();
		const key = pendingKey("u1", draftKey("w1", "c1"));
		savePending(s, key, [uploaded("old", 1000), uploaded("new", 5000)]);
		expect(loadPending(s, key, 1000 + PENDING_TTL_MS).map((i) => i.name)).toEqual(["new"]);
		s.setItem(key, "{");
		expect(loadPending(s, key)).toEqual([]);
		expect(s.length).toBe(0);
	});

	it("keeps each composer's files apart and tells subscribers", () => {
		const store = createPendingStore(memory(), () => 2000);
		const a = pendingKey("u1", draftKey("w1", "c1"));
		const b = pendingKey("u1", draftKey("w1", "c2"));
		let heard = 0;
		store.subscribe(() => heard++);
		store.update(a, (list) => [...list, uploading("a")]);
		expect(store.get(a).map((i) => i.name)).toEqual(["a"]);
		expect(store.get(b)).toEqual([]);
		expect(store.get(undefined)).toEqual([]);
		expect(heard).toBe(1);
		// Same list until it changes, as useSyncExternalStore needs.
		expect(store.get(a)).toBe(store.get(a));
	});

	it("brings uploaded files back after a restart, for the same person only", () => {
		const s = memory();
		const mine = pendingKey("u1", draftKey("w1", "c1"));
		createPendingStore(s, () => 2000).update(mine, () => [uploaded("a.pdf", 1500)]);
		const restarted = createPendingStore(s, () => 3000);
		expect(restarted.get(mine).map((i) => i.file)).toEqual(["id-a.pdf"]);
		expect(restarted.get(pendingKey("u2", draftKey("w1", "c1")))).toEqual([]);
	});

	it("sweeps expired saved lists at start", () => {
		const s = memory();
		savePending(s, pendingKey("u1", draftKey("w1", "c1")), [uploaded("a", 1000)]);
		s.setItem("draft:w1:c1", "{}");
		createPendingStore(s, () => 1000 + PENDING_TTL_MS);
		expect([...Array(s.length)].map((_, i) => s.key(i))).toEqual(["draft:w1:c1"]);
	});
});

describe("pastedFiles", () => {
	const png = { name: "image.png" } as File;
	const clipboard = (data: Record<string, string>, files: File[]) => ({ types: [...Object.keys(data), "Files"], files, getData: (f: string) => data[f] ?? "" });

	it("pastes text, not the picture, from Excel or Word", () => {
		expect(pastedFiles(clipboard({ "text/plain": "1\t2\n3\t4", "text/html": "<table>…</table>", "text/rtf": "{\\rtf1}" }, [png]))).toEqual([]);
	});

	it("attaches a screenshot, a copied picture, or files from Finder", () => {
		expect(pastedFiles(clipboard({}, [png]))).toEqual([png]);
		expect(pastedFiles(clipboard({ "text/html": '<img src="https://x/y.png">' }, [png]))).toEqual([png]);
		expect(pastedFiles(clipboard({ "text/plain": "image.png" }, [png]))).toEqual([png]);
	});
});
