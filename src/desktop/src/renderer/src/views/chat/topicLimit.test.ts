// Channel topic inputs stop at the server's cap (core TOPIC_MAX), so nobody types past what saves.
import { TOPIC_MAX } from "@companybot/core/chat";
import { act, createElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ChannelDetails, CreateChannel } from "./dialogs";
import type { ChatDetails } from "./data";
import { inApp } from "../../testing";

vi.mock("../../convex", () => ({ useQuery: () => undefined, useMutation: () => vi.fn(async () => {}) }));
vi.mock("./common", async (actual) => ({
	...(await actual<typeof import("./common")>()),
	Modal: ({ children }: { children: React.ReactNode }) => createElement("div", null, children),
	useConfirm: () => ({ confirm: vi.fn(), dialog: null }),
}));
vi.mock("../access", () => ({ WhoCanAccess: () => null }));

let root: ReactTestRenderer;
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(async () => {
	await act(async () => root?.unmount());
	vi.unstubAllGlobals();
});
const topicInputs = () => root.root.findAll((n) => n.type === "input" && n.props.maxLength !== undefined);

it("stops the new channel's topic at 250 characters", async () => {
	await act(async () => { root = create(inApp(createElement(CreateChannel, { onClose: () => {}, onOpen: () => {} }))); });
	expect(topicInputs().map((i) => i.props.maxLength)).toEqual([TOPIC_MAX]);
	expect(TOPIC_MAX).toBe(250);
});

it("stops an existing channel's topic at 250 characters", async () => {
	const chat = { _id: "c1", kind: "channel", name: "ops", topic: "Day to day", canManage: true, isDefault: false, replyMode: "mentions", members: [], access: null } as unknown as ChatDetails;
	await act(async () => { root = create(inApp(createElement(ChannelDetails, { chat, onClose: () => {}, onLeft: () => {} }))); });
	expect(topicInputs().map((i) => i.props.maxLength)).toEqual([TOPIC_MAX]);
});
