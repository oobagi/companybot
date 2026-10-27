import { getFunctionName } from "convex/server";
import { act, createElement } from "react";
import { type ReactTestRenderer, create } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "./App";
import { navigate } from "./router";
import { SettingsView } from "./views/Settings";

const state = vi.hoisted(() => ({
	queries: {} as Record<string, unknown>,
	mutate: vi.fn(() => Promise.resolve()),
	signOut: vi.fn(() => Promise.resolve()),
}));
vi.mock("./convex", async (original) => ({
	...(await original<typeof import("./convex")>()),
	useQuery: (fn: Parameters<typeof getFunctionName>[0]) => state.queries[getFunctionName(fn)],
	useMutation: () => state.mutate,
}));
vi.mock("@convex-dev/auth/react", () => ({ useAuthActions: () => ({ signOut: state.signOut }) }));
vi.mock("convex/react", async (original) => ({
	...(await original<typeof import("convex/react")>()),
	useConvexAuth: () => ({ isLoading: false, isAuthenticated: true }),
}));
vi.mock("./desktop", () => ({ desktop: undefined, useUpdates: () => ({}) }));
vi.mock("./router", () => ({ navigate: vi.fn() }));

let root: ReactTestRenderer;
beforeEach(() => {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	vi.stubGlobal("document", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
	vi.stubGlobal("localStorage", { getItem: () => null });
	vi.clearAllMocks();
	state.queries = {
		"workspace:settings": { name: "My company", currency: "USD", memory: true, version: 1 },
		"workspace:me": { email: "Owner@Co.com" },
		"preferences:get": { displayName: "", sendWith: "enter", notify: "all" },
	};
});
afterEach(async () => {
	await act(async () => root?.unmount());
	vi.unstubAllGlobals();
});

it.each(["general", "preferences"] as const)("guards confirmation and retries after failure on %s", async (tab) => {
	const account = tab === "preferences";
	const action = account ? "Delete account" : "Delete workspace";
	await act(async () => {
		root = create(createElement(SettingsView, { role: "owner", tab }));
	});
	await act(async () => root.root.findAllByType("button").find((b) => b.children[0] === action)!.props.onClick());
	const field = () => root.root.findByProps({ autoFocus: true });
	const confirm = () => root.root.findAllByType("button").find((b) => b.props.type === "submit")!;
	// Even implicit form submission must respect the confirmation text.
	await act(async () => field().props.onChange({ target: { value: account ? "owner@co.com" : "my company" } }));
	expect(confirm().props.disabled).toBe(!account);
	if (!account) {
		await act(async () => root.root.findByType("form").props.onSubmit({ preventDefault() {} }));
		expect(state.mutate).not.toHaveBeenCalled();
		await act(async () => field().props.onChange({ target: { value: "My company" } }));
	}
	expect(confirm().props.disabled).toBe(false);
	let reject!: (error: Error) => void;
	state.mutate.mockImplementationOnce(() => new Promise<void>((_, fail) => { reject = fail; }));
	const form = root.root.findAllByType("form").find((f) => f.findAllByProps({ autoFocus: true }).length)!;
	await act(async () => form.props.onSubmit({ preventDefault() {} }));
	expect(confirm().props.disabled).toBe(true);
	expect(confirm().children).toEqual(["Deleting…"]);
	// Repeated submits and dismissal cannot reopen an enabled dialog while it's running.
	await act(async () => {
		form.props.onSubmit({ preventDefault() {} });
		root.root.findByProps({ "aria-label": "Close" }).props.onClick();
	});
	expect(state.mutate).toHaveBeenCalledTimes(1);
	expect(confirm().props.disabled).toBe(true);
	await act(async () => reject(new Error("Only owner")));
	expect(JSON.stringify(root.toJSON())).toContain("Only owner");
	expect(confirm().props.disabled).toBe(false);
	await act(async () => form.props.onSubmit({ preventDefault() {} }));
	expect(state.mutate).toHaveBeenCalledTimes(2);
	if (!account) expect(navigate).toHaveBeenCalledWith("chat");
});

it("signs out an erased account in any window instead of leaving it blank or provisioning a workspace", async () => {
	await act(async () => { root = create(createElement(App)); });
	expect(state.signOut).not.toHaveBeenCalled(); // Still loading.
	state.queries["workspace:mine"] = null; // Erased on this or another device; JWT still valid.
	await act(async () => root.update(createElement(App)));
	expect(state.signOut).toHaveBeenCalledOnce();
	expect(state.mutate).not.toHaveBeenCalled();
});
