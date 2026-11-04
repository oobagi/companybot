import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import { type Access, can } from "@companybot/core/permissions";
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
export function CustomizeView({ access, tab, itemId }: { access: Access; tab: CustomizeTab; itemId?: string }) {
	const createAgent = useMutation(api.agents.create);
	const { error, run } = useRun();
	const current = customizeTabs.find((t) => t.id === tab)!;
	if (itemId) {
		if (tab === "agents") return <AgentScreen access={access} agentId={itemId as Id<"agents">} />;
		if (tab === "connectors") return <ConnectorScreen access={access} id={itemId} />;
		if (tab === "skills") return <SkillScreen access={access} id={itemId} />;
		return <AutomationScreen access={access} id={itemId} />;
	}
	return (
		<Page title={current.label} description={current.description} actions={{
			agents: can(access, "agents.manage") && <NewButton label="New agent" onClick={() => run(createAgent({}).then((id) => navigate("settings", "agents", id)))} />,
			connectors: null,
			skills: <NewButton label="New skill" onClick={() => navigate("settings", "skills", "new")} />,
			// Everyone: a personal one needs no switch (the form offers sharing only to those who can).
			automations: <NewButton label="New automation" onClick={() => navigate("settings", "automations", "new")} />,
		}[tab]}>
			<Notice>{error}</Notice>
			{tab === "agents" && <AgentsTab />}
			{tab === "connectors" && <ConnectorsTab access={access} />}
			{tab === "skills" && <SkillsTab />}
			{tab === "automations" && <AutomationsTab />}
		</Page>
	);
}
