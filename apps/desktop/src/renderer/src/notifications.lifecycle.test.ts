import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import { act, createElement } from "react";
import { type ReactTestRenderer, create } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vitest";
import { type OpenWorkspace, WorkspaceContext } from "./convex";
import { useAlerts } from "./notifications";
import { navigate } from "./router";

// A desktop notification outlives the screen that showed it: App.tsx remounts everything
// under a new workspace. Clicking it later must still switch back to its workspace.

const state = vi.hoisted(() => ({ alerts: [] as unknown[] }));
vi.mock("./convex", async (original) => ({ ...(await original<typeof import("./convex")>()), useQuery: () => state.alerts }));
vi.mock("./desktop", () => ({ desktop: undefined }));
vi.mock("./router", () => ({ navigate: vi.fn() }));

function Alerts() {
	useAlerts();
	return null;
}

afterEach(() => vi.unstubAllGlobals());

it("switches back to the notification's workspace after the window moved to another", async () => {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	vi.stubGlobal("document", { hasFocus: () => false });
	vi.stubGlobal("window", { focus: vi.fn() });
	const shown: { onclick?: () => void }[] = [];
	vi.stubGlobal(
		"Notification",
		class {
			static permission = "granted";
			onclick?: () => void;
			constructor() {
				shown.push(this);
			}
		},
	);
	let active = "A";
	const open = vi.fn((id: string) => ((active = id), true));
	// Like App.tsx: the gate's `open` stays; everything under it is keyed by workspace.
	const tree = (id: string) =>
		createElement(WorkspaceContext.Provider, { value: { id, open } as unknown as OpenWorkspace }, createElement(Alerts, { key: id }));

	let root!: ReactTestRenderer;
	await act(async () => {
		root = create(tree("A"));
	});
	state.alerts = [{ workspaceId: "A" as Id<"workspaces">, chatId: "chat-A", messageId: "message-A", title: "hello", text: "message" }];
	await act(async () => root.update(tree("A")));
	expect(shown).toHaveLength(1);

	state.alerts = [];
	active = "B";
	await act(async () => root.update(tree("B")));
	shown[0]!.onclick!();
	expect(open).toHaveBeenCalledWith("A");
	expect(active).toBe("A");
	expect(navigate).toHaveBeenCalledWith("chat", "chat-A");
	await act(async () => root.unmount());
});
