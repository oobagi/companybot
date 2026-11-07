import { api } from "../../api";
import { useQuery } from "../../convex";
import { DatabaseIcon, PrivateIcon, SkillIcon } from "../../icons";
import { Markdown } from "../../markdown";
import { navigate } from "../../router";
import { actionButton, linkButton, recordTagButton, recordTagMutedClass } from "../../ui";
import { recordPath } from "../records/logic";
import { Popover } from "./common";
import type { RecordTag, SkillRef } from "./data";
import { ProfileLink } from "./Profile";
import type { Token } from "./tokens";

/**
 * A chip does what it names: @Ada opens their card, #sales the channel, /Proposal a card with the
 * skill's instructions (its description on hover), a tagged record the record.
 */
export function TokenChip({ token }: { token: Token }) {
	if (token.kind === "record") return <RecordChip tag={token.ref} />;
	if (token.kind === "person")
		return (
			<ProfileLink who={token.ref} className={`token ${linkButton}`}>
				{token.text}
			</ProfileLink>
		);
	if (token.kind === "skill") {
		const skill = token.ref;
		return (
			<Popover trigger={<span title={skill.description}>{token.text}</span>} className="token cursor-pointer hover:underline" panelClassName="w-96">
				{(close) => <SkillCard skill={skill} onClose={close} />}
			</Popover>
		);
	}
	const { id } = token.ref;
	return (
		<button type="button" onClick={() => navigate("chat", id)} className={`token ${linkButton}`}>
			{token.text}
		</button>
	);
}

/** A tagged record by its name now. One you can't see has no name; one in Archive or deleted can't open. */
function RecordChip({ tag }: { tag: RecordTag }) {
	const name = tag.text.slice(1);
	if (tag.state === "locked")
		return (
			<span className={recordTagMutedClass} title="Only some roles can see this record">
				<PrivateIcon className="shrink-0" />
				{name}
			</span>
		);
	if (tag.state !== "live" || !tag.id || !tag.typeKey)
		return (
			<span className={recordTagMutedClass} title={tag.state === "archived" ? "In Archive" : undefined}>
				<DatabaseIcon className="shrink-0" />
				{name}
			</span>
		);
	const { id, typeKey } = tag;
	return (
		<button type="button" onClick={() => navigate(...recordPath(typeKey, id))} className={recordTagButton}>
			<DatabaseIcon className="shrink-0 text-neutral-500" />
			{name}
		</button>
	);
}

/** What the skill tells an agent to do, readable in place; "Open skill" for its settings. */
function SkillCard({ skill, onClose }: { skill: SkillRef; onClose: () => void }) {
	// Already loaded: the directory reads the same list for the / picker.
	const full = useQuery(api.skills.list)?.find((s) => s.id === skill.id);
	return (
		<div className="flex flex-col gap-3 p-4">
			<div className="flex items-center gap-2">
				<SkillIcon className="shrink-0 text-neutral-500" />
				<p className="min-w-0 truncate font-semibold">{skill.name}</p>
				{full && <span className="text-xs text-neutral-400">v{full.version}</span>}
			</div>
			{skill.description && <p className="text-neutral-600">{skill.description}</p>}
			{full?.instructions && (
				<Markdown className="max-h-64 overflow-y-auto rounded-xl bg-neutral-50 px-3 py-2 text-sm leading-relaxed">{full.instructions}</Markdown>
			)}
			<div className="flex">
				<button type="button" onClick={() => (onClose(), navigate("settings", "skills", skill.id))} className={actionButton}>
					Open skill
				</button>
			</div>
		</div>
	);
}
