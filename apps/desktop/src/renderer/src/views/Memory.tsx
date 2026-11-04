import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import { Select } from "../controls";
import type { MemoryScope } from "@companybot/core/memory";
import { type Role, can } from "@companybot/core/permissions";
import type { FunctionReturnType } from "convex/server";
import { useState } from "react";
import { agentLabel, agentOptions } from "../agent-options";
import { api } from "../api";
import { useMutation, useQuery } from "../convex";
import { MemoryIcon } from "../icons";
import { ConflictNotice, EmptyState, Form, Loading, NoMatches, Notice, Section, cardClass, compactControlClass, compactPrimaryButton, descriptionClass, hintClass, inputClass, insetClass, metadataClass, timeAgo, toolbarClass, useDraft, useRun } from "../ui";

import { archiveQuestion, useConfirm } from "./chat/common";

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

	const agentName = new Map(agents.map((a) => [a._id as string, agentLabel(a)]));
	const shown = filter === "all" ? memories : memories.filter((m) => m.agentId === filter);
	const team = shown.filter((m) => m.scope === "workspace");
	const personal = shown.filter((m) => m.scope === "personal");

	return (
		<>
			{!settings.memory && (
				<p className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900">
					Memory is turned off by an owner. Agents don't read or save memories until it's back on. Yours are kept, and you can
					still edit or delete them here.
				</p>
			)}
			<Notice>{error}</Notice>
			<AddMemory
				agents={agents.filter((a) => !a.archived)}
				canAddTeam={can(role, "memory.team.write")}
				onAdd={(agentId, scope, content) => run(create({ agentId, scope, content }))}
			/>
			<div className={toolbarClass}>
				<Select
					label="Agent"
					value={filter}
					options={[{ value: "all", label: "All agents" }, ...agentOptions(agents)]}
					onChange={(f) => setFilter(f as typeof filter)}
				/>
			</div>
			{shown.length === 0 ? (filter !== "all" ? <NoMatches /> : <EmptyState icon={<MemoryIcon />} title="No memories yet">Add something to remember, or ask an agent to save it.</EmptyState>) : <>
				<MemoryList title="Team" empty="No team memories yet." items={team} agentName={agentName} />
				<MemoryList title="Personal" empty="No personal memories yet." items={personal} agentName={agentName} />
			</>}
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
			{items.length === 0 && <p className={`${hintClass} ${insetClass}`}>{empty}</p>}
			{items.map((m) => (
				<MemoryRow key={m.id} memory={m} agent={agentName.get(m.agentId) ?? "Unknown agent"} />
			))}
		</Section>
	);
}

function MemoryRow({ memory, agent }: { memory: MemoryItem; agent: string }) {
	const update = useMutation(api.memory.update);
	const remove = useMutation(api.memory.remove);
	const { confirm, dialog } = useConfirm();
	const draft = useDraft(memory.content, memory.version);
	const { error, run } = useRun();
	const [history, setHistory] = useState(false);
	const id = memory.id as Id<"memories">;
	const team = memory.scope === "workspace";

	return (
		<div className={`flex flex-col gap-2 ${cardClass}`}>
			{dialog}
			<ConflictNotice draft={draft} who={memory.updatedByName} />
			<Notice>{error}</Notice>
			<div className="flex items-start gap-3">
				{!draft.dirty ? (
					<p className="flex-1 leading-relaxed">{memory.content}</p>
				) : (
					<textarea
						autoFocus
						value={draft.value}
						onChange={(e) => draft.set(e.target.value)}
						className={`${inputClass} flex-1 resize-none bg-neutral-50 leading-relaxed`}
					/>
				)}
				{memory.canEdit && (
					<div className={`flex gap-2 ${descriptionClass}`}>
						{!draft.dirty ? (
							<>
								<button
									type="button"
									onClick={() => draft.set(memory.content)}
									className="hover:text-neutral-900"
								>
									Edit
								</button>
								{memory.version > 1 && (
									<button type="button" onClick={() => setHistory(!history)} className="hover:text-neutral-900" aria-expanded={history}>
										History
									</button>
								)}
								<button
									type="button"
									onClick={() => confirm(team ? archiveQuestion("team memory", () => remove({ id }), "Agents will stop using this memory.") : { title: "Delete this personal memory?", action: "Delete memory", body: "This permanently deletes the memory and its history. It cannot be undone.", onConfirm: () => remove({ id }) })}
									title={team ? "Archive this memory" : "Delete this memory forever"}
									className={team ? "hover:text-neutral-900" : "hover:text-red-600"}
								>
									{team ? "Archive" : "Delete"}
								</button>
							</>
						) : (
							<>
								<button
									type="button"
									onClick={() =>
										run(update({ id, content: draft.value, expectedVersion: draft.base }), draft.discard)
									}
									className="font-medium text-neutral-900"
								>
									Save
								</button>
								<button type="button" onClick={draft.discard}>
									Cancel
								</button>
							</>
						)}
					</div>
				)}
			</div>
			<p className={metadataClass}>
				<span className="rounded bg-neutral-100 px-1.5 py-0.5 text-neutral-600">{agent}</span> · {provenance(memory)} ·{" "}
				{timeAgo(Date.parse(memory.updatedAt))}
			</p>
			{history && <MemoryHistory memory={memory} onRestored={() => setHistory(false)} />}
		</div>
	);
}

/** "Saved by Ada", or "Saved by Ada · edited by Ben, via agent". */
function provenance(m: MemoryItem) {
	const via = m.updatedByAgent ? ", via agent" : "";
	if (m.version === 1) return `Saved by ${m.createdByName}${via}`;
	if (m.createdByName === m.updatedByName) return `Saved and edited by ${m.createdByName}${via}`;
	return `Saved by ${m.createdByName} · edited by ${m.updatedByName}${via}`;
}

/** What it said before each edit, newest first. Restoring is an edit too, so it can be undone. */
function MemoryHistory({ memory, onRestored }: { memory: MemoryItem; onRestored: () => void }) {
	const versions = useQuery(api.memory.versions, { id: memory.id as Id<"memories"> });
	const restore = useMutation(api.memory.restoreVersion);
	const { error, run } = useRun();
	if (!versions) return <Loading />;
	return (
		<div className="flex flex-col gap-2 border-t border-neutral-100 pt-2">
			<Notice>{error}</Notice>
			{versions.length === 0 && <p className={hintClass}>No earlier versions.</p>}
			{versions.map((v) => (
				<div key={v._id} className="flex items-start gap-3 text-sm">
					<div className="flex flex-1 flex-col gap-0.5">
						<p className="leading-relaxed text-neutral-600">{v.content}</p>
						<p className={metadataClass}>
							{v.savedByName}
							{v.savedByAgent && ", via agent"} · {timeAgo(v.savedAt)}
						</p>
					</div>
					{memory.canEdit && (
						<button
							type="button"
							onClick={() => run(restore({ versionId: v._id, expectedVersion: memory.version }), onRestored)}
							className={`${descriptionClass} hover:text-neutral-900`}
						>
							Restore
						</button>
					)}
				</div>
			))}
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
		<Form
			className={toolbarClass}
			onSubmit={() => {
				if (!content.trim() || !agentId) return;
				onAdd(agentId, scope, content.trim());
				setContent("");
			}}
		>
			<input
				value={content}
				onChange={(e) => setContent(e.target.value)}
				placeholder="Add something to remember…"
				className={`${compactControlClass} min-w-48 flex-1`}
			/>
			<Select
				label="Agent"
				value={agentId}
				options={agentOptions(agents)}
				onChange={(id) => setAgentId(id as Id<"agents">)}
			/>
			<Select
				label="Who can see it"
				value={scope}
				options={[
					{ value: "personal", label: "Personal" },
					{ value: "workspace", label: canAddTeam ? "Team" : "Team (not allowed)", disabled: !canAddTeam },
				]}
				onChange={setScope}
			/>
			<button type="submit" className={compactPrimaryButton}>
				Add
			</button>
		</Form>
	);
}
