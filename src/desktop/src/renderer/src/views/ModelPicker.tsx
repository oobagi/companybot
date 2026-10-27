import { type ModelInfo, modelNote, searchModels } from "@companybot/core/models";
import { useEffect, useState } from "react";
import { api } from "../api";
import { useAction } from "../convex";
import { inputClass } from "../ui";
import { Modal } from "./chat/common";

/** The agent editor's model field: the pick, and a searchable list of AI Gateway's models. */
export function ModelPicker({ models, defaultModel, value, onChange }: { models: ModelInfo[]; defaultModel: string; value: string; onChange: (id: string) => void }) {
	const [open, setOpen] = useState(false);
	const refresh = useAction(api.modelCatalog.refreshIfStale);
	// A day-old catalog refreshes as the editor opens; the list updates live when it lands.
	useEffect(() => void refresh().catch(() => {}), [refresh]);
	const current = models.find((m) => m.id === value);
	return (
		<div className="flex flex-col gap-1.5">
			<span className="text-sm font-medium">Model</span>
			<button type="button" onClick={() => setOpen(true)} className={`${inputClass} flex items-baseline justify-between gap-3 text-left`}>
				<span className="min-w-0 truncate">
					{current?.name ?? value}
					{!current && <span className="text-neutral-400"> · unavailable</span>}
				</span>
				<span className="shrink-0 text-xs text-neutral-500">{current && modelNote(current)}</span>
			</button>
			{!current && <span className="text-xs text-neutral-500">AI Gateway doesn't list this model anymore, so replies may fail. Pick another.</span>}
			{open && (
				<ModelList
					models={models}
					defaultModel={defaultModel}
					value={value}
					onPick={(id) => {
						onChange(id);
						setOpen(false);
					}}
					onClose={() => setOpen(false)}
				/>
			)}
		</div>
	);
}

function ModelList({ models, defaultModel, value, onPick, onClose }: { models: ModelInfo[]; defaultModel: string; value: string; onPick: (id: string) => void; onClose: () => void }) {
	const [search, setSearch] = useState("");
	const found = searchModels(models, search);
	const recommended = found.filter((m) => m.id === defaultModel);
	const groups = new Map<string, ModelInfo[]>(recommended.length ? [["Recommended", recommended]] : []);
	for (const m of found) groups.set(m.provider, [...(groups.get(m.provider) ?? []), m]);
	return (
		<Modal title="Pick a model" onClose={onClose}>
			<input autoFocus className={inputClass} placeholder="Search models or providers" value={search} onChange={(e) => setSearch(e.target.value)} />
			{found.length === 0 && <p className="text-sm text-neutral-500">No models match.</p>}
			{[...groups].map(([group, list]) => (
				<section key={group} className="flex flex-col gap-0.5">
					<h3 className="px-2 text-xs font-medium uppercase tracking-wide text-neutral-400">{group}</h3>
					{list.map((m) => (
						<button
							key={m.id}
							type="button"
							onClick={() => onPick(m.id)}
							className={`flex flex-col rounded-lg px-2 py-1.5 text-left hover:bg-neutral-100 ${m.id === value ? "bg-neutral-100" : ""}`}
						>
							<span className="text-sm">
								{m.name}
								{m.id === value && <span className="text-neutral-400"> · current</span>}
							</span>
							<span className="text-xs text-neutral-500">{[m.id, modelNote(m)].filter(Boolean).join(" · ")}</span>
						</button>
					))}
				</section>
			))}
		</Modal>
	);
}
