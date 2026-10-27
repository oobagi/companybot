import type { Role } from "@companybot/core";
import { can } from "@companybot/core/permissions";
import { SKILL_DESCRIPTION_MAX, SKILL_NAME_MAX } from "@companybot/core/skills";
import type { FunctionReturnType } from "convex/server";
import { useState } from "react";
import { api } from "../../api";
import { useMutation, useQuery } from "../../convex";
import { SkillIcon } from "../../icons";
import { Markdown } from "../../markdown";
import { navigate } from "../../router";
import { Field, Loading, Notice, Section, inputClass, primaryButton, useRun } from "../../ui";
import { Card, Detail, Facts, ItemList, MadeItemDetail, Missing, NewItem } from "./shared";

type SkillItem = FunctionReturnType<typeof api.skills.list>[number];

export function SkillsTab({ role }: { role: Role }) {
	const skills = useQuery(api.skills.list);
	if (!skills) return <Loading />;
	const card = (s: SkillItem) => (
		<Card
			key={s.id}
			title={s.name}
			meta={`v${s.version}`}
			description={s.description}
			installed={s.installed}
			canManage={s.canEdit}
			onOpen={() => navigate("settings", "skills", s.id)}
		/>
	);

	return (
		<ItemList
			items={skills}
			description="Instructions your agents load when a task calls for them. Agents see each skill's description, and read the rest only when they need it."
			icon={<SkillIcon />} title="No skills yet" empty="Save a process your agents can follow."
			card={card}
			action={can(role, "skills.create") && (
				<button type="button" className={`${primaryButton} shrink-0`} onClick={() => navigate("settings", "skills", "new")}>
					New skill
				</button>
			)}
		/>
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
			onCreate={() => run(create({ config }).then((id) => navigate("settings", "skills", id)))}
		>
			<SkillFields value={config} onChange={setConfig} />
		</NewItem>
	);
}

function CustomSkillDetail({ skill: s, custom }: { skill: SkillItem; custom: NonNullable<SkillItem["custom"]> }) {
	const save = useMutation(api.skills.save);
	const remove = useMutation(api.skills.remove);

	return (
		<MadeItemDetail<SkillConfig>
			tab="skills"
			name={s.name}
			createdByName={s.createdByName}
			canEdit={s.canEdit}
			custom={custom}
			saved={{ name: s.name, description: s.description, instructions: s.instructions }}
			trash={s.trash}
			onDelete={() => remove({ skillId: s.id })}
			onSave={(config, expectedVersion) => save({ skillId: s.id, config, expectedVersion })}
			fields={(value, onChange) => <SkillFields value={value} onChange={onChange} />}
		>
			<Facts rows={[["Used by", 'Everyone\'s agents granted "skills.load", when a task calls for it']]} />
		</MadeItemDetail>
	);
}

export function SkillScreen({ role, id }: { role: Role; id: string }) {
	const skills = useQuery(api.skills.list);
	const { error, busy, run } = useRun();
	const canManage = can(role, "skills.manage");
	const removeSkill = useMutation(api.skills.remove);
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
			trash={open.trash}
			canManage={canManage}
			confirmation="Agents stop seeing it. You can restore it from Trash for 30 days."
			busy={busy}
			onToggle={() => run(removeSkill({ skillId: open.id }))}
		>
			{error && <Notice>{error}</Notice>}
			<Facts rows={[["Used by", 'Agents granted "skills.load", when a task calls for it']]} />
			<Section title="Instructions" hint="What the agent reads when it loads this skill.">
				<Markdown className="rounded-xl bg-neutral-50 px-4 py-3 text-sm leading-relaxed">{open.instructions}</Markdown>
			</Section>
		</Detail>
	);
}
