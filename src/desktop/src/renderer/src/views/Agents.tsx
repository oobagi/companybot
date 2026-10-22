import type { AgentConfig, Role } from "@companybot/core";
import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import { useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useQuery } from "convex-helpers/react/cache";
import { useState } from "react";
import { api } from "../api";
import {
	ConflictNotice,
	Field,
	Loading,
	Notice,
	SaveBar,
	Section,
	inputClass,
	secondaryButton,
	timeAgo,
	useAction,
	useDraft,
} from "../ui";

type Agent = FunctionReturnType<typeof api.agents.list>[number];

export function AgentsTab({ role }: { role: Role }) {
	const agents = useQuery(api.agents.list);
	const create = useMutation(api.agents.create);
	const [openId, setOpenId] = useState<Id<"agents">>();
	const { error, run } = useAction();
	const isOwner = role === "owner";

	if (!agents) return <Loading />;
	const open = agents.find((a) => a._id === openId);
	if (open) return <AgentEditor key={open._id} agent={open} isOwner={isOwner} onBack={() => setOpenId(undefined)} />;

	const active = agents.filter((a) => !a.archived);
	const archived = agents.filter((a) => a.archived);

	return (
		<>
			<div className="flex items-center justify-between gap-4">
				<p className="text-sm text-neutral-500">
					{isOwner ? "Edit what each agent knows and can do." : "Only owners can change agents."}
				</p>
				{isOwner && (
					<button
						type="button"
						className={secondaryButton}
						onClick={() => run(create().then(setOpenId))}
					>
						New agent
					</button>
				)}
			</div>
			{error && <Notice>{error}</Notice>}
			{active.map((a) => (
				<AgentRow key={a._id} agent={a} onOpen={() => setOpenId(a._id)} />
			))}
			{archived.length > 0 && (
				<Section title="Archived" hint="Hidden from chat. Their conversations and memories are kept.">
					{archived.map((a) => (
						<AgentRow key={a._id} agent={a} onOpen={() => setOpenId(a._id)} />
					))}
				</Section>
			)}
		</>
	);
}

function AgentRow({ agent, onOpen }: { agent: Agent; onOpen: () => void }) {
	return (
		<button
			type="button"
			onClick={onOpen}
			className="flex flex-col gap-0.5 rounded-xl border border-neutral-200 px-4 py-3 text-left hover:bg-neutral-50"
		>
			<span className="font-medium">{agent.name}</span>
			{agent.description && <span className="text-sm text-neutral-500">{agent.description}</span>}
			<span className="text-xs text-neutral-400">
				{agent.model.replace("anthropic/", "")} · v{agent.version} · edited by {agent.updatedByName}{" "}
				{timeAgo(agent.updatedAt)}
			</span>
		</button>
	);
}

const configOf = (a: Agent): AgentConfig => ({
	name: a.name,
	description: a.description,
	instructions: a.instructions,
	model: a.model,
	tools: a.tools,
});

function AgentEditor({ agent, isOwner, onBack }: { agent: Agent; isOwner: boolean; onBack: () => void }) {
	const options = useQuery(api.agents.options);
	const update = useMutation(api.agents.update);
	const setArchived = useMutation(api.agents.setArchived);
	const draft = useDraft(configOf(agent), agent.version);
	const { error, run } = useAction();
	const config = draft.value;
	const edit = (changes: Partial<AgentConfig>) => draft.set({ ...config, ...changes });
	const canUse = new Map(agent.access.map((a) => [a.id, a.visible]));

	if (!options) return <Loading />;

	return (
		<>
			<div className="flex items-center justify-between">
				<button type="button" onClick={onBack} className="text-sm text-neutral-500 hover:text-neutral-900">
					← All agents
				</button>
				{isOwner && (
					<button
						type="button"
						onClick={() => run(setArchived({ agentId: agent._id, archived: !agent.archived }))}
						className="text-sm text-neutral-500 hover:text-neutral-900"
					>
						{agent.archived ? "Restore agent" : "Archive agent"}
					</button>
				)}
			</div>

			{agent.archived && <p className="rounded-lg bg-neutral-100 px-3 py-2 text-sm">This agent is archived and hidden from chat.</p>}
			{draft.stale && <ConflictNotice who={agent.updatedByName} onDiscard={draft.discard} onKeep={draft.keepMine} />}
			{error && <Notice>{error}</Notice>}

			<fieldset disabled={!isOwner} className="flex flex-col gap-5">
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
				<Field label="Model">
					<select className={inputClass} value={config.model} onChange={(e) => edit({ model: e.target.value })}>
						{options.models.map((m) => (
							<option key={m.id} value={m.id}>
								{m.name} — {m.note}
							</option>
						))}
					</select>
				</Field>
				<div className="flex flex-col gap-1.5">
					<span className="text-sm font-medium">Tools</span>
					{options.tools.map((t) => {
						const on = config.tools.includes(t.id);
						return (
							<label key={t.id} className="flex items-start gap-3 rounded-xl border border-neutral-200 px-3 py-2">
								<input
									type="checkbox"
									className="mt-1"
									checked={on}
									onChange={() => edit({ tools: on ? config.tools.filter((x) => x !== t.id) : [...config.tools, t.id] })}
								/>
								<span className="flex flex-1 flex-col">
									<span className="text-sm">
										<code>{t.id}</code>
										{t.ownersOnly && <span className="ml-2 text-xs text-neutral-400">owners only</span>}
									</span>
									<span className="text-xs text-neutral-500">{t.description}</span>
								</span>
								{on && !isOwner && (
									<span className="text-xs text-neutral-400">{canUse.get(t.id) ? "You can use" : "Hidden from you"}</span>
								)}
							</label>
						);
					})}
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

			{isOwner && draft.dirty && (
				<SaveBar
					onDiscard={draft.discard}
					onSave={() => run(update({ agentId: agent._id, expectedVersion: draft.base, config }), draft.discard)}
				/>
			)}

			<History agent={agent} isOwner={isOwner} />
		</>
	);
}

const fieldLabels: Record<keyof AgentConfig, string> = {
	name: "name",
	description: "description",
	instructions: "instructions",
	model: "model",
	tools: "tools",
};

function History({ agent, isOwner }: { agent: Agent; isOwner: boolean }) {
	const versions = useQuery(api.agents.history, { agentId: agent._id });
	const restore = useMutation(api.agents.restore);
	const [openVersion, setOpenVersion] = useState<number>();
	const { error, run } = useAction();
	if (!versions) return null;

	return (
		<Section title="History" hint="Every save is kept. Restoring saves an old version as the newest one.">
			{error && <Notice>{error}</Notice>}
			{versions.map((v, i) => {
				const previous = versions[i + 1]?.config;
				const changed = previous
					? (Object.keys(fieldLabels) as (keyof AgentConfig)[]).filter(
							(k) => JSON.stringify(v.config[k]) !== JSON.stringify(previous[k]),
						)
					: [];
				return (
					<div key={v.version} className="rounded-xl border border-neutral-200 px-4 py-2.5 text-sm">
						<div className="flex items-center gap-3">
							<span className="flex-1">
								<span className="font-medium">v{v.version}</span>{" "}
								<span className="text-neutral-500">
									· {v.savedByName} · {timeAgo(v.savedAt)}
									{previous ? ` · changed ${changed.map((k) => fieldLabels[k]).join(", ") || "nothing"}` : " · created"}
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
