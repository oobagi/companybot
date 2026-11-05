import { act, createElement, useEffect, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { inApp } from "./testing";
import { setFormDraftPerson, useDraft } from "./ui";
import { MadeItemDetail } from "./views/customize/shared";
import { DatabaseDialog } from "./views/records/DatabaseDialog";
import { AgentScreen } from "./views/Agents";
import { SettingsView } from "./views/Settings";
import { SkillScreen } from "./views/customize/Skills";
import { AutomationScreen } from "./views/customize/Automations";
import { RecordList } from "./views/records/RecordList";
import { MemoryTab } from "./views/Memory";
const state = vi.hoisted(() => ({ queries: {} as Record<string, unknown>, save: vi.fn(async () => "created") }));
vi.mock("./convex", () => ({
	useWorkspace: () => ({ id: "workspace" }),
	useQuery: (fn: Parameters<typeof getFunctionName>[0]) => state.queries[getFunctionName(fn)],
	useMutation: () => state.save,
	useAction: () => state.save,
	usePaginatedQuery: () => ({ results: [], status: "Exhausted", loadMore: state.save }),
}));
let root: Root;
let host: HTMLDivElement;
const access = { owner: true, roles: [], permissions: [] } as never;
const agent = { _id: "agent", name: "Saved agent", description: "", instructions: "", model: "model", tools: [], access: [], version: 1, updatedAt: Date.now(), updatedByName: "Alice" };
const settings = { name: "Saved workspace", currency: "USD", memory: true, imageBudgetUsd: 20, threadHours: 24, version: 1, imageSpentUsd: 0, models: [], imageModels: [], routerModels: [] };
async function render(element: ReactElement) { await act(async () => root.render(inApp(element))); }
async function click(text: string) {
	const button = [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);
	expect(button, text).toBeTruthy();
	await act(async () => button!.click());
}
async function change(selector: string, value: string) {
	const input = document.querySelector(selector === "input" ? "input:not([type=file])" : selector) as HTMLInputElement;
	expect(input, selector).toBeTruthy();
	await act(async () => {
		const proto = input.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
		Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(input, value);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
}
beforeEach(() => {
	setFormDraftPerson(null); setFormDraftPerson("alice");
	state.save.mockClear();
	state.queries = { "preferences:get": { displayName: "Alice", timeZone: "UTC", sendWith: "enter", notify: "off" }, "workspace:me": { userId: "alice", email: "alice@example.com" }, "workspace:settings": settings, "agents:list": [agent], "agents:options": { models: [], groups: [] }, "agents:history": [], "chats:list": { channels: [] }, "recordTypes:list": [], "memory:list": [{ id: "memory", agentId: "agent", content: "Saved memory", scope: "personal", version: 1, canEdit: true, createdAt: Date.now(), updatedAt: Date.now() }] };
	host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); setFormDraftPerson(null); });
function custom(editable = true, trash = false) {
	return createElement(MadeItemDetail<string>, { id: "item", tab: "skills", name: "Skill", canEdit: editable, createdByName: "Alice", custom: { version: 1, updatedByName: "Alice", updatedAt: Date.now() }, trash: trash ? { at: Date.now() } as never : null, saved: "Saved skill", onSave: state.save, onDelete: state.save, fields: (value, set) => createElement("input", { value, onChange: (e) => set(e.target.value) }) });
}
it("shows saved custom fields while read-only and brings back the draft when editing returns", async () => {
	await render(custom()); await change("input", "Unsaved skill");
	await render(custom(false)); expect((document.querySelector("input:not([type=file])") as HTMLInputElement).value).toBe("Saved skill");
	await render(custom()); expect((document.querySelector("input:not([type=file])") as HTMLInputElement).value).toBe("Unsaved skill");
});
it.each(["agent", "settings", "memory", "custom", "account"])("clears the %s draft after saving", async (kind) => {
	const screen = () => kind === "agent" ? createElement(AgentScreen, { access, agentId: "agent" as never }) : kind === "settings" ? createElement(SettingsView, { access, tab: "general" }) : kind === "memory" ? createElement(MemoryTab, { access }) : kind === "account" ? createElement(SettingsView, { access, tab: "preferences" }) : custom();
	await render(screen());
	if (kind === "memory") {
		await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Memory actions"]')!.click());
		await click("Edit");
	}
	await change(kind === "memory" ? "textarea" : "input", "Unsaved text");
	await click("Save"); expect(state.save).toHaveBeenCalled();
	await render(createElement("div")); await render(screen());
	expect([...document.querySelectorAll("input, textarea")].some((el) => (el as HTMLInputElement).value === "Unsaved text")).toBe(false);
});
it.each(["escape", "X", "backdrop", "unmount"])("cancels a new database draft on %s", async (how) => {
	const close = vi.fn();
	await render(createElement(DatabaseDialog, { onClose: close }));
	await change("input", "Abandoned database");
	if (how === "escape") await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
	if (how === "X") await act(async () => (document.querySelector('button[aria-label="Close"]') as HTMLButtonElement).click());
	if (how === "backdrop") await act(async () => document.querySelector(".mantine-Modal-overlay")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
	if (how !== "unmount") {
		expect(close).toHaveBeenCalledOnce();
		expect((document.querySelector("input") as HTMLInputElement).value).toBe("");
	}
	await render(createElement("div")); await render(createElement(DatabaseDialog, { onClose: close }));
	expect((document.querySelector("input:not([type=file])") as HTMLInputElement).value).toBe("");
});

it.each(["skills", "automations"])("clears a new %s draft after creation", async (kind) => {
	const screen = () => kind === "skills" ? createElement(SkillScreen, { access, id: "new" }) : createElement(AutomationScreen, { access, id: "new" });
	await render(screen()); await change("input", "New item");
	await click("Create");
	await render(createElement("div")); await render(screen());
	expect((document.querySelector("input:not([type=file])") as HTMLInputElement).value).toBe("");
});
it.each(["agent", "settings"])("shows saved %s values after manage rights are lost and restores edits afterwards", async (kind) => {
	const screen = (access: never) => kind === "agent" ? createElement(AgentScreen, { access, agentId: "agent" as never }) : createElement(SettingsView, { access, tab: "general" });
	await render(screen(access)); await change("input", "Unsaved");
	await render(screen({ owner: false, roles: [], permissions: [] } as never));
	expect((document.querySelector("input:not([type=file])") as HTMLInputElement).value).toBe(kind === "agent" ? "Saved agent" : "Saved workspace");
	await render(screen(access)); expect((document.querySelector("input:not([type=file])") as HTMLInputElement).value).toBe("Unsaved");
});

it("clears a new database draft after creation", async () => {
	await render(createElement(DatabaseDialog, { onClose: vi.fn() }));
	await change("input", "New database"); await click("Create database");
	expect((document.querySelector("input") as HTMLInputElement).value).toBe("");
});

it("keeps a database view draft across tabs and clears it after saving", async () => {
	state.queries["databaseViews:list"] = [{ _id: "view", name: "My view", filters: [], columns: ["name"], version: 1 }];
	const type = { _id: "database", name: "Project", plural: "Projects", key: "project", canEdit: true, fields: [{ key: "name", label: "Name", kind: "text" }] } as never;
	const screen = () => createElement(RecordList, { type, access });
	await render(screen()); await click("My view"); await click("Filter");
	await click("All"); await click("My view"); await click("Save for everyone");
	await render(createElement("div")); await render(screen()); await click("My view");
	expect([...document.querySelectorAll("button")].some((b) => b.textContent === "Save for everyone")).toBe(false);
});

it("ignores agents and channels that disappeared from a new automation draft", async () => {
	function Seed() {
		const draft = useDraft("automations:new", {}, 0);
		useEffect(() => { draft.set({ config: { name: "Draft", prompt: "Do it", trigger: { type: "event", event: "message.posted", channelId: "gone" } }, agentId: "gone", audience: { audience: "channel", channelId: "gone" } }); }, []);
		return null;
	}
	await render(createElement(Seed)); await render(createElement("div"));
	await render(createElement(AutomationScreen, { access, id: "new" }));
	await click("Create");
	expect(state.save).toHaveBeenLastCalledWith(expect.objectContaining({ agentId: "agent", audience: "creator", config: expect.objectContaining({ trigger: { type: "event", event: "member.joined" } }) }));
});
it("shows saved custom fields while archived and restores the draft on restore", async () => {
	await render(custom()); await change("input", "Unsaved skill");
	await render(custom(true, true)); expect((document.querySelector("input") as HTMLInputElement).value).toBe("Saved skill");
	await render(custom()); expect((document.querySelector("input") as HTMLInputElement).value).toBe("Unsaved skill");
});
it("clears edited database fields after saving, and stays open", async () => {
	const type = { _id: "database", name: "Project", plural: "Projects", key: "project", version: 1, access: [] } as never;
	const close = vi.fn();
	await render(createElement(DatabaseDialog, { type, onClose: close }));
	await change("input", "Unsaved database"); await click("Save");
	expect(close).not.toHaveBeenCalled();
	expect((document.querySelector("input") as HTMLInputElement).value).toBe("Projects");
});
