import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("./convex", () => ({ useQuery: () => ({ userId: person }), useWorkspace: () => ({ id: workspace }) }));
import { useRun, useDraft } from "./ui";
let person = "alice";
let workspace = "one";
let root: ReactTestRenderer;
let run: ReturnType<typeof useRun>["run"];
let draft: ReturnType<typeof useDraft<string>>;
function Form({ item, version = 1 }: { item: string; version?: number }) {
 run = useRun().run;
 draft = useDraft(item, "saved", version);
 return null;
}
function mount(item: string, version = 1) { act(() => { root = create(createElement(Form, { item, version })); }); }
afterEach(() => { act(() => root.unmount()); person = "alice"; workspace = "one"; });
it("restores edits and their original version after leaving, and clears on discard or save", () => {
 mount("restore");
 act(() => draft.set("mine"));
 act(() => root.unmount());
 mount("restore", 2);
 expect(draft.value).toBe("mine");
 expect(draft.dirty).toBe(true);
 expect(draft.stale).toBe(true);
 expect(draft.base).toBe(1);
 act(() => draft.keepMine());
 expect(draft.base).toBe(2);
 expect(draft.stale).toBe(false);
 act(() => draft.discard());
 act(() => root.unmount());
 mount("restore", 2);
 expect(draft.dirty).toBe(false);
 expect(draft.value).toBe("saved");
});
it("keeps items, people and workspaces separate even without unmounting", () => {
 mount("isolation");
 act(() => draft.set("alice edit"));
 person = "bob";
 act(() => root.update(createElement(Form, { item: "isolation" })));
 expect(draft.dirty).toBe(false);
 person = "alice"; workspace = "two";
 act(() => root.update(createElement(Form, { item: "isolation" })));
 expect(draft.dirty).toBe(false);
 workspace = "one";
 act(() => root.update(createElement(Form, { item: "other" })));
 expect(draft.dirty).toBe(false);
 act(() => root.update(createElement(Form, { item: "isolation" })));
 expect(draft.value).toBe("alice edit");
 act(() => draft.discard());
});

it("clears a successful save but keeps edits after a failed save", async () => {
 mount("save");
 act(() => draft.set("mine"));
 await act(async () => { await run(Promise.reject(new Error("offline")), draft.discard); });
 expect(draft.value).toBe("mine");
 await act(async () => { await run(Promise.resolve(), draft.discard); });
 act(() => root.unmount());
 mount("save");
 expect(draft.dirty).toBe(false);
});
