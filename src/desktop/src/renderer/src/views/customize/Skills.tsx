import type { Role } from "@companybot/core";
import { can } from "@companybot/core/permissions";
import { SKILL_DESCRIPTION_MAX, SKILL_NAME_MAX } from "@companybot/core/skills";
import { useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useQuery } from "convex-helpers/react/cache";
import { useState } from "react";
import { api } from "../../api";
import { Markdown } from "../../markdown";
import { navigate } from "../../router";
import { Field, Loading, Notice, Section, inputClass, primaryButton, useRun } from "../../ui";
import { Card, Detail, Facts, MadeItemDetail, Missing, NewItem } from "./shared";

type SkillItem = FunctionReturnType<typeof api.skills.list>[number];

export function SkillsTab({ role }: { role: Role }) {
	const skills = useQuery(api.skills.list);
	const setSkill = useMutation(api.skills.setInstalled);
	const { error, run } = useRun();
	if (!skills) return <Loading />;
	const canManage = can(role, "skills.manage");
	const ours = skills.filter((s) => s.custom);
	const library = skills.filter((s) => !s.custom);
	const card = (s: SkillItem) => (
		<Card
			key={s.id}
			title={s.name}
			meta={`v${s.version}`}
			description={s.description}
			installed={s.installed}
			canManage={s.custom ? s.canEdit : canManage}
			onToggle={s.custom ? undefined : () => run(setSkill({ skillId: s.id, installed: !s.installed }))}
			onOpen={() => navigate("customize", "skills", s.id)}
		/>
	);

	return (
		<>
			<div className="flex items-start justify-between gap-4">
				<p className="text-sm text-neutral-500">
					Instructions your agents load when a task calls for them. Agents see each skill's description, and read the rest only
					when they need it.
				</p>
				{can(role, "skills.create") && (
					<button type="button" className={`${primaryButton} shrink-0`} onClick={() => navigate("customize", "skills", "new")}>
						New skill
					</button>
				)}
			</div>
			{error && <Notice>{error}</Notice>}
			{ours.length > 0 && (
				<Section title="Made by your team">
					<div className="flex flex-col gap-3">{ours.map(card)}</div>
				</Section>
			)}
			<Section title="Library">
				<div className="flex flex-col gap-3">{library.map(card)}</div>
			</Section>
		</>
	);
}

type SkillConfig = { name: string; description: string; instructions: string };

/** Name, description, and instructions: the parts of a skill someone writes. */
function SkillFields({ value, onChange }: { value: SkillConfig; onChange: (value: SkillConfig) => void }) {
	const left = SKILL_DESCRIPTION_MAX - value.description.trim().length;
	return (
		<>
			<Field label="Name">
				<input
					className={inputClass}
					value={value.name}
					maxLength={SKILL_NAME_MAX}
					placeholder="e.g. Quote follow-up"
					onChange={(e) => onChange({ ...value, name: e.target.value })}
				/>
			</Field>
			<Field
				label="Description"
				hint={`What it does and when to use it. Agents see this in every message, so keep it to a line. ${left} characters left.`}
			>
				<input
					className={inputClass}
					value={value.description}
					placeholder="e.g. Write a follow-up for a quote that hasn't been answered. Use when someone asks to chase a quote."
					onChange={(e) => onChange({ ...value, description: e.target.value })}
				/>
			</Field>
			<Field label="Instructions" hint="Markdown. The agent reads this only when it loads the skill.">
				<textarea
					className={`${inputClass} min-h-48 font-mono text-sm`}
					value={value.instructions}
					placeholder={"e.g. Write the follow-up as:\n1. A one-line reminder of the quote.\n2. One question that moves it forward."}
					onChange={(e) => onChange({ ...value, instructions: e.target.value })}
				/>
			</Field>
		</>
	);
}

function NewSkill() {
	const create = useMutation(api.skills.create);
	const { error, run } = useRun();
	const [config, setConfig] = useState<SkillConfig>({ name: "", description: "", instructions: "" });

	return (
		<NewItem
			tab="skills"
			noun="skill"
			error={error}
			onCreate={() => run(create({ config }).then((id) => navigate("customize", "skills", id)))}
		>
			<SkillFields value={config} onChange={setConfig} />
		</NewItem>
	);
}

function CustomSkillDetail({ skill: s, custom }: { skill: SkillItem; custom: NonNullable<SkillItem["custom"]> }) {
	const save = useMutation(api.skills.save);
	const setSkill = useMutation(api.skills.setInstalled);

	return (
		<MadeItemDetail<SkillConfig>
			tab="skills"
			name={s.name}
			createdByName={s.createdByName}
			canEdit={s.canEdit}
			custom={custom}
			saved={{ name: s.name, description: s.description, instructions: s.instructions }}
			deleteWarning="Agents stop seeing it, and it can't be restored."
			onDelete={() => setSkill({ skillId: s.id, installed: false })}
			onSave={(config, expectedVersion) => save({ skillId: s.id, config, expectedVersion })}
			fields={(value, onChange) => <SkillFields value={value} onChange={onChange} />}
		>
			<Facts rows={[["Used by", 'Everyone\'s agents granted "skills.load", when a task calls for it']]} />
		</MadeItemDetail>
	);
}

export function SkillScreen({ role, id }: { role: Role; id: string }) {
	const skills = useQuery(api.skills.list);
	const setSkill = useMutation(api.skills.setInstalled);
	const { error, run } = useRun();
	const canManage = can(role, "skills.manage");
	if (id === "new") return <NewSkill />;
	const open = skills?.find((s) => s.id === id);
	if (!open) return <Missing tab="skills" loaded={!!skills} />;
	if (open.custom) return <CustomSkillDetail skill={open} custom={open.custom} />;
	return (
		<Detail
			tab="skills"
			title={open.name}
			meta={`v${open.version}`}
			description={open.description}
			installed={open.installed}
			canManage={canManage}
			onToggle={() => run(setSkill({ skillId: open.id, installed: !open.installed }))}
		>
			{error && <Notice>{error}</Notice>}
			<Facts rows={[["Used by", 'Agents granted "skills.load", when a task calls for it']]} />
			<Section title="Instructions" hint="What the agent reads when it loads this skill.">
				<Markdown className="rounded-xl bg-neutral-50 px-4 py-3 text-sm leading-relaxed">{open.instructions}</Markdown>
			</Section>
		</Detail>
	);
}
