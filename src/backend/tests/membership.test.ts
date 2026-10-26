import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../convex/_generated/api";

import { setup as ownerAndMember } from "./helpers";

afterEach(() => void vi.useRealTimers());

describe("workspaces", () => {
	it("makes the first person owner and lets invited people join as members", async () => {
		const { owner, member } = await ownerAndMember();
		expect((await owner.query(api.workspace.me))?.role).toBe("owner");
		expect((await member.query(api.workspace.me))?.role).toBe("member");
		expect((await owner.query(api.workspace.team))?.members).toHaveLength(2);
	});

	it("only lets owners invite", async () => {
		const { member } = await ownerAndMember();
		await expect(member.mutation(api.workspace.invite, { email: "x@co.com", role: "member" })).rejects.toThrow(
			"permission",
		);
	});

	it("doesn't invite people who are already in", async () => {
		const { owner } = await ownerAndMember();
		await expect(owner.mutation(api.workspace.invite, { email: "MEMBER@co.com", role: "owner" })).rejects.toThrow(
			"already a member",
		);
		await owner.mutation(api.workspace.invite, { email: "new@co.com", role: "member" });
		await expect(owner.mutation(api.workspace.invite, { email: "new@co.com", role: "member" })).rejects.toThrow(
			"already has an invite",
		);
	});
});
