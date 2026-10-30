import { type ModelInfo, searchModels } from "@companybot/core/models";
import { useEffect, useState } from "react";
import { api } from "../api";
import { useAction } from "../convex";
import { CaretUpDownIcon } from "../icons";
import { compactControlClass, descriptionClass, inputClass } from "../ui";
import { Popover } from "./chat/common";

type Pickable = Pick<ModelInfo, "id" | "name" | "provider">;

/**
 * A model field: the pick, and a searchable list of AI Gateway's models. The agent editor's (with
 * its "Model" label), and Settings → General's picture model (`label` left out: the row has one).
 */
export function ModelPicker<M extends Pickable>({
	models,
	defaultModel,
	value,
	onChange,
	note,
	label,
	disabled,
	className = `${inputClass} w-full`,
}: {
	models: M[];
	defaultModel: string;
	value: string;
	onChange: (id: string) => void;
	/** A short line about a model: context and price. */
	note: (m: M) => string;
	label?: string;
	disabled?: boolean;
	className?: string;
}) {
	const refresh = useAction(api.modelCatalog.refreshIfStale);
	// A day-old catalog refreshes as the picker opens; the list updates live when it lands.
	useEffect(() => void refresh().catch(() => {}), [refresh]);
	const current = models.find((m) => m.id === value);
	return (
		<div className="flex flex-col gap-1.5">
			{label && <span className="text-sm font-medium">{label}</span>}
			<Popover
				matchWidth
				disabled={disabled}
				trigger={
					<>
						<span className="min-w-0 flex-1 truncate">
							{current?.name ?? value}
							{!current && <span className="text-neutral-400"> · unavailable</span>}
						</span>
						{/* A settings row's control is too narrow for the note; the list still shows it. */}
						{label && <span className="shrink-0 text-xs text-neutral-500">{current && note(current)}</span>}
						<CaretUpDownIcon className="shrink-0 self-center text-neutral-400" />
					</>
				}
				className={`${className} flex items-baseline gap-3 text-left`}
				panelClassName="flex max-w-xl flex-col gap-2 p-2"
			>
				{(close) => <ModelList models={models} defaultModel={defaultModel} value={value} note={note} onPick={(id) => (close(), onChange(id))} />}
			</Popover>
			{!current && <span className="text-xs text-neutral-500">AI Gateway doesn't list this model anymore, so it may fail. Pick another.</span>}
		</div>
	);
}

function ModelList<M extends Pickable>({ models, defaultModel, value, note, onPick }: { models: M[]; defaultModel: string; value: string; note: (m: M) => string; onPick: (id: string) => void }) {
	const [search, setSearch] = useState("");
	const found = searchModels(models, search);
	const recommended = found.filter((m) => m.id === defaultModel);
	const groups = new Map<string, M[]>(recommended.length ? [["Recommended", recommended]] : []);
	// The recommended model is listed once, under Recommended.
	for (const m of found) if (m.id !== defaultModel) groups.set(m.provider, [...(groups.get(m.provider) ?? []), m]);
	return (
		<>
			<input autoFocus className={`${compactControlClass} sticky top-0 z-10 bg-white`} placeholder="Search models or providers" value={search} onChange={(e) => setSearch(e.target.value)} />
			{found.length === 0 && <p className={descriptionClass}>No models match.</p>}
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
							<span className="text-xs text-neutral-500">{[m.id, note(m)].filter(Boolean).join(" · ")}</span>
						</button>
					))}
				</section>
			))}
		</>
	);
}
