import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import { type Role, can } from "@companybot/core/permissions";
import { api } from "../../api";
import { useMutation } from "../../convex";
import { navigate } from "../../router";
import { NewButton, Notice, Page, useRun } from "../../ui";
import { AgentScreen, AgentsTab } from "../Agents";
import { AutomationScreen, AutomationsTab } from "./Automations";
import { ConnectorScreen, ConnectorsTab } from "./Connectors";
import { type CustomizeTab, customizeTabs } from "./shared";
import { SkillScreen, SkillsTab } from "./Skills";

export { type CustomizeTab, customizeTabs } from "./shared";

/** The tab's list, or with `itemId`, that item's own screen. */
export function CustomizeView({ role, tab, itemId }: { role: Role; tab: CustomizeTab; itemId?: string }) {
	const createAgent = useMutation(api.agents.create);
	const { error, run } = useRun();
	const current = customizeTabs.find((t) => t.id === tab)!;
	if (itemId) {
		if (tab === "agents") return <AgentScreen role={role} agentId={itemId as Id<"agents">} />;
		if (tab === "connectors") return <ConnectorScreen role={role} id={itemId} />;
		if (tab === "skills") return <SkillScreen role={role} id={itemId} />;
		return <AutomationScreen role={role} id={itemId} />;
	}
	return (
		<Page title={current.label} description={current.description} actions={{
			agents: can(role, "agents.manage") && <NewButton label="New agent" onClick={() => run(createAgent().then((id) => navigate("settings", "agents", id)))} />,
			connectors: null,
			skills: can(role, "skills.create") && <NewButton label="New skill" onClick={() => navigate("settings", "skills", "new")} />,
			automations: can(role, "automations.create") && <NewButton label="New automation" onClick={() => navigate("settings", "automations", "new")} />,
		}[tab]}>
			<Notice>{error}</Notice>
			{tab === "agents" && <AgentsTab />}
			{tab === "connectors" && <ConnectorsTab role={role} />}
			{tab === "skills" && <SkillsTab />}
			{tab === "automations" && <AutomationsTab />}
		</Page>
	);
}
