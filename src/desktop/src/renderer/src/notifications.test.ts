import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import { beforeEach, expect, it, vi } from "vitest";
import { openAlert } from "./notifications";
import { navigate } from "./router";

vi.mock("./router", () => ({ navigate: vi.fn() }));
vi.mock("./desktop", () => ({ desktop: undefined }));

const acme = "acme" as Id<"workspaces">;
const side = "side" as Id<"workspaces">;
const chatId = "chat" as Id<"chats">;
const joined = [acme, side];
const workspace = (id: Id<"workspaces">) => ({ id, open: vi.fn((next: Id<"workspaces">) => joined.includes(next)) });

beforeEach(() => vi.mocked(navigate).mockClear());

it("opens the chat in the workspace that's open", () => {
	const open = workspace(acme);
	openAlert({ workspaceId: acme, chatId }, open);
	expect(open.open).toHaveBeenCalledWith(acme);
	expect(navigate).toHaveBeenCalledWith("chat", chatId);
});

it("switches back to the alert's workspace first, after the window moved on", () => {
	const open = workspace(side);
	openAlert({ workspaceId: acme, chatId }, open);
	expect(open.open).toHaveBeenCalledWith(acme);
	expect(navigate).toHaveBeenCalledWith("chat", chatId);
});

it("stays put for a workspace you're no longer in", () => {
	const open = workspace(side);
	openAlert({ workspaceId: "gone" as Id<"workspaces">, chatId }, open);
	expect(navigate).not.toHaveBeenCalled();
});
