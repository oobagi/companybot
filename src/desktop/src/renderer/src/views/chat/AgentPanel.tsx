import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import { type CustomerReplies, HAND_OFF_TOPIC_MAX, pickAgentConfig } from "@companybot/core/agent-config";
import { formatPhone } from "@companybot/core/inbox";
import { can } from "@companybot/core/permissions";
import { useEffect, useRef, useState } from "react";
import { api } from "../../api";
import { useMutation, useQuery } from "../../convex";
import { CloseIcon } from "../../icons";
import { navigate } from "../../router";
import { Loading, Notice, choiceCardButton, compactButton, compactControlClass, metadataClass, smallIconButton, tabCloseButton, useRun } from "../../ui";
import { MarkdownEditor } from "../pages/PageEditor";
import { Avatar } from "./common";

/**
 * An agent's details beside its DM: who it is, the workspace addresses it answers, how it answers customers, and its
 * instructions, each changed right here (with agents.manage). Everything else is in Settings → Agents.
 */
export function AgentPanel({ agentId, onClose }: { agentId: Id<"agents">; onClose: () => void }) {
	const agents = useQuery(api.agents.list);
	const me = useQuery(api.workspace.me);
	const agent = agents?.find((a) => a._id === agentId);
	const contact = useQuery(api.contactPoints.forAgent, { agentId });
	const setHandling = useMutation(api.agents.setCustomerHandling);
	const { error, run } = useRun();
	const canEdit = !!me?.access && can(me.access, "agents.manage") && !agent?.archived;
	return (
		<aside aria-label="Agent details" className="flex w-96 shrink-0 flex-col border-l border-neutral-200 bg-white">
			<header className="drag flex h-12 shrink-0 items-center gap-2 px-5">
				<h2 className="text-sm font-semibold">Details</h2>
				<button type="button" aria-label="Close details" title="Close details" className={`ml-auto ${tabCloseButton}`} onClick={onClose}>
					<CloseIcon />
				</button>
			</header>
			{!agent ? (
				<Loading />
			) : (
				<div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-5 pt-2 pb-8 text-sm">
					<div className="flex flex-col items-start gap-2">
						<Avatar name={agent.name} image={agent.image} agent size="lg" />
						<div className="flex flex-col">
							<p className="text-base font-semibold">{agent.name}</p>
							{agent.description && <p className="text-neutral-500">{agent.description}</p>}
						</div>
					</div>
					<Notice>{error}</Notice>

					<Part title="How customers reach it">
						{contact?.map((p) => <Line key={p.address} label={p.kind === "email" ? "Email" : "Phone"} value={p.kind === "phone" ? formatPhone(p.address) : p.address} />)}
						{contact && !contact.length && <p className={metadataClass}>It doesn't answer an email address or phone number yet. Pick it for one in Settings, under Email and phone.</p>}
					</Part>

					<Part title="When a customer emails or texts it">
						<Choice
							picked={agent.customerReplies ?? "check"}
							disabled={!canEdit}
							name={agent.name}
							onPick={(customerReplies) => void run(setHandling({ agentId, customerReplies }))}
						/>
					</Part>

					<Part title="Topics it never answers" note={`${agent.name} sends these conversations to your team instead of replying.`}>
						<Topics topics={agent.handOffTopics ?? []} disabled={!canEdit} onChange={(handOffTopics) => void run(setHandling({ agentId, handOffTopics }))} />
					</Part>

					<Part title="Instructions" note="What it should know and how it should work. Type / for headings and lists.">
						<Instructions key={agent._id} agent={agent} editable={canEdit} />
					</Part>

					<div>
						<button type="button" className={compactButton} onClick={() => navigate("settings", "agents", agentId)}>
							All settings
						</button>
					</div>
				</div>
			)}
		</aside>
	);
}

function Part({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
	return (
		<section className="flex flex-col gap-2">
			<div className="flex flex-col gap-0.5">
				<p className="font-medium text-neutral-900">{title}</p>
				{note && <p className="text-xs text-neutral-500">{note}</p>}
			</div>
			{children}
		</section>
	);
}

function Line({ label, value }: { label: string; value: string | false | undefined }) {
	if (!value) return null;
	return (
		<p className="flex min-w-0 gap-3">
			<span className="w-12 shrink-0 text-neutral-500">{label}</span>
			<span className="min-w-0 truncate select-text">{value}</span>
		</p>
	);
}

/** The two ways it can answer customers, each said in full. */
export function Choice({ picked, disabled, name, onPick }: { picked: CustomerReplies; disabled: boolean; name: string; onPick: (value: CustomerReplies) => void }) {
	const options: { value: CustomerReplies; label: string; hint: string }[] = [
		{ value: "check", label: "Let me check each reply first", hint: `${name} writes a draft. Nothing is sent until someone on your team presses Send.` },
		{ value: "send", label: "Send replies right away", hint: `${name} answers on its own. You can still read every message in Inbox.` },
	];
	return (
		<div role="group" aria-label="When a customer emails or texts it" className="flex flex-col gap-1.5">
			{options.map((o) => {
				const on = picked === o.value;
				return (
					<button
						key={o.value}
						type="button"
						aria-pressed={on}
						disabled={disabled}
						onClick={() => !on && onPick(o.value)}
						className={choiceCardButton}
					>
						<span className={`flex size-4 shrink-0 items-center justify-center rounded-full border ${on ? "border-neutral-900" : "border-neutral-300"}`}>{on && <span className="size-2 rounded-full bg-neutral-900" />}</span>
						<span className="flex min-w-0 flex-col gap-0.5">
							<span className="font-medium text-neutral-900">{o.label}</span>
							<span className="text-xs text-neutral-500">{o.hint}</span>
						</span>
					</button>
				);
			})}
		</div>
	);
}

/** The topics it passes to staff: each a row you can remove, and a box to add one (Enter). */
export function Topics({ topics, disabled, onChange }: { topics: string[]; disabled: boolean; onChange: (topics: string[]) => void }) {
	const [text, setText] = useState("");
	const add = () => {
		const topic = text.trim();
		if (!topic) return;
		setText("");
		if (!topics.some((t) => t.toLowerCase() === topic.toLowerCase())) onChange([...topics, topic]);
	};
	return (
		<div className="flex flex-col gap-1">
			{topics.length === 0 && disabled && <p className={metadataClass}>None</p>}
			{topics.map((t) => (
				<p key={t} className="group/topic flex min-w-0 items-center gap-2 rounded-lg bg-neutral-50 py-1 pr-1 pl-3">
					<span className="min-w-0 flex-1 truncate">{t}</span>
					{!disabled && (
						<button type="button" aria-label={`Remove ${t}`} title="Remove" className={smallIconButton} onClick={() => onChange(topics.filter((x) => x !== t))}>
							<CloseIcon />
						</button>
					)}
				</p>
			))}
			{!disabled && (
				<input
					aria-label="Add a topic"
					placeholder="Add a topic, like refunds or pricing"
					maxLength={HAND_OFF_TOPIC_MAX}
					value={text}
					onChange={(e) => setText(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							e.preventDefault();
							add();
						}
					}}
					onBlur={add}
					className={`${compactControlClass} w-full`}
				/>
			)}
		</div>
	);
}

type Agent = NonNullable<ReturnType<typeof useAgents>>[number];
const useAgents = () => useQuery(api.agents.list);

/** Its instructions in the page editor, saved a moment after you stop typing, as a new version (Settings → Agents shows them all). */
function Instructions({ agent, editable }: { agent: Agent; editable: boolean }) {
	const update = useMutation(api.agents.update);
	const { error, run } = useRun();
	const [status, setStatus] = useState<"saved" | "saving" | "">("");
	const pending = useRef<string | null>(null);
	// The latest saved agent, for the version and the rest of its config when the save goes.
	const latest = useRef(agent);
	latest.current = agent;
	const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
	const save = () => {
		const instructions = pending.current;
		pending.current = null;
		if (instructions === null || instructions === latest.current.instructions.trim()) return setStatus("");
		setStatus("saving");
		void run(update({ agentId: latest.current._id, expectedVersion: latest.current.version, config: { ...pickAgentConfig(latest.current), instructions } }), () => setStatus("saved"));
	};
	// Leaving with a change not yet saved saves it.
	useEffect(() => () => {
		clearTimeout(timer.current);
		save();
	}, []);
	return (
		<div className="flex flex-col gap-1">
			<div className="rounded-xl border border-neutral-200 py-2 pr-3">
				<MarkdownEditor
					label="Instructions"
					markdown={agent.instructions}
					editable={editable}
					onChange={(markdown) => {
						pending.current = markdown;
						setStatus("");
						clearTimeout(timer.current);
						timer.current = setTimeout(save, 1500);
					}}
				/>
			</div>
			<Notice>{error}</Notice>
			{status && <p className={metadataClass}>{status === "saving" ? "Saving…" : "Saved"}</p>}
		</div>
	);
}
