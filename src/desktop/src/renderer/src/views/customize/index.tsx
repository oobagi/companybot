import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import type { Role } from "@companybot/core";
import { Page } from "../../ui";
import { AgentScreen, AgentsTab } from "../Agents";
import { AutomationScreen, AutomationsTab } from "./Automations";
import { ConnectorScreen, ConnectorsTab } from "./Connectors";
import { type CustomizeTab, customizeTabs } from "./shared";
import { SkillScreen, SkillsTab } from "./Skills";

export { type CustomizeTab, customizeTabs } from "./shared";

/** A Customize tab in Settings: its list, or with `itemId`, that item's own screen. */
export function CustomizeView({ role, tab, itemId }: { role: Role; tab: CustomizeTab; itemId?: string }) {
	if (itemId) {
		if (tab === "agents") return <AgentScreen role={role} agentId={itemId as Id<"agents">} />;
		if (tab === "connectors") return <ConnectorScreen role={role} id={itemId} />;
		if (tab === "skills") return <SkillScreen role={role} id={itemId} />;
		return <AutomationScreen role={role} id={itemId} />;
	}
	return (
		<Page title={customizeTabs.find((t) => t.id === tab)!.label}>
			{tab === "agents" && <AgentsTab role={role} />}
			{tab === "connectors" && <ConnectorsTab role={role} />}
			{tab === "skills" && <SkillsTab role={role} />}
			{tab === "automations" && <AutomationsTab role={role} />}
		</Page>
	);
}
