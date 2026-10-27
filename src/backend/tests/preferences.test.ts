import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";

import { agentsOf, setup as ownerAndMember, noMentions, turnsOf } from "./helpers";

afterEach(() => void vi.useRealTimers());

describe("settings", () => {
	it("keeps at least one owner and applies role changes at once", async () => {
		const { owner, member } = await ownerAndMember();
		const team = (await owner.query(api.workspace.team))!;
		const me = team.members.find((m) => m.isYou)!;
		const them = team.members.find((m) => !m.isYou)!;
		await expect(owner.mutation(api.workspace.setRole, { id: me.id, role: "member" })).rejects.toThrow("at least one owner");
		await owner.mutation(api.workspace.setRole, { id: them.id, role: "owner" });
		expect((await member.query(api.workspace.me))?.role).toBe("owner");
	});

	it("refuses a stale workspace rename", async () => {
		const { owner } = await ownerAndMember();
		await owner.mutation(api.workspace.updateSettings, { name: "Acme", expectedVersion: 1 });
		await expect(owner.mutation(api.workspace.updateSettings, { name: "Other", expectedVersion: 1 })).rejects.toThrow();
		expect((await owner.query(api.workspace.settings))?.name).toBe("Acme");
	});

	it("keeps preferences personal", async () => {
		const { owner, member } = await ownerAndMember();
		await owner.mutation(api.preferences.update, { displayName: "Jaden", sendWith: "mod-enter" });
		expect(await owner.query(api.preferences.get)).toEqual({
			displayName: "Jaden",
			sendWith: "mod-enter",
			notify: "all",
			timeZone: null,
			deviceTimeZone: null,
			image: null,
		});
		expect((await member.query(api.preferences.get)).displayName).toBe("");
		expect((await member.query(api.workspace.team))?.members.map((m) => m.name)).toContain("Jaden");
	});
});

describe("time zones", () => {
	it("defaults to the computer's zone, lets people pick one, and tells agents", async () => {
		const { t, owner } = await ownerAndMember();
		const { companybot } = await agentsOf(owner);
		const timeZoneOfOwner = async () => (await owner.query(api.workspace.team))!.members.find((m) => m.isYou)!.timeZone;
		expect(await timeZoneOfOwner()).toBe("UTC");

		await owner.mutation(api.preferences.update, { deviceTimeZone: "Europe/Paris" });
		expect(await owner.query(api.preferences.get)).toMatchObject({ timeZone: null, deviceTimeZone: "Europe/Paris" });
		expect(await timeZoneOfOwner()).toBe("Europe/Paris");

		await owner.mutation(api.preferences.update, { timeZone: "America/Los_Angeles" });
		expect(await timeZoneOfOwner()).toBe("America/Los_Angeles");
		const chatId = await owner.mutation(api.chats.openDm, { userIds: [], agentIds: [companybot._id] });
		await owner.mutation(api.messages.send, { chatId, text: "What time is it?", mentions: noMentions });
		const [turn] = await turnsOf(t);
		expect((await t.query(internal.turns.turnContext, { turnId: turn!._id })).actor.timeZone).toBe("America/Los_Angeles");

		await owner.mutation(api.preferences.update, { timeZone: null });
		expect(await timeZoneOfOwner()).toBe("Europe/Paris");
		await expect(owner.mutation(api.preferences.update, { timeZone: "Mars/Base" })).rejects.toThrow("Unknown time zone");
	});

});
