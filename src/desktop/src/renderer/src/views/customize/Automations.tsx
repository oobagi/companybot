import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import { Segmented, Select } from "../../controls";
import { type AutomationAudience as Audience, CUSTOM_NAME_MAX, type CustomAutomationConfig } from "@companybot/core/automations";
import { type Role, can } from "@companybot/core/permissions";
import type { FunctionReturnType } from "convex/server";
import { useState } from "react";
import { agentOptions } from "../../agent-options";
import { api } from "../../api";
import { useMutation, useQuery } from "../../convex";
import { AutomationIcon } from "../../icons";
import { Markdown } from "../../markdown";
import { navigate } from "../../router";
import { Field, Loading, Notice, Page, Section, compactControlClass, descriptionClass, inputClass, secondaryButton, timeAgo, useRun } from "../../ui";
import { useTurnOn } from "../Permissions";
import { deviceTimeZone, useConfirm } from "../chat/common";
import { Card, Detail, Facts, ItemList, MadeItemDetail, Missing, NewItem, customizeCrumbs } from "./shared";

type AutomationItem = FunctionReturnType<typeof api.automations.list>[number];
type Channel = { _id: Id<"chats">; title: string };

export function AutomationsTab() {
	const automations = useQuery(api.automations.list);
	const { error, run } = useRun();
	if (!automations) return <Loading />;
	const card = (a: AutomationItem) => {
		const offered = a.installed && a.audience === "subscribers";
		return (
			<Card
				key={a.id}
				title={a.name}
				meta={a.trigger}
				description={a.custom ? a.prompt : a.description}
				status={a.installed ? statusLine(a) : undefined}
				action={offered ? <SubscribeButton automation={a} onError={run} /> : undefined}
				onOpen={() => navigate("settings", "automations", a.id)}
			/>
		);
	};

	return (
		<ItemList
			items={automations}
			icon={<AutomationIcon />} title="No automations yet" empty="Let an agent handle routine work on a schedule or event."
			error={error}
			card={card}
		/>
	);
}

/** "On for you · Companybot", "Posts in #sales · Off", "Just you · Companybot". */
function statusLine(a: AutomationItem) {
	const who =
		a.audience === "channel"
			? `Posts in #${a.channelName}`
			: a.audience === "creator"
				? `Just ${a.createdByName ?? "its creator"}`
				: a.subscribed
					? `On for you${a.subscriberCount > 1 ? ` and ${a.subscriberCount - 1} more` : ""}`
					: `${a.subscriberCount} ${a.subscriberCount === 1 ? "person has" : "people have"} it on`;
	return `${who} · ${a.enabled ? (a.agentName ?? "No agent") : "Paused"}`;
}

/** Confirm turn-on; actions request consent when first used. Turning off revokes grants. */
function SubscribeButton({ automation: a, onError }: { automation: AutomationItem; onError: (p: Promise<unknown>) => void }) {
	const subscribe = useMutation(api.automations.subscribe);
	const on = a.subscribed;
	const turnOn = useTurnOn(a.name, () => subscribe({ automationId: a.id, on: true }));
	return (
		// The dialog sits inside a clickable card: keep its clicks from opening the card.
		<span className="contents" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
			<button
				type="button"
				title={on ? "Turn off for you" : undefined}
				onClick={() => onError(on ? subscribe({ automationId: a.id, on: false }) : Promise.resolve(turnOn.start()))}
				className={`shrink-0 rounded-full px-3 py-1 text-sm ${on ? "bg-emerald-50 text-emerald-700" : "bg-neutral-900 text-white"}`}
			>
				{on ? "On for you" : "Turn on for me"}
			</button>
			{turnOn.dialog}
		</span>
	);
}

export function AutomationScreen({ role, id }: { role: Role; id: string }) {
	const automations = useQuery(api.automations.list);
	if (id === "new") return <NewAutomation />;
	const automation = automations?.find((a) => a.id === id);
	if (!automation) return <Missing tab="automations" loaded={!!automations} />;
	if (automation.custom) return <CustomAutomationDetail automation={automation} custom={automation.custom} />;
	return <AutomationDetail automation={automation} canManage={can(role, "automations.manage")} />;
}

const weekdays = ["S", "M", "T", "W", "T", "F", "S"];
const weekdayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const defaultSchedule = { type: "schedule" as const, time: "09:00", weekdays: [1, 2, 3, 4, 5] };

/** Name, when, and what to ask: the parts of an automation someone writes. */
function AutomationFields({
	value,
	onChange,
	channels,
}: {
	value: CustomAutomationConfig;
	onChange: (value: CustomAutomationConfig) => void;
	channels: Channel[];
}) {
	const { trigger } = value;
	const setTrigger = (t: CustomAutomationConfig["trigger"]) => onChange({ ...value, trigger: t });
	const firstChannel = channels[0]?._id ?? "";
	const triggers: { label: string; value: CustomAutomationConfig["trigger"] }[] = [
		{ label: "On a schedule", value: defaultSchedule },
		{ label: "When something happens here", value: firstChannel ? { type: "event", event: "message.posted", channelId: firstChannel } : { type: "event", event: "member.joined" } },
		{ label: "When another app sends a webhook", value: { type: "webhook" } },
	];
	return (
		<>
			<Field label="Name">
				<input
					className={inputClass}
					value={value.name}
					maxLength={CUSTOM_NAME_MAX}
					placeholder="e.g. Weekly team update"
					onChange={(e) => onChange({ ...value, name: e.target.value })}
				/>
			</Field>
			{/* Not a Field: a <label> around buttons would press the first one when its text is clicked. */}
			<div role="group" aria-label="When" className="flex flex-col gap-1.5">
				<span className="text-sm font-medium">When</span>
				<div className="flex flex-col gap-3">
					<div>
						<Segmented
							value={trigger.type}
							options={triggers.map(({ label, value }) => ({ value: value.type, label }))}
							onChange={(type) => {
								const next = triggers.find((t) => t.value.type === type)!.value;
								if (trigger.type !== type || type === "webhook") setTrigger(next);
							}}
						/>
					</div>
					{trigger.type === "schedule" && (
						<div className="flex flex-wrap items-center gap-3">
							<div className="flex gap-1">
								{weekdays.map((d, i) => {
									const on = trigger.weekdays.includes(i);
									return (
										<button
											key={weekdayNames[i]}
											type="button"
											title={weekdayNames[i]}
											aria-pressed={on}
											className={`size-8 rounded-full text-sm ${on ? "bg-neutral-900 text-white" : "border border-neutral-200 text-neutral-600"}`}
											onClick={() =>
												setTrigger({ ...trigger, weekdays: on ? trigger.weekdays.filter((x) => x !== i) : [...trigger.weekdays, i] })
											}
										>
											{d}
										</button>
									);
								})}
							</div>
							<span className={descriptionClass}>at</span>
							<input
								type="time"
								className={compactControlClass}
								value={trigger.time}
								onChange={(e) => setTrigger({ ...trigger, time: e.target.value })}
							/>
						</div>
					)}
					{trigger.type === "event" && (
						<div className="flex flex-wrap items-center gap-2 text-sm">
							<Select
								label="What happens"
								value={trigger.event}
								options={[
									{ value: "message.posted", label: "Someone posts in", disabled: !firstChannel },
									{ value: "member.joined", label: "Someone joins the workspace" },
								]}
								onChange={(event) =>
									setTrigger(event === "member.joined" ? { type: "event", event: "member.joined" } : { type: "event", event: "message.posted", channelId: firstChannel })
								}
							/>
							{trigger.event === "message.posted" && (
								<Select
									label="Channel"
									value={trigger.channelId}
									options={[
										// One it already watches that you can't see (an owner editing someone's): keep it selectable.
										...(channels.some((c) => c._id === trigger.channelId) ? [] : [{ value: trigger.channelId, label: "a channel you're not in" }]),
										...channels.map((c) => ({ value: c._id as string, label: `#${c.title}` })),
									]}
									onChange={(channelId) => setTrigger({ ...trigger, channelId })}
								/>
							)}
						</div>
					)}
					{trigger.type === "webhook" && (
						<p className={descriptionClass}>
							You'll get a URL to paste into the other app. Whatever it sends is handed to the agent with your prompt.
						</p>
					)}
				</div>
			</div>
			<Field label="What to ask the agent" hint="Sent to the agent each run, as if the person it runs for asked it.">
				<textarea
					className={`${inputClass} min-h-32`}
					value={value.prompt}
					placeholder="e.g. Summarize this week's conversations and highlight follow-ups."
					onChange={(e) => onChange({ ...value, prompt: e.target.value })}
				/>
			</Field>
		</>
	);
}

/** Who it runs for: just its creator, people who turn it on, or a channel. */
function RunsForSelect({
	audience,
	channelId,
	channels,
	allowCreator,
	disabled,
	onChange,
	extraChannel,
}: {
	audience: Audience;
	channelId: string | null;
	channels: Channel[];
	allowCreator: boolean;
	disabled?: boolean;
	onChange: (audience: Audience, channelId?: Id<"chats">) => void;
	/** The current channel if it isn't in the list (deleted, or you left it). */
	extraChannel?: { id: string; label: string };
}) {
	const value = audience === "channel" ? (channelId ?? "") : audience;
	return (
		<Select
			label="Runs for"
			disabled={disabled}
			className={inputClass}
			value={value}
			options={[
				...(allowCreator ? [{ value: "creator", label: "Just me" }] : []),
				{ value: "subscribers", label: "Anyone who turns it on" },
				...(extraChannel ? [{ value: extraChannel.id, label: extraChannel.label, group: "Post in a channel" }] : []),
				...channels.map((c) => ({ value: c._id as string, label: `#${c.title}`, group: "Post in a channel" })),
			]}
			onChange={(v) => (v === "creator" || v === "subscribers" ? onChange(v) : onChange("channel", v as Id<"chats">))}
		/>
	);
}

function NewAutomation() {
	const create = useMutation(api.automations.create);
	const agents = useQuery(api.agents.list)?.filter((x) => !x.archived);
	const channels = useQuery(api.chats.list)?.channels ?? [];
	const { error, run } = useRun();
	const [config, setConfig] = useState<CustomAutomationConfig>({ name: "", prompt: "", trigger: defaultSchedule });
	const [agentId, setAgentId] = useState<string>("");
	const [audience, setAudience] = useState<{ audience: Audience; channelId?: Id<"chats"> }>({ audience: "creator" });
	if (!agents) return <Missing tab="automations" loaded={false} />;
	const agent = agentId || agents[0]?._id || "";
	if (!agent)
		return (
			<Page title="New automation" crumbs={customizeCrumbs("automations")}>
				<Notice>Automations need an agent to run them. Ask an owner to create one in Agents.</Notice>
			</Page>
		);

	return (
		<NewItem
			tab="automations"
			noun="automation"
			error={error}
			// Schedules run in the installer's time zone.
			onCreate={() =>
				run(create({ config, agentId: agent as Id<"agents">, ...audience, timeZone: deviceTimeZone() }).then((id) => navigate("settings", "automations", id)))
			}
		>
			<AutomationFields value={config} onChange={setConfig} channels={channels} />
			<Field label="Agent">
				<Select className={inputClass} value={agent} options={agentOptions(agents)} onChange={setAgentId} />
			</Field>
			<Field label="Runs for" hint="Nobody gets messages they didn't ask for: others choose whether to turn it on.">
				<RunsForSelect
					audience={audience.audience}
					channelId={audience.channelId ?? null}
					channels={channels}
					allowCreator
					onChange={(a, channelId) => setAudience({ audience: a, channelId })}
				/>
			</Field>
		</NewItem>
	);
}

function CustomAutomationDetail({ automation: a, custom }: { automation: AutomationItem; custom: NonNullable<AutomationItem["custom"]> }) {
	const save = useMutation(api.automations.save);
	const remove = useMutation(api.automations.remove);
	const channels = useQuery(api.chats.list)?.channels ?? [];

	return (
		<MadeItemDetail<CustomAutomationConfig>
			tab="automations"
			name={a.name}
			createdByName={a.createdByName}
			canEdit={a.canEdit}
			custom={custom}
			saved={{ name: custom.name, prompt: custom.prompt, trigger: custom.trigger }}
			trash={a.trash}
			onDelete={() => remove({ automationId: a.id })}
			onSave={(config, expectedVersion) => save({ automationId: a.id, config, expectedVersion })}
			fields={(value, onChange) => <AutomationFields value={value} onChange={onChange} channels={channels} />}
		>
			{!a.trash && <AutomationSettings automation={a} />}
		</MadeItemDetail>
	);
}

function AutomationDetail({ automation: a, canManage }: { automation: AutomationItem; canManage: boolean }) {
	const remove = useMutation(api.automations.remove);
	const { error, busy, run } = useRun();

	return (
		<Detail
			tab="automations"
			title={a.name}
			meta={`${a.publisher} · v${a.version}`}
			description={a.description}
			installed={a.installed}
			trash={a.trash}
			canManage={canManage}
			confirmation="It stops running. Its content is kept in Archive, and you can restore it at any time."
			busy={busy}
			onToggle={() => run(remove({ automationId: a.id }))}
		>
			<Notice>{error}</Notice>
			<Markdown className="text-sm leading-relaxed text-neutral-700">{a.details}</Markdown>
			<Facts
				rows={[
					["When", a.scheduled && a.timeZone ? `${a.trigger} (${a.timeZone})` : a.trigger],
					...(a.runsFor ? [["Runs for", a.runsFor] as [string, string]] : []),
				]}
			/>
			{a.installed && !a.trash && <AutomationSettings automation={a} />}
			<Section title="What the agent is asked" hint="Sent to the agent each run, as if the person it runs for asked it.">
				<Markdown className="rounded-xl bg-neutral-50 px-4 py-3 text-sm leading-relaxed">{a.prompt}</Markdown>
			</Section>
		</Detail>
	);
}

/** Turning it on for yourself, and (for people who can change it) on/off, agent, who it runs for, webhook URL, and Run now. */
function AutomationSettings({ automation: a }: { automation: AutomationItem }) {
	const agents = useQuery(api.agents.list);
	const update = useMutation(api.automations.update);
	const runNow = useMutation(api.automationRuns.runNow);
	const resetWebhook = useMutation(api.automations.resetWebhook);
	const channels = useQuery(api.chats.list)?.channels ?? [];
	const { error, run } = useRun();
	const { confirm, dialog } = useConfirm();
	const [ran, setRan] = useState(false);
	const [copied, setCopied] = useState(false);
	const resume = useTurnOn(a.name, () => update({ automationId: a.id, enabled: true }));
	const active = agents?.filter((x) => !x.archived) ?? [];
	const row = "flex items-center gap-2";
	const label = "w-20 shrink-0 text-neutral-500";

	return (
		<Section title="Settings">
			{dialog}
			<div className="flex flex-col gap-3 text-sm">
				<Notice>{error}</Notice>
				{a.audience === "subscribers" && (
					<div className={row}>
						<span className={label}>For you</span>
						<SubscribeButton automation={a} onError={run} />
						<span className="text-neutral-400">
							{a.subscriberCount} {a.subscriberCount === 1 ? "person has" : "people have"} it on
						</span>
					</div>
				)}
				{a.canEdit && (
					<>
						<div className={row}>
							<span className={label}>Status</span>
							<button
								type="button"
								onClick={() => run(a.enabled ? update({ automationId: a.id, enabled: false }) : Promise.resolve(resume.start()))}
								className={`rounded-full px-3 py-1 ${a.enabled ? "bg-emerald-50 text-emerald-700" : "bg-neutral-100 text-neutral-600"}`}
							>
								{a.enabled ? "Running" : "Paused"}
							</button>
							{resume.dialog}
						</div>
						<label className={row}>
							<span className={label}>Agent</span>
							<Select
								value={a.agentId ?? ""}
								options={[...(a.agentArchived ? [{ value: a.agentId ?? "", label: `${a.agentName} (deleted)` }] : []), ...agentOptions(active)]}
								onChange={(id) => run(update({ automationId: a.id, agentId: id as Id<"agents"> }))}
							/>
						</label>
						<div className={row}>
							<span className={label}>Runs for</span>
							<RunsForSelect
								audience={a.audience ?? "subscribers"}
								channelId={a.channelId}
								channels={channels}
								allowCreator={!!a.custom}
								extraChannel={
									a.channelId && !channels.some((c) => c._id === a.channelId)
										? { id: a.channelId, label: `#${a.channelName}${a.channelArchived ? " (deleted)" : ""}` }
										: undefined
								}
								// Posting in a channel runs as you: ask first, like turning it on.
								onChange={(audience, channelId) => {
									const save = () => update({ automationId: a.id, audience, channelId });
									run(audience === "channel" ? Promise.resolve(resume.start(save)) : save());
								}}
							/>
						</div>
					</>
				)}
				{a.webhookUrl && (
					<div className="flex flex-col gap-1">
						<div className={row}>
							<span className={label}>Webhook</span>
							<input
								readOnly
								value={a.webhookUrl}
								onFocus={(e) => e.target.select()}
								className={`${inputClass} min-w-0 flex-1 py-1 font-mono text-xs`}
							/>
							<button
								type="button"
								className={secondaryButton}
								onClick={() => navigator.clipboard.writeText(a.webhookUrl!).then(() => setCopied(true))}
							>
								{copied ? "Copied" : "Copy"}
							</button>
							<button
								type="button"
								className={secondaryButton}
								onClick={() =>
									confirm({ title: "Make a new URL?", action: "Make a new URL", body: "The current one stops working right away.", onConfirm: () => resetWebhook({ automationId: a.id }).then(() => setCopied(false)) })
								}
							>
								New URL
							</button>
						</div>
						<p className="pl-[5.5rem] text-neutral-400">
							Paste this into the app that sends the webhook. Keep it secret: anyone with it can trigger this automation.
						</p>
					</div>
				)}
				<p className="text-neutral-500">{a.lastRunAt ? `Last ran ${timeAgo(a.lastRunAt)}. ${a.lastResult ?? ""}` : "Hasn't run yet."}</p>
				{a.canEdit && (
					<div className="flex items-center gap-3">
						<button
							type="button"
							className={`${secondaryButton} self-start`}
							onClick={() => run(runNow({ automationId: a.id }), () => setRan(true))}
						>
							Run now
						</button>
						<span className="text-neutral-400">
							{ran
								? `Sent. Check your chat with ${a.agentName}.`
								: a.scheduled
									? "Runs once, just for you."
									: "Runs once with a sample, just for you."}
						</span>
					</div>
				)}
			</div>
		</Section>
	);
}
