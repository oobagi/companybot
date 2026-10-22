import type { MemoryScope, Role } from "@companybot/core";
import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { api, errorMessage } from "../api";
import { Notice } from "./Chat";

type MemoryItem = NonNullable<ReturnType<typeof useQuery<typeof api.memory.list>>>[number];

export function MemoryView({ role }: { role: Role }) {
	const memories = useQuery(api.memory.list);
	const create = useMutation(api.memory.create);
	const [error, setError] = useState<string>();
	const run = (action: Promise<unknown>) =>
		action.then(
			() => setError(undefined),
			(e) => setError(errorMessage(e)),
		);

	const team = memories?.filter((m) => m.scope === "workspace") ?? [];
	const personal = memories?.filter((m) => m.scope === "personal") ?? [];

	return (
		<Page title="Memory" subtitle="What your agents remember. Team memories are shared; personal ones are yours.">
			{error && <Notice>{error}</Notice>}
			<AddMemory canAddTeam={role === "owner"} onAdd={(scope, content) => run(create({ scope, content }))} />
			<Section title="Team" empty="No team memories yet." items={team} run={run} />
			<Section title="Personal" empty="No personal memories yet." items={personal} run={run} />
		</Page>
	);
}

function Section({
	title,
	empty,
	items,
	run,
}: {
	title: string;
	empty: string;
	items: MemoryItem[];
	run: (p: Promise<unknown>) => void;
}) {
	return (
		<section className="flex flex-col gap-2">
			<h2 className="text-sm font-medium text-neutral-500">{title}</h2>
			{items.length === 0 && <p className="text-sm text-neutral-400">{empty}</p>}
			{items.map((m) => (
				<MemoryRow key={m.id} memory={m} run={run} />
			))}
		</section>
	);
}

function MemoryRow({ memory, run }: { memory: MemoryItem; run: (p: Promise<unknown>) => void }) {
	const update = useMutation(api.memory.update);
	const remove = useMutation(api.memory.remove);
	const [draft, setDraft] = useState<string>();
	const id = memory.id as Id<"memories">;

	return (
		<div className="flex items-start gap-3 rounded-xl border border-neutral-200 px-4 py-3">
			{draft === undefined ? (
				<p className="flex-1 leading-relaxed">{memory.content}</p>
			) : (
				<textarea
					autoFocus
					value={draft}
					onChange={(e) => setDraft(e.target.value)}
					className="flex-1 resize-none rounded-lg bg-neutral-50 px-2 py-1 outline-none"
				/>
			)}
			{memory.canEdit && (
				<div className="flex gap-2 text-sm text-neutral-500">
					{draft === undefined ? (
						<>
							<button type="button" onClick={() => setDraft(memory.content)} className="hover:text-neutral-900">
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
								onClick={() => (run(update({ id, content: draft })), setDraft(undefined))}
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
	);
}

function AddMemory({ canAddTeam, onAdd }: { canAddTeam: boolean; onAdd: (scope: MemoryScope, content: string) => void }) {
	const [content, setContent] = useState("");
	const [scope, setScope] = useState<MemoryScope>("personal");
	return (
		<form
			className="flex gap-2"
			onSubmit={(e) => {
				e.preventDefault();
				if (!content.trim()) return;
				onAdd(scope, content.trim());
				setContent("");
			}}
		>
			<input
				value={content}
				onChange={(e) => setContent(e.target.value)}
				placeholder="Add something to remember…"
				className="flex-1 rounded-xl border border-neutral-200 px-3 py-2 outline-none focus:border-neutral-300"
			/>
			<select
				value={scope}
				onChange={(e) => setScope(e.target.value as MemoryScope)}
				className="rounded-xl border border-neutral-200 px-2 text-sm"
			>
				<option value="personal">Personal</option>
				<option value="workspace" disabled={!canAddTeam}>
					Team{canAddTeam ? "" : " (owners only)"}
				</option>
			</select>
			<button type="submit" className="rounded-xl bg-neutral-900 px-4 text-sm text-white">
				Add
			</button>
		</form>
	);
}

export function Page({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
	return (
		<div className="flex-1 overflow-y-auto">
			<div className="mx-auto flex max-w-2xl flex-col gap-6 px-6 py-10">
				<header>
					<h1 className="text-xl font-medium">{title}</h1>
					<p className="text-sm text-neutral-500">{subtitle}</p>
				</header>
				{children}
			</div>
		</div>
	);
}
