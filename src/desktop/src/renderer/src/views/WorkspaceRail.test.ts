// The rail: join and create open the new workspace once listed; one create per submit; errors stay in their popover.
import { getFunctionName } from "convex/server";
import { act, createElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { navigate } from "../router";
import { WorkspaceRail } from "./WorkspaceRail";

const state = vi.hoisted(() => ({
	create: vi.fn(),
	accept: vi.fn(),
	decline: vi.fn(),
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
	})[getFunctionName(fn)],
	useWorkspace: () => ({ id: "current", open: state.open }),
}));
vi.mock("../router", () => ({ navigate: vi.fn() }));

let root: ReactTestRenderer;
const bounds = { left: 12, top: 100, right: 48, bottom: 136, width: 36, height: 36 };
beforeEach(async () => {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	vi.stubGlobal("document", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
	vi.stubGlobal("window", { innerHeight: 800, innerWidth: 1200, addEventListener: vi.fn(), removeEventListener: vi.fn() });
	// The rail's Scroll measures what's under its fades.
	vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
	vi.resetAllMocks();
	state.mine = {
		workspaces: [{ id: "current", name: "Current", image: null, role: "owner" }],
		invitations: [{ id: "invite", workspace: "Invited Co", invitedBy: "Owner", role: "member" }],
	};
	await act(async () => {
		root = create(createElement(WorkspaceRail), {
			createNodeMock: () => ({ getBoundingClientRect: () => bounds }),
		});
	});
});
afterEach(async () => {
	await act(async () => root?.unmount());
	vi.unstubAllGlobals();
});

/** Opens or closes the popover whose button reads `label` to screen readers. */
async function toggle(label: string) {
	const button = root.root.find(
		(n) => n.type === "button" && n.findAll((c) => c.type === "span" && c.props.className === "sr-only" && c.children.join("") === label).length > 0,
	);
	await act(async () => button.props.onClick({ currentTarget: { getBoundingClientRect: () => bounds } }));
}

it.each(["create", "accept"] as const)("waits for membership before auto-opening after %s", async (action) => {
	state[action].mockResolvedValueOnce("new-workspace");
	if (action === "create") {
		await toggle("Create a workspace");
		await act(async () => root.root.findByType("input").props.onChange({ target: { value: "New Co" } }));
		await act(async () => root.root.findByType("form").props.onSubmit({ preventDefault() {} }));
		expect(root.root.findAllByType("form")).toHaveLength(0);
	} else {
		await toggle("Invite to Invited Co");
		await act(async () => root.root.findAllByType("button").find((b) => b.children[0] === "Join")!.props.onClick());
	}
	expect(state.open).not.toHaveBeenCalled();
	state.mine = {
		workspaces: [...state.mine.workspaces, { id: "new-workspace", name: "New Co", image: null, role: "owner" }],
		invitations: [],
	};
	await act(async () => root.update(createElement(WorkspaceRail)));
	expect(state.open).toHaveBeenCalledExactlyOnceWith("new-workspace");
	expect(navigate).toHaveBeenCalledWith("chat");
	await act(async () => root.update(createElement(WorkspaceRail)));
	expect(state.open).toHaveBeenCalledOnce();
});

it("submits only one workspace creation while the first request is pending", async () => {
	state.create.mockImplementation(() => new Promise(() => {}));
	await toggle("Create a workspace");
	await act(async () => root.root.findByType("input").props.onChange({ target: { value: "New Co" } }));
	await act(async () => root.root.findByType("form").props.onSubmit({ preventDefault() {} }));
	// A second click/Enter before the first response must not create another workspace.
	await act(async () => root.root.findByType("form").props.onSubmit({ preventDefault() {} }));
	expect(state.create).toHaveBeenCalledTimes(1);
});

it("does not show an invitation failure in the unrelated create form", async () => {
	state.decline.mockRejectedValueOnce(new Error("That invite isn't available anymore."));
	await toggle("Invite to Invited Co");
	await act(async () => root.root.findAllByType("button").find((b) => b.children[0] === "Decline")!.props.onClick());
	expect(JSON.stringify(root.toJSON())).toContain("That invite isn't available anymore.");
	await toggle("Invite to Invited Co");
	await toggle("Create a workspace");
	expect(root.root.findByType("form").findAllByType("p").map((p) => p.children.join("")).join("\n"))
		.not.toContain("That invite isn't available anymore.");
});
