import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import { type AgentConfig, type Reasoning, agentConfigKeys, defaultReasoning, pickAgentConfig } from "@companybot/core/agent-config";
import { type Access, can } from "@companybot/core/permissions";
import type { FunctionReturnType } from "convex/server";
import { useState } from "react";
import { api } from "../api";
import { useMutation, useQuery } from "../convex";
import { Checkbox, Segmented } from "../controls";
import { navigate } from "../router";
import { ItemList, Missing, customizeCrumbs } from "./customize/shared";
import { ImagePicker } from "./ImagePicker";
import { pictureLimits } from "@companybot/core/images";
import { modelNote } from "@companybot/core/models";
import { ModelPicker } from "./ModelPicker";
import { AgentContact } from "./AgentContact";
import { Choice, Topics } from "./chat/AgentPanel";
import { MarkdownEditor } from "./pages/PageEditor";
import { archiveQuestion, useConfirm } from "./chat/common";
import { TrashNotice } from "./Trash";
import { AgentIcon, ArchiveIcon, CaretDownIcon, CaretRightIcon, RestoreIcon } from "../icons";
import { ConflictNotice, type Crumb, Loading, Notice, Page, SaveBar, Section, Setting, Settings, barButton, cardClass, compactButton, compactControlClass, descriptionClass, metadataClass, timeAgo, useDraft, useRun, wideControlClass, cardButton } from "../ui";

type Agent = FunctionReturnType<typeof api.agents.list>[number];

const reasoningOptions: { value: Reasoning; label: string }[] = [
	{ value: "none", label: "Off" },
	{ value: "low", label: "Low" },
	{ value: "medium", label: "Medium" },
	{ value: "high", label: "High" },
];

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
			className={`flex-col gap-0.5 ${cardButton}`}
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
export function AgentScreen({ access, agentId }: { access: Access; agentId: Id<"agents"> }) {
	const agents = useQuery(api.agents.list);
	const agent = agents?.find((a) => a._id === agentId);
	const back = customizeCrumbs("agents");
	if (!agent) return <Missing tab="agents" loaded={!!agents} />;
	return <AgentEditor key={agent._id} agent={agent} canManage={can(access, "agents.manage")} back={back} />;
}

function AgentEditor({ agent, canManage, back }: { agent: Agent; canManage: boolean; back: Crumb[] }) {
	const options = useQuery(api.agents.options);
	const update = useMutation(api.agents.update);
	const remove = useMutation(api.trash.move);
	const { confirm, dialog } = useConfirm();
	const draft = useDraft(`agent:${agent._id}`, pickAgentConfig(agent), agent.version);
	const { error, run } = useRun();
	const editable = canManage && !agent.archived;
	const config = editable ? draft.value : pickAgentConfig(agent);
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
				canManage && !agent.archived && (
					<button
						type="button"
						onClick={() => confirm(archiveQuestion(agent.name, () => remove({ kind: "agent", id: agent._id }).then(() => navigate("settings", "agents")), "The agent will stop responding."))}
						className={barButton}
					>
						<ArchiveIcon /> Archive
					</button>
				)
			}
		>
			{dialog}
			{agent.trash && <TrashNotice trash={agent.trash} />}
			{editable && <ConflictNotice draft={draft} who={agent.updatedByName} />}
			<Notice>{error}</Notice>

			<fieldset disabled={!canManage || agent.archived} className="flex flex-col gap-5">
				<Settings title="Agent">
					<Setting label="Picture" hint={`${pictureLimits}.`}>
						<ImagePicker of={agent._id} name={agent.name} image={agent.image} agent disabled={!canManage || agent.archived} />
					</Setting>
					<Setting label="Name">
						<input aria-label="Name" className={wideControlClass} value={config.name} onChange={(e) => edit({ name: e.target.value })} />
					</Setting>
					<Setting label="Description" hint="Shown to your team in the agent switcher.">
						<input aria-label="Description" className={wideControlClass} value={config.description} onChange={(e) => edit({ description: e.target.value })} />
					</Setting>
					<Setting label="Model">
						<ModelPicker note={modelNote} models={options.models} defaultModel={options.defaultModel} value={config.model} onChange={(model) => edit({ model })} />
					</Setting>
					<Setting label="Reasoning" hint="How hard it thinks before answering. Higher is slower and costs more, but handles harder work.">
						<Segmented label="Reasoning" value={config.reasoning ?? defaultReasoning} options={reasoningOptions} onChange={(reasoning) => edit({ reasoning })} />
					</Setting>
					<Setting wide label="Instructions" hint="What it should know and how it should work. Type / for headings and lists. Changes apply from the agent's next reply.">
						<div className="w-full rounded-lg border border-neutral-200 py-2 pr-3">
							{/* Keyed by version: a save or restore loads the new text; typing doesn't. */}
							<MarkdownEditor key={`${agent.version}:${draft.dirty ? "draft" : "saved"}`} label="Instructions" markdown={config.instructions} editable={editable} onChange={(instructions) => edit({ instructions })} />
						</div>
					</Setting>
				</Settings>
				<Settings title="When a customer emails or texts it">
					<Setting wide label="Replies" hint="Customers reach it at the email address or phone number below.">
						<div className="w-full">
							<Choice picked={config.customerReplies ?? "check"} disabled={!editable} name={config.name || "It"} onPick={(customerReplies) => edit({ customerReplies })} />
						</div>
					</Setting>
					<Setting wide label="Topics it never answers" hint={`${config.name || "It"} sends these conversations to your team instead of replying.`}>
						<div className="w-full">
							<Topics topics={config.handOffTopics ?? []} disabled={!editable} onChange={(handOffTopics) => edit({ handOffTopics })} />
						</div>
					</Setting>
				</Settings>
				<AgentContact agentId={agent._id} agentName={agent.name} canManage={canManage && !agent.archived} />
				<Section title="Tools">
					{options.groups.map((g) => (
						<ToolGroup key={g.id} group={g} grants={config.tools} canManage={canManage} access={access} onChange={(tools) => edit({ tools })} />
					))}
				</Section>
			</fieldset>

			{canManage && !agent.archived && (
				<SaveBar
					dirty={draft.dirty}
					onDiscard={draft.discard}
					onSave={() => run(update({ agentId: agent._id, expectedVersion: draft.base, config }), draft.discard)}
				/>
			)}

			<History agent={agent} canManage={canManage && !agent.archived} />
		</Page>
	);
}

type Options = FunctionReturnType<typeof api.agents.options>;

const hiddenReasons: Record<string, string> = {
	role: "None of your roles can use it",
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
	canManage,
	access,
	onChange,
}: {
	group: Options["groups"][number];
	grants: string[];
	canManage: boolean;
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
		if (!a || canManage) return null;
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
									{t.needs && <span className="ml-2 text-xs text-neutral-400">needs a role that can {t.needs}</span>}
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

function History({ agent, canManage }: { agent: Agent; canManage: boolean }) {
	const versions = useQuery(api.agents.history, { agentId: agent._id });
	const restore = useMutation(api.agents.restore);
	const [openVersion, setOpenVersion] = useState<number>();
	const { error, run } = useRun();
	if (!versions) return null;

	return (
		<Section title="History" note="Every save is kept. Restoring saves an old version as the newest one.">
			<Notice>{error}</Notice>
			{versions.map((v, i) => {
				// Picked, so versions from before reasoning existed read as the default it ran with.
				const config = pickAgentConfig(v.config);
				const before = versions[i + 1];
				const previous = before && pickAgentConfig(before.config);
				const changed = previous
					? agentConfigKeys.filter((k) => JSON.stringify(config[k]) !== JSON.stringify(previous[k]))
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
								aria-expanded={openVersion === v.version}
								className={compactButton}
							>
								{openVersion === v.version ? <CaretDownIcon /> : <CaretRightIcon />}
								{openVersion === v.version ? "Hide" : "View"}
							</button>
							{v.version === agent.version ? (
								<span className="text-neutral-400">Current</span>
							) : (
								canManage && (
									<button
										type="button"
										onClick={() =>
											run(restore({ agentId: agent._id, version: v.version, expectedVersion: agent.version }))
										}
										className={compactButton}
									>
										<RestoreIcon /> Restore
									</button>
								)
							)}
						</div>
						{openVersion === v.version && (
							<div className="mt-2 flex flex-col gap-1 border-t border-neutral-100 pt-2 text-neutral-600">
								<p>
									<b>{config.name}</b> · {config.model.replace("anthropic/", "")} · {reasoningOptions.find((o) => o.value === config.reasoning)?.label} reasoning · {config.tools.join(", ") || "no tools"}
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
