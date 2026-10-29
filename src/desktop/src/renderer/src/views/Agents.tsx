import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import { type AgentConfig, agentConfigKeys, pickAgentConfig } from "@companybot/core/agent-config";
import { type Role, can } from "@companybot/core/permissions";
import type { FunctionReturnType } from "convex/server";
import { useState } from "react";
import { api } from "../api";
import { useMutation, useQuery } from "../convex";
import { Checkbox } from "../controls";
import { navigate } from "../router";
import { ItemList, Missing, customizeCrumbs } from "./customize/shared";
import { ImagePicker } from "./ImagePicker";
import { modelNote } from "@companybot/core/models";
import { ModelPicker } from "./ModelPicker";
import { TrashNotice } from "./Trash";
import { AgentIcon, TrashIcon } from "../icons";
import { ConflictNotice, type Crumb, Field, Loading, Notice, Page, SaveBar, Section, barDangerButton, cardClass, descriptionClass, inputClass, metadataClass, timeAgo, useDraft, useRun } from "../ui";

type Agent = FunctionReturnType<typeof api.agents.list>[number];

export function AgentsTab() {
	const agents = useQuery(api.agents.list);
	const open = (id: Id<"agents">) => navigate("settings", "agents", id);

	if (!agents) return <Loading />;

	return (
		<ItemList
			items={agents}
			icon={<AgentIcon />} title="No agents yet" empty="Add a teammate to help with your team's work."
			card={(a) => <AgentRow key={a._id} agent={a} onOpen={() => open(a._id)} />}
		/>
	);
}

function AgentRow({ agent, onOpen }: { agent: Agent; onOpen: () => void }) {
	return (
		<button
			type="button"
			onClick={onOpen}
			className={`flex flex-col gap-0.5 text-left hover:bg-neutral-50 ${cardClass}`}
		>
			<span className="font-medium">{agent.name}</span>
			{agent.description && <span className={descriptionClass}>{agent.description}</span>}
			<span className={metadataClass}>
				{agent.model.replace("anthropic/", "")} · v{agent.version} · edited by {agent.updatedByName}{" "}
				{timeAgo(agent.updatedAt)}
			</span>
		</button>
	);
}

/** One agent's own screen, pushed over the agents list. */
export function AgentScreen({ role, agentId }: { role: Role; agentId: Id<"agents"> }) {
	const agents = useQuery(api.agents.list);
	const agent = agents?.find((a) => a._id === agentId);
	const back = customizeCrumbs("agents");
	if (!agent) return <Missing tab="agents" loaded={!!agents} />;
	return <AgentEditor key={agent._id} agent={agent} isOwner={can(role, "agents.manage")} back={back} />;
}

function AgentEditor({ agent, isOwner, back }: { agent: Agent; isOwner: boolean; back: Crumb[] }) {
	const options = useQuery(api.agents.options);
	const update = useMutation(api.agents.update);
	const remove = useMutation(api.trash.move);
	const draft = useDraft(pickAgentConfig(agent), agent.version);
	const { error, run } = useRun();
	const config = draft.value;
	const edit = (changes: Partial<AgentConfig>) => draft.set({ ...config, ...changes });
	const access = new Map(agent.access.map((a) => [a.id, a]));

	if (!options) {
		return (
			<Page title={agent.name} crumbs={back}>
				<Loading />
			</Page>
		);
	}

	return (
		<Page
			title={agent.name}
			description={`v${agent.version} · edited by ${agent.updatedByName} ${timeAgo(agent.updatedAt)}`}
			crumbs={back}
			actions={
				isOwner && !agent.archived && (
					<button
						type="button"
						onClick={() => run(remove({ kind: "agent", id: agent._id }), () => navigate("settings", "agents"))}
						className={barDangerButton}
					>
						<TrashIcon /> Delete
					</button>
				)
			}
		>
			{agent.trash && <TrashNotice trash={agent.trash} />}
			<ConflictNotice draft={draft} who={agent.updatedByName} />
			<Notice>{error}</Notice>

			<fieldset disabled={!isOwner || agent.archived} className="flex flex-col gap-5">
				{/* Not a Field: its <label> would name the picker's buttons. */}
				<div className="flex flex-col gap-1.5">
					<span className="text-sm font-medium">Picture</span>
					<ImagePicker of={agent._id} name={agent.name} image={agent.image} agent disabled={!isOwner || agent.archived} />
					<span className="text-xs text-neutral-500">PNG, JPEG, WebP or GIF, up to 2 MB.</span>
				</div>
				<Field label="Name">
					<input className={inputClass} value={config.name} onChange={(e) => edit({ name: e.target.value })} />
				</Field>
				<Field label="Description" hint="Shown to your team in the agent switcher.">
					<input
						className={inputClass}
						value={config.description}
						onChange={(e) => edit({ description: e.target.value })}
					/>
				</Field>
				<ModelPicker label="Model" note={modelNote} models={options.models} defaultModel={options.defaultModel} value={config.model} onChange={(model) => edit({ model })} />
				<div className="flex flex-col gap-1.5">
					<span className="text-sm font-medium">Tools</span>
					{options.groups.map((g) => (
						<ToolGroup key={g.id} group={g} grants={config.tools} isOwner={isOwner} access={access} onChange={(tools) => edit({ tools })} />
					))}
				</div>
				<Field label="Instructions" hint="Changes apply from the agent's next reply.">
					<textarea
						rows={10}
						className={`${inputClass} resize-y font-mono text-sm leading-relaxed`}
						value={config.instructions}
						onChange={(e) => edit({ instructions: e.target.value })}
					/>
				</Field>
			</fieldset>

			{isOwner && !agent.archived && draft.dirty && (
				<SaveBar
					onDiscard={draft.discard}
					onSave={() => run(update({ agentId: agent._id, expectedVersion: draft.base, config }), draft.discard)}
				/>
			)}

			<History agent={agent} isOwner={isOwner && !agent.archived} />
		</Page>
	);
}

type Options = FunctionReturnType<typeof api.agents.options>;

const hiddenReasons: Record<string, string> = {
	role: "Hidden from your role",
	not_installed: "Connector not installed",
	not_connected: "Not connected",
	not_found: "Missing",
};

/**
 * One group of tools. "All" grants the whole group ("memory.*"), which also
 * covers tools added to it later. Connectors are always granted whole.
 */
function ToolGroup({
	group,
	grants,
	isOwner,
	access,
	onChange,
}: {
	group: Options["groups"][number];
	grants: string[];
	isOwner: boolean;
	access: Map<string, Agent["access"][number]>;
	onChange: (tools: string[]) => void;
}) {
	// A one-tool group is granted by its tool id; bigger groups and connectors by "<group>.*".
	const single = group.tools.length === 1 ? group.tools[0]?.id : undefined;
	const all = single ?? `${group.id}.*`;
	const whole = grants.includes(all) || grants.includes(`${group.id}.*`);
	const inGroup = (id: string) => id === all || id.startsWith(`${group.id}.`);
	const status = (id: string) => {
		const a = access.get(id);
		if (!a || isOwner) return null;
		return <span className={metadataClass}>{a.visible ? "You can use" : hiddenReasons[a.reason]}</span>;
	};
	return (
		<div className="flex flex-col rounded-xl border border-neutral-200">
			<label className="flex items-center gap-3 px-3 py-2">
				<Checkbox checked={whole} onChange={() => onChange(whole ? grants.filter((x) => !inGroup(x)) : [...grants.filter((x) => !inGroup(x)), all])} />
				<span className="flex-1 text-sm font-medium">
					{group.connector ? `${group.name} (connector)` : group.name}
					{group.tools.length > 1 && <span className="ml-2 font-normal text-neutral-400">all, including future ones</span>}
				</span>
				{status(all)}
			</label>
			{group.tools.length > 1 &&
				group.tools.map((t) => {
					const on = whole || grants.includes(t.id);
					return (
						<label key={t.id} className="flex items-start gap-3 border-t border-neutral-100 py-2 pr-3 pl-9">
							<Checkbox className="mt-0.5" checked={on} disabled={whole} onChange={() => onChange(on ? grants.filter((x) => x !== t.id) : [...grants, t.id])} />
							<span className="flex flex-1 flex-col">
								<span className="text-sm">
									<code>{t.id}</code>
									{t.ownersOnly && <span className="ml-2 text-xs text-neutral-400">owners only</span>}
								</span>
								<span className="text-xs text-neutral-500">{t.description}</span>
							</span>
							{on && status(t.id)}
						</label>
					);
				})}
		</div>
	);
}

function History({ agent, isOwner }: { agent: Agent; isOwner: boolean }) {
	const versions = useQuery(api.agents.history, { agentId: agent._id });
	const restore = useMutation(api.agents.restore);
	const [openVersion, setOpenVersion] = useState<number>();
	const { error, run } = useRun();
	if (!versions) return null;

	return (
		<Section title="History" hint="Every save is kept. Restoring saves an old version as the newest one.">
			<Notice>{error}</Notice>
			{versions.map((v, i) => {
				const previous = versions[i + 1]?.config;
				const changed = previous
					? agentConfigKeys.filter((k) => JSON.stringify(v.config[k]) !== JSON.stringify(previous[k]))
					: [];
				return (
					<div key={v.version} className="rounded-xl border border-neutral-200 px-4 py-2.5 text-sm">
						<div className="flex items-center gap-3">
							<span className="flex-1">
								<span className="font-medium">v{v.version}</span>{" "}
								<span className="text-neutral-500">
									· {v.savedByName} · {timeAgo(v.savedAt)}
									{previous ? ` · changed ${changed.join(", ") || "nothing"}` : " · created"}
								</span>
							</span>
							<button
								type="button"
								onClick={() => setOpenVersion(openVersion === v.version ? undefined : v.version)}
								className="text-neutral-500 hover:text-neutral-900"
							>
								{openVersion === v.version ? "Hide" : "View"}
							</button>
							{v.version === agent.version ? (
								<span className="text-neutral-400">Current</span>
							) : (
								isOwner && (
									<button
										type="button"
										onClick={() =>
											run(restore({ agentId: agent._id, version: v.version, expectedVersion: agent.version }))
										}
										className="font-medium hover:underline"
									>
										Restore
									</button>
								)
							)}
						</div>
						{openVersion === v.version && (
							<div className="mt-2 flex flex-col gap-1 border-t border-neutral-100 pt-2 text-neutral-600">
								<p>
									<b>{v.config.name}</b> · {v.config.model.replace("anthropic/", "")} · {v.config.tools.join(", ") || "no tools"}
								</p>
								<pre className="whitespace-pre-wrap font-mono text-xs">{v.config.instructions || "(no instructions)"}</pre>
							</div>
						)}
					</div>
				);
			})}
		</Section>
	);
}
