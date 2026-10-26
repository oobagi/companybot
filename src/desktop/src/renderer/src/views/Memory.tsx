import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import type { MemoryScope, Role } from "@companybot/core";
import { can } from "@companybot/core/permissions";
import type { FunctionReturnType } from "convex/server";
import { useState } from "react";
import { api } from "../api";
import { useMutation, useQuery } from "../convex";
import { ConflictNotice, Loading, Notice, Section, inputClass, primaryButton, timeAgo, useRun } from "../ui";

type MemoryItem = FunctionReturnType<typeof api.memory.list>[number];
type Agent = { _id: Id<"agents">; name: string; archived: boolean };

export function MemoryTab({ role }: { role: Role }) {
	const memories = useQuery(api.memory.list);
	const agents = useQuery(api.agents.list);
	const settings = useQuery(api.workspace.settings);
	const create = useMutation(api.memory.create);
	const [filter, setFilter] = useState<Id<"agents"> | "all">("all");
	const { error, run } = useRun();

	if (!memories || !agents || !settings) return <Loading />;

	const agentName = new Map(agents.map((a) => [a._id as string, a.archived ? `${a.name} (archived)` : a.name]));
	const shown = filter === "all" ? memories : memories.filter((m) => m.agentId === filter);
	const team = shown.filter((m) => m.scope === "workspace");
	const personal = shown.filter((m) => m.scope === "personal");

	return (
		<>
			<p className="text-sm text-neutral-500">
				Each agent has its own memory. Team memories are shared; personal ones only you can see, owners included.
			</p>
			{!settings.memory && (
				<p className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900">
					Memory is turned off by an owner. Agents don't read or save memories until it's back on. Yours are kept, and you can
					still edit or delete them here.
				</p>
			)}
			{error && <Notice>{error}</Notice>}
			<AddMemory
				agents={agents.filter((a) => !a.archived)}
				canAddTeam={can(role, "memory.team.write")}
				onAdd={(agentId, scope, content) => run(create({ agentId, scope, content }))}
			/>
			<div className="flex items-center gap-2 text-sm">
				<span className="text-neutral-500">Showing</span>
				<select
					value={filter}
					onChange={(e) => setFilter(e.target.value as typeof filter)}
					className="rounded-lg border border-neutral-200 px-2 py-1"
				>
					<option value="all">All agents</option>
					{agents.map((a) => (
						<option key={a._id} value={a._id}>
							{agentName.get(a._id)}
						</option>
					))}
				</select>
			</div>
			<MemoryList title="Team" empty="No team memories yet." items={team} agentName={agentName} />
			<MemoryList title="Personal" empty="No personal memories yet." items={personal} agentName={agentName} />
		</>
	);
}

function MemoryList({
	title,
	empty,
	items,
	agentName,
}: {
	title: string;
	empty: string;
	items: MemoryItem[];
	agentName: Map<string, string>;
}) {
	return (
		<Section title={title}>
			{items.length === 0 && <p className="text-sm text-neutral-400">{empty}</p>}
			{items.map((m) => (
				<MemoryRow key={m.id} memory={m} agent={agentName.get(m.agentId) ?? "Unknown agent"} />
			))}
		</Section>
	);
}

function MemoryRow({ memory, agent }: { memory: MemoryItem; agent: string }) {
	const update = useMutation(api.memory.update);
	const remove = useMutation(api.memory.remove);
	// Editing starts from the version on screen; if someone saves first, we say so.
	const [draft, setDraft] = useState<{ content: string; base: number }>();
	const { error, run } = useRun();
	const id = memory.id as Id<"memories">;
	const stale = draft !== undefined && draft.base !== memory.version;

	return (
		<div className="flex flex-col gap-2 rounded-xl border border-neutral-200 px-4 py-3">
			{stale && (
				<ConflictNotice
					who={memory.updatedByName}
					onDiscard={() => setDraft(undefined)}
					onKeep={() => setDraft({ ...draft, base: memory.version })}
				/>
			)}
			{error && <Notice>{error}</Notice>}
			<div className="flex items-start gap-3">
				{draft === undefined ? (
					<p className="flex-1 leading-relaxed">{memory.content}</p>
				) : (
					<textarea
						autoFocus
						value={draft.content}
						onChange={(e) => setDraft({ ...draft, content: e.target.value })}
						className="flex-1 resize-none rounded-lg bg-neutral-50 px-2 py-1 outline-none"
					/>
				)}
				{memory.canEdit && (
					<div className="flex gap-2 text-sm text-neutral-500">
						{draft === undefined ? (
							<>
								<button
									type="button"
									onClick={() => setDraft({ content: memory.content, base: memory.version })}
									className="hover:text-neutral-900"
								>
									Edit
								</button>
								<button type="button" onClick={() => run(remove({ id }))} className="hover:text-red-600">
									Delete
								</button>
							</>
						) : (
							<>
								<button
									type="button"
									onClick={() =>
										run(update({ id, content: draft.content, expectedVersion: draft.base }), () => setDraft(undefined))
									}
									className="font-medium text-neutral-900"
								>
									Save
								</button>
								<button type="button" onClick={() => setDraft(undefined)}>
									Cancel
								</button>
							</>
						)}
					</div>
				)}
			</div>
			<p className="text-xs text-neutral-400">
				<span className="rounded bg-neutral-100 px-1.5 py-0.5 text-neutral-600">{agent}</span> ·{" "}
				{memory.updatedByName}
				{memory.updatedByAgent && ", via agent"} ·{" "}
				{timeAgo(Date.parse(memory.updatedAt))}
			</p>
		</div>
	);
}

function AddMemory({
	agents,
	canAddTeam,
	onAdd,
}: {
	agents: Agent[];
	canAddTeam: boolean;
	onAdd: (agentId: Id<"agents">, scope: MemoryScope, content: string) => void;
}) {
	const [content, setContent] = useState("");
	const [agentId, setAgentId] = useState(agents[0]?._id);
	const [scope, setScope] = useState<MemoryScope>("personal");
	return (
		<form
			className="flex gap-2"
			onSubmit={(e) => {
				e.preventDefault();
				if (!content.trim() || !agentId) return;
				onAdd(agentId, scope, content.trim());
				setContent("");
			}}
		>
			<input
				value={content}
				onChange={(e) => setContent(e.target.value)}
				placeholder="Add something to remember…"
				className={`${inputClass} flex-1`}
			/>
			<select
				value={agentId}
				onChange={(e) => setAgentId(e.target.value as Id<"agents">)}
				className="rounded-xl border border-neutral-200 px-2 text-sm"
				aria-label="Agent"
			>
				{agents.map((a) => (
					<option key={a._id} value={a._id}>
						{a.name}
					</option>
				))}
			</select>
			<select
				value={scope}
				onChange={(e) => setScope(e.target.value as MemoryScope)}
				className="rounded-xl border border-neutral-200 px-2 text-sm"
				aria-label="Who can see it"
			>
				<option value="personal">Personal</option>
				<option value="workspace" disabled={!canAddTeam}>
					Team{canAddTeam ? "" : " (owners only)"}
				</option>
			</select>
			<button type="submit" className={primaryButton}>
				Add
			</button>
		</form>
	);
}
