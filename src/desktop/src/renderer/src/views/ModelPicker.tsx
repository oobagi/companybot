import { type ModelInfo, searchModels } from "@companybot/core/models";
import { useEffect, useState } from "react";
import { api } from "../api";
import { useAction } from "../convex";
import { CaretUpDownIcon, CheckIcon } from "../icons";
import { compactControlClass, descriptionClass, wideControlClass } from "../ui";
import { MenuItem, Popover } from "./chat/common";

type Pickable = Pick<ModelInfo, "id" | "name" | "provider">;

/**
 * A model picker for a settings row: the pick, and a searchable list of AI Gateway's models
 * (the agent editor's model, Settings → General's reply-decision and picture models).
 */
export function ModelPicker<M extends Pickable>({
	models,
	defaultModel,
	value,
	onChange,
	note,
	disabled,
	className = wideControlClass,
}: {
	models: M[];
	defaultModel: string;
	value: string;
	onChange: (id: string) => void;
	/** A short line about a model: context and price. */
	note: (m: M) => string;
	disabled?: boolean;
	className?: string;
}) {
	const refresh = useAction(api.modelCatalog.refreshIfStale);
	// A day-old catalog refreshes as the picker opens; the list updates live when it lands.
	useEffect(() => void refresh().catch(() => {}), [refresh]);
	const current = models.find((m) => m.id === value);
	return (
		<div className="flex flex-col gap-1.5">
			<Popover
				matchWidth
				disabled={disabled}
				trigger={
					<>
						<span className="min-w-0 flex-1 truncate">
							{current?.name ?? value}
							{!current && <span className="text-neutral-400"> · unavailable</span>}
						</span>
						{/* A settings row's control is too narrow for the note; the list shows it. */}
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
					<p className="px-2 pt-2 pb-1 text-xs font-medium text-neutral-400">{group}</p>
					{list.map((m) => (
						<MenuItem key={m.id} onClick={() => onPick(m.id)}>
							<span className="min-w-0 flex-1">
								<span className="block text-sm">{m.name}</span>
								<span className="block text-xs text-neutral-500">{[m.id, note(m)].filter(Boolean).join(" · ")}</span>
							</span>
							{m.id === value && <CheckIcon aria-label="Current" className="shrink-0 text-neutral-500" />}
						</MenuItem>
					))}
				</section>
			))}
		</>
	);
}
