import type { Role, ToolAccess } from "@companybot/core";
import { useMutation } from "convex/react";
import { useQuery } from "convex-helpers/react/cache";
import { useState } from "react";
import { api, errorMessage } from "../api";
import { Loading, Notice } from "./Chat";
import { Page } from "./Memory";

interface AgentAccess {
	id: string;
	name: string;
	tools: ToolAccess[];
}

export function CustomizeView({ role, agents }: { role: Role; agents: AgentAccess[] }) {
	const plugins = useQuery(api.plugins.list);
	const skills = useQuery(api.skills.list);
	const setPlugin = useMutation(api.plugins.setInstalled);
	const setSkill = useMutation(api.skills.setInstalled);
	const [error, setError] = useState<string>();
	const isOwner = role === "owner";
	const run = (action: Promise<unknown>) =>
		action.then(
			() => setError(undefined),
			(e) => setError(errorMessage(e)),
		);

	if (!plugins || !skills) return <Loading />;

	return (
		<Page title="Customize" subtitle="Connect your tools and teach your agents new skills.">
			{error && <Notice>{error}</Notice>}

			<Section title="Plugins" hint="Connect outside services like Gmail or Calendar.">
				{plugins?.length === 0 && <p className="text-sm text-neutral-400">No plugins available yet.</p>}
				{plugins?.map((p) => (
					<Card
						key={p.id}
						title={p.name}
						meta={`${p.publisher} · v${p.version}`}
						description={p.description}
						installed={p.installed}
						canManage={isOwner}
						onToggle={() => run(setPlugin({ pluginId: p.id, installed: !p.installed }))}
					/>
				))}
			</Section>

			<Section title="Skills" hint="Instructions your agents load when a task calls for them.">
				{skills?.map((s) => (
					<Card
						key={s.id}
						title={s.name}
						meta={`v${s.version}`}
						description={s.description}
						installed={s.installed}
						canManage={isOwner}
						onToggle={() => run(setSkill({ skillId: s.id, installed: !s.installed }))}
					/>
				))}
			</Section>

			<Section title="Agent access" hint="Built-in tools each agent can use for you.">
				{agents.map((a) => (
					<div key={a.id} className="rounded-xl border border-neutral-200 px-4 py-3">
						<p className="mb-2 font-medium">{a.name}</p>
						<ul className="flex flex-wrap gap-1.5">
							{a.tools.map((t) => (
								<li
									key={t.id}
									className={`rounded-md px-2 py-0.5 text-xs ${
										t.visible ? "bg-emerald-50 text-emerald-700" : "bg-neutral-100 text-neutral-400"
									}`}
								>
									{t.visible ? t.id : <s>{t.id}</s>}
									{!t.visible && ` (${t.reason === "role" ? "owners only" : "missing"})`}
								</li>
							))}
						</ul>
					</div>
				))}
			</Section>
		</Page>
	);
}

function Section({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }) {
	return (
		<section className="flex flex-col gap-2">
			<div>
				<h2 className="font-medium">{title}</h2>
				<p className="text-sm text-neutral-500">{hint}</p>
			</div>
			{children}
		</section>
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
