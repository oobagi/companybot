import { type AutomationAudience, findAutomation } from "@companybot/core";
import type { Doc } from "./_generated/dataModel";
import type { Member } from "./lib";

/**
 * Installs from before audiences: a channel if one was picked, else people who turn it on.
 * COMPAT(0.1.0-alpha.6): the automationAudiences migration sets `audience` on every install. After it has run on prod, make `audience` required and drop this fallback.
 */
export const audienceOf = (install: Doc<"automationInstalls">): AutomationAudience =>
	install.audience ?? (install.channelId ? "channel" : "subscribers");

/** Automations that run just for their creator are theirs alone; the rest are visible to the workspace. */
export const canView = (member: Member, install: Doc<"automationInstalls">) =>
	!install.custom || audienceOf(install) !== "creator" || install.installedBy === member.userId;

export function automationName(install: Doc<"automationInstalls">) {
	if (install.custom) return install.custom.name;
	return findAutomation(install.automationId)?.name ?? install.automationId;
}

