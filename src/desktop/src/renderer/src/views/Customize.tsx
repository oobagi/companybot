import type { Role } from "@companybot/core";
import { useMutation } from "convex/react";
import { useQuery } from "convex-helpers/react/cache";
import { api } from "../api";
import { Loading, Notice, Page, Tabs, useAction } from "../ui";
import { AgentsTab } from "./Agents";

const tabs = [
	{ id: "agents", label: "Agents" },
	{ id: "plugins", label: "Plugins" },
	{ id: "skills", label: "Skills" },
] as const;
export type CustomizeTab = (typeof tabs)[number]["id"];

export function CustomizeView({ role, tab, onTab }: { role: Role; tab: CustomizeTab; onTab: (tab: CustomizeTab) => void }) {
	return (
		<Page title="Customize" subtitle="Shape your agents, connect your tools, and teach new skills.">
			<Tabs tabs={tabs} value={tab} onChange={onTab} />
			{tab === "agents" && <AgentsTab role={role} />}
			{tab === "plugins" && <PluginsTab role={role} />}
			{tab === "skills" && <SkillsTab role={role} />}
		</Page>
	);
}

function PluginsTab({ role }: { role: Role }) {
	const plugins = useQuery(api.plugins.list);
	const setPlugin = useMutation(api.plugins.setInstalled);
	const { error, run } = useAction();
	if (!plugins) return <Loading />;
	return (
		<>
			<p className="text-sm text-neutral-500">Connect outside services like Gmail or Calendar.</p>
			{error && <Notice>{error}</Notice>}
			{plugins.length === 0 && <p className="text-sm text-neutral-400">No plugins available yet.</p>}
			{plugins.map((p) => (
				<Card
					key={p.id}
					title={p.name}
					meta={`${p.publisher} · v${p.version}`}
					description={p.description}
					installed={p.installed}
					canManage={role === "owner"}
					onToggle={() => run(setPlugin({ pluginId: p.id, installed: !p.installed }))}
				/>
			))}
		</>
	);
}

function SkillsTab({ role }: { role: Role }) {
	const skills = useQuery(api.skills.list);
	const setSkill = useMutation(api.skills.setInstalled);
	const { error, run } = useAction();
	if (!skills) return <Loading />;
	return (
		<>
			<p className="text-sm text-neutral-500">Instructions your agents load when a task calls for them.</p>
			{error && <Notice>{error}</Notice>}
			{skills.map((s) => (
				<Card
					key={s.id}
					title={s.name}
					meta={`v${s.version}`}
					description={s.description}
					installed={s.installed}
					canManage={role === "owner"}
					onToggle={() => run(setSkill({ skillId: s.id, installed: !s.installed }))}
				/>
			))}
		</>
	);
}

function Card(props: {
	title: string;
	meta: string;
	description: string;
	installed: boolean;
	canManage: boolean;
	onToggle: () => void;
}) {
	return (
		<div className="flex items-start justify-between gap-4 rounded-xl border border-neutral-200 p-4">
			<div>
				<h3 className="font-medium">
					{props.title} <span className="text-xs font-normal text-neutral-400">{props.meta}</span>
				</h3>
				<p className="text-sm text-neutral-500">{props.description}</p>
			</div>
			<button
				type="button"
				disabled={!props.canManage}
				title={props.canManage ? undefined : "Only owners can install"}
				onClick={props.onToggle}
				className={`shrink-0 rounded-full px-3 py-1 text-sm disabled:opacity-50 ${
					props.installed ? "border border-neutral-200 text-neutral-600" : "bg-neutral-900 text-white"
				}`}
			>
				{props.installed ? "Installed" : "Install"}
			</button>
		</div>
	);
}
