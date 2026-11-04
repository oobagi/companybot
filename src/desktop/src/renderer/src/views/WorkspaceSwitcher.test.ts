// The workspace switcher: join and create open the new workspace once listed; one create per submit; errors stay where they happened.
import { getFunctionName } from "convex/server";
import { act, createElement } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { navigate } from "../router";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";

const state = vi.hoisted(() => ({
	create: vi.fn(),
	accept: vi.fn(),
	decline: vi.fn(),
	leave: vi.fn(),
	open: vi.fn(),
	mine: {
		workspaces: [{ id: "current", name: "Current", image: null, role: "owner" }],
		invitations: [{ id: "invite", workspace: "Invited Co", invitedBy: "Owner", role: "member" }],
	},
}));
vi.mock("../convex", () => ({
	useQuery: (fn: Parameters<typeof getFunctionName>[0]) => (getFunctionName(fn) === "workspace:mine" ? state.mine : []),
	useMutation: (fn: Parameters<typeof getFunctionName>[0]) => ({
		"workspace:create": state.create,
		"workspace:acceptInvite": state.accept,
		"workspace:declineInvite": state.decline,
		"workspace:leave": state.leave,
	})[getFunctionName(fn)],
	useWorkspace: () => ({ id: "current", open: state.open }),
}));
vi.mock("../router", () => ({ navigate: vi.fn() }));
// The test renderer has no page to put a popover's panel at the end of, so it stays in place.
vi.mock("react-dom", async (actual) => ({ ...(await actual<typeof import("react-dom")>()), createPortal: (node: React.ReactNode) => node }));

let root: ReactTestRenderer;
const bounds = { left: 12, top: 0, right: 160, bottom: 24, width: 148, height: 24 };
const switcher = () => createElement(WorkspaceSwitcher, { name: "Current", onSettings: vi.fn() });
beforeEach(async () => {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	vi.stubGlobal("document", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
	vi.stubGlobal("window", { innerHeight: 800, innerWidth: 1200, addEventListener: vi.fn(), removeEventListener: vi.fn() });
	// The menu's panel measures itself to stay on screen.
	vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
	vi.resetAllMocks();
	state.mine = {
		workspaces: [{ id: "current", name: "Current", image: null, role: "owner" }],
		invitations: [{ id: "invite", workspace: "Invited Co", invitedBy: "Owner", role: "member" }],
	};
	await act(async () => {
		root = create(switcher(), {
			createNodeMock: () => ({ getBoundingClientRect: () => bounds, contains: () => false, querySelector: () => null, focus() {}, children: [], scrollHeight: bounds.height, clientHeight: bounds.height, offsetHeight: bounds.height }),
		});
	});
});
afterEach(async () => {
	await act(async () => root?.unmount());
	vi.unstubAllGlobals();
});

/** Everything written inside a node, joined. */
const textOf = (n: ReactTestInstance | string): string => (typeof n === "string" ? n : n.children.map(textOf).join(""));

/** Opens or closes the switcher's menu: the one button that says whether its panel is open. */
async function toggleMenu() {
	const button = root.root.find((n) => n.type === "button" && "aria-expanded" in n.props);
	await act(async () => button.props.onClick({ currentTarget: { getBoundingClientRect: () => bounds } }));
}

/** Clicks the button that reads `text`, or failing that, one that contains it (after an avatar's initials). */
async function click(text: string) {
	const buttons = root.root.findAll((n) => n.type === "button");
	const button = buttons.find((n) => textOf(n).trim() === text) ?? buttons.find((n) => textOf(n).includes(text))!;
	await act(async () => button.props.onClick());
}

it.each(["create", "accept"] as const)("waits for membership before auto-opening after %s", async (action) => {
	state[action].mockResolvedValueOnce("new-workspace");
	await toggleMenu();
	if (action === "create") {
		await click("New workspace");
		await act(async () => root.root.findByType("input").props.onChange({ target: { value: "New Co" } }));
		await act(async () => root.root.findByType("form").props.onSubmit({ preventDefault() {} }));
		expect(root.root.findAllByType("form")).toHaveLength(0);
	} else {
		await click("Join");
	}
	expect(state.open).not.toHaveBeenCalled();
	state.mine = {
		workspaces: [...state.mine.workspaces, { id: "new-workspace", name: "New Co", image: null, role: "owner" }],
		invitations: [],
	};
	await act(async () => root.update(switcher()));
	expect(state.open).toHaveBeenCalledExactlyOnceWith("new-workspace");
	expect(navigate).toHaveBeenCalledWith("chat");
	await act(async () => root.update(switcher()));
	expect(state.open).toHaveBeenCalledOnce();
});

it("submits only one workspace creation while the first request is pending", async () => {
	state.create.mockImplementation(() => new Promise(() => {}));
	await toggleMenu();
	await click("New workspace");
	await act(async () => root.root.findByType("input").props.onChange({ target: { value: "New Co" } }));
	await act(async () => root.root.findByType("form").props.onSubmit({ preventDefault() {} }));
	// A second click/Enter before the first response must not create another workspace.
	await act(async () => root.root.findByType("form").props.onSubmit({ preventDefault() {} }));
	expect(state.create).toHaveBeenCalledTimes(1);
});

it("does not show an invitation failure in the unrelated create dialog", async () => {
	state.decline.mockRejectedValueOnce(new Error("That invite isn't available anymore."));
	await toggleMenu();
	await click("Decline");
	expect(JSON.stringify(root.toJSON())).toContain("That invite isn't available anymore.");
	await click("New workspace");
	expect(root.root.findByType("form").findAllByType("p").map((p) => p.children.join("")).join("\n"))
		.not.toContain("That invite isn't available anymore.");
});

it("switches to another workspace from the menu", async () => {
	state.mine = {
		workspaces: [
			{ id: "current", name: "Current", image: null, role: "owner" },
			{ id: "other", name: "Other Co", image: null, role: "member" },
		],
		invitations: [],
	};
	await act(async () => root.update(switcher()));
	await toggleMenu();
	await click("Other Co");
	expect(state.open).toHaveBeenCalledExactlyOnceWith("other");
	expect(navigate).toHaveBeenCalledWith("chat");
});
