import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import { Segmented, Select } from "../../controls";
import { type AutomationAudience as Audience, CUSTOM_NAME_MAX, type CustomAutomationConfig, scheduleCron } from "@companybot/core/automations";
import { DEFAULT_CRON } from "@companybot/core/schedules";
import { type Access, can } from "@companybot/core/permissions";
import type { FunctionReturnType } from "convex/server";
import { useState } from "react";
import { agentOptions } from "../../agent-options";
import { api } from "../../api";
import { useMutation, useQuery } from "../../convex";
import { AutomationIcon } from "../../icons";
import { Markdown } from "../../markdown";
import { navigate } from "../../router";
import { Loading, Notice, Page, Section, Setting, Settings, compactButton, compactControlClass, descriptionClass, pillButton, timeAgo, useDraft, useRun, wideControlClass } from "../../ui";
import { useTurnOn } from "../Permissions";
import { PendingWakeups } from "../Wakeups";
import { deviceTimeZone, useConfirm } from "../chat/common";
import { ScheduleEditor } from "./ScheduleEditor";
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
		<div className="flex flex-col gap-6">
			<ItemList
				items={automations}
				icon={<AutomationIcon />} title="No automations yet" empty="Let an agent handle routine work on a schedule or event."
				error={error}
				card={card}
			/>
			<PendingWakeups title="Follow-ups" note="Times an agent will check back on its own, in the chat where it was asked." />
		</div>
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
				className={`${pillButton} ${on ? "bg-emerald-50 text-emerald-700" : "bg-neutral-900 text-white"}`}
			>
				{on ? "On for you" : "Turn on for me"}
			</button>
			{turnOn.dialog}
		</span>
	);
}

export function AutomationScreen({ access, id }: { access: Access; id: string }) {
	const automations = useQuery(api.automations.list);
	// Anyone can make one just for themselves; sharing it with the team takes the switch.
	const team = can(access, "automations.edit");
	if (id === "new") return <NewAutomation team={team} />;
	const automation = automations?.find((a) => a.id === id);
	if (!automation) return <Missing tab="automations" loaded={!!automations} />;
	if (automation.custom) return <CustomAutomationDetail automation={automation} custom={automation.custom} team={team} />;
	return <AutomationDetail automation={automation} canManage={team} />;
}

const defaultSchedule = { type: "schedule" as const, cron: DEFAULT_CRON };

/** Name, when, and what to ask: the parts of an automation someone writes, as one card. `children` are rows under them (Agent, Runs for). */
function AutomationFields({
	title,
	value,
	onChange,
	channels,
	timeZone,
	children,
}: { title?: string;
	value: CustomAutomationConfig;
	onChange: (value: CustomAutomationConfig) => void;
	channels: Channel[];
	/** Schedules run in it: the maker's, or this device's for a new one. */
	timeZone: string;
	children?: React.ReactNode;
}) {
	const { trigger } = value;
	const setTrigger = (t: CustomAutomationConfig["trigger"]) => onChange({ ...value, trigger: t });
	const firstChannel = channels[0]?._id ?? "";
	// Inbox events carry customers' messages, so only people who see Inbox can watch them (the server checks too).
	const me = useQuery(api.workspace.me);
	const inbox = !!me?.access && can(me.access, "inbox.use");
	const triggers: { label: string; value: CustomAutomationConfig["trigger"] }[] = [
		{ label: "On a schedule", value: defaultSchedule },
		{ label: "When something happens", value: firstChannel ? { type: "event", event: "message.posted", channelId: firstChannel } : { type: "event", event: "member.joined" } },
		{ label: "From another app (webhook)", value: { type: "webhook" } },
	];
	return (
		<Settings title={title}>
			<Setting label="Name">
				<input
					aria-label="Name"
					className={wideControlClass}
					value={value.name}
					maxLength={CUSTOM_NAME_MAX}
					placeholder="e.g. Weekly team update"
					onChange={(e) => onChange({ ...value, name: e.target.value })}
				/>
			</Setting>
			<Setting wide label="When">
				<div role="group" aria-label="When" className="flex min-w-0 flex-1 flex-col gap-3">
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
						<ScheduleEditor cron={scheduleCron(trigger)} timeZone={timeZone} onChange={(cron) => setTrigger({ type: "schedule", cron })} />
					)}
					{trigger.type === "event" && (
						<div className="flex flex-wrap items-center gap-2 text-sm">
							<Select
								label="What happens"
								value={trigger.event}
								options={[
									{ value: "message.posted", label: "Someone posts in", disabled: !firstChannel },
									{ value: "member.joined", label: "Someone joins the workspace" },
									{ value: "inbox.started", label: "Someone new emails or texts you", disabled: !inbox && trigger.event !== "inbox.started" },
									{ value: "inbox.received", label: "An email or text comes in", disabled: !inbox && trigger.event !== "inbox.received" },
								]}
								onChange={(event) =>
									setTrigger(event === "message.posted" ? { type: "event", event: "message.posted", channelId: firstChannel } : { type: "event", event: event as "member.joined" | "inbox.started" | "inbox.received" })
								}
							/>
							{trigger.event === "message.posted" && (
								<Select
									label="Channel"
									value={trigger.channelId}
									options={[
										// One it already watches that you can't see (someone with automations.edit editing another's): keep it selectable.
										...(channels.some((c) => c._id === trigger.channelId) ? [] : [{ value: trigger.channelId, label: "a channel you're not in" }]),
										...channels.map((c) => ({ value: c._id as string, label: `#${c.title}` })),
									]}
									onChange={(channelId) => setTrigger({ ...trigger, channelId })}
								/>
							)}
						</div>
					)}
					{trigger.type === "event" && (trigger.event === "inbox.started" || trigger.event === "inbox.received") && (
						<p className={descriptionClass}>
							The agent gets who wrote, how, and what they said, as data. It runs as you, with your permissions, never as the customer.
						</p>
					)}
					{trigger.type === "webhook" && (
						<p className={descriptionClass}>
							You'll get a URL to paste into the other app. Whatever it sends is handed to the agent with your prompt.
						</p>
					)}
				</div>
			</Setting>
			<Setting wide label="What to ask the agent" hint="Sent to the agent each run, as if the person it runs for asked it.">
				<textarea
					aria-label="What to ask the agent"
					className={`${compactControlClass} min-h-32 w-full`}
					value={value.prompt}
					placeholder="e.g. Summarize this week's conversations and highlight follow-ups."
					onChange={(e) => onChange({ ...value, prompt: e.target.value })}
				/>
			</Setting>
			{children}
		</Settings>
	);
}

/** Who it runs for: just its creator, people who turn it on, or a channel. `team`: whether the last two are offered. */
function RunsForSelect({
	audience,
	channelId,
	channels,
	allowCreator,
	team,
	disabled,
	onChange,
	extraChannel,
}: {
	audience: Audience;
	channelId: string | null;
	channels: Channel[];
	allowCreator: boolean;
	team: boolean;
	disabled?: boolean;
	onChange: (audience: Audience, channelId?: Id<"chats">) => void;
	/** The current channel if it isn't in the list (deleted, or you left it). */
	extraChannel?: { id: string; label: string };
}) {
	const value = audience === "channel" ? (channelId ?? "") : audience;
	// One that's already shared keeps showing where it goes, even to someone who can't change it.
	const shared = team || audience !== "creator";
	return (
		<Select
			label="Runs for"
			disabled={disabled}
			className={wideControlClass}
			value={value}
			options={[
				...(allowCreator ? [{ value: "creator", label: "Just me" }] : []),
				...(shared
					? [
							{ value: "subscribers", label: "Anyone who turns it on" },
							...(extraChannel ? [{ value: extraChannel.id, label: extraChannel.label, group: "Post in a channel" }] : []),
							...channels.map((c) => ({ value: c._id as string, label: `#${c.title}`, group: "Post in a channel" })),
						]
					: []),
			]}
			onChange={(v) => (v === "creator" || v === "subscribers" ? onChange(v) : onChange("channel", v as Id<"chats">))}
		/>
	);
}

function NewAutomation({ team }: { team: boolean }) {
	const create = useMutation(api.automations.create);
	const agents = useQuery(api.agents.list)?.filter((x) => !x.archived);
	const channels = useQuery(api.chats.list)?.channels ?? [];
	const { error, run } = useRun();
	const draft = useDraft<{ config: CustomAutomationConfig; agentId: string; audience: { audience: Audience; channelId?: Id<"chats"> } }>("automations:new", { config: { name: "", prompt: "", trigger: defaultSchedule }, agentId: "", audience: { audience: "creator" } }, 0);
	const { config: restoredConfig, agentId, audience: restoredAudience } = draft.value;
	const audience = restoredAudience.audience === "channel" && !channels.some((c) => c._id === restoredAudience.channelId) ? { audience: "creator" as const } : restoredAudience;
	const trigger = restoredConfig.trigger;
	const config = trigger.type === "event" && trigger.event === "message.posted" && !channels.some((c) => c._id === trigger.channelId) ? { ...restoredConfig, trigger: { type: "event" as const, event: "member.joined" as const } } : restoredConfig;
	const setConfig = (config: CustomAutomationConfig) => draft.set({ ...draft.value, config });
	const setAgentId = (agentId: string) => draft.set({ ...draft.value, agentId });
	const setAudience = (audience: typeof draft.value.audience) => draft.set({ ...draft.value, audience });

	if (!agents) return <Missing tab="automations" loaded={false} />;
	const agent = agents.find((a) => a._id === agentId)?._id || agents[0]?._id || "";
	if (!agent)
		return (
			<Page title="New automation" crumbs={customizeCrumbs("automations")}>
				<Notice>Automations need an agent to run them. Ask someone whose role can change agents to create one in Agents.</Notice>
			</Page>
		);

	return (
		<NewItem
			onDiscard={draft.dirty ? draft.discard : undefined}
			tab="automations"
			noun="automation"
			error={error}
			// Schedules run in the installer's time zone.
			onCreate={() =>
				run(create({ config, agentId: agent as Id<"agents">, ...audience, timeZone: deviceTimeZone() }).then((id) => { draft.discard(); navigate("settings", "automations", id); }))
			}
		>
			<AutomationFields value={config} onChange={setConfig} channels={channels} timeZone={deviceTimeZone()}>
				<Setting label="Agent">
					<Select label="Agent" className={wideControlClass} value={agent} options={agentOptions(agents)} onChange={setAgentId} />
				</Setting>
				<Setting
					label="Runs for"
					hint={
						team
							? "Nobody gets messages they didn't ask for: others choose whether to turn it on."
							: "Just for you. Sharing it with the team needs a role that can make and change team automations."
					}
				>
					<RunsForSelect
						audience={audience.audience}
						channelId={audience.channelId ?? null}
						channels={channels}
						allowCreator
						team={team}
						onChange={(a, channelId) => setAudience({ audience: a, channelId })}
					/>
				</Setting>
			</AutomationFields>
		</NewItem>
	);
}

function CustomAutomationDetail({ automation: a, custom, team }: { automation: AutomationItem; custom: NonNullable<AutomationItem["custom"]>; team: boolean }) {
	const save = useMutation(api.automations.save);
	const remove = useMutation(api.automations.remove);
	const channels = useQuery(api.chats.list)?.channels ?? [];

	return (
		<MadeItemDetail<CustomAutomationConfig>
			tab="automations"
			id={a.id}
			name={a.name}
			createdByName={a.createdByName}
			canEdit={a.canEdit}
			custom={custom}
			saved={{ name: custom.name, prompt: custom.prompt, trigger: custom.trigger.type === "schedule" ? { type: "schedule", cron: scheduleCron(custom.trigger) } : custom.trigger }}
			trash={a.trash}
			onDelete={() => remove({ automationId: a.id })}
			onSave={(config, expectedVersion) => save({ automationId: a.id, config, expectedVersion })}
			fields={(value, onChange) => <AutomationFields title="Automation" value={value} onChange={onChange} channels={channels} timeZone={a.timeZone} />}
		>
			{!a.trash && <AutomationSettings automation={a} team={team} />}
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
			{a.installed && !a.trash && <AutomationSettings automation={a} team={canManage} />}
			<Section title="What the agent is asked" note="Sent to the agent each run, as if the person it runs for asked it.">
				<Markdown className="rounded-xl bg-neutral-50 px-4 py-3 text-sm leading-relaxed">{a.prompt}</Markdown>
			</Section>
		</Detail>
	);
}

/** Turning it on for yourself, and (for people who can change it) on/off, agent, who it runs for, webhook URL, and Run now. */
function AutomationSettings({ automation: a, team }: { automation: AutomationItem; team: boolean }) {
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

	return (
		<>
			{dialog}
			{resume.dialog}
			<Notice>{error}</Notice>
			<Settings title="Settings" note={a.lastRunAt ? `Last ran ${timeAgo(a.lastRunAt)}. ${a.lastResult ?? ""}` : "Hasn't run yet."}>
				{a.audience === "subscribers" && (
					<Setting label="For you" hint={`${a.subscriberCount} ${a.subscriberCount === 1 ? "person has" : "people have"} it on`}>
						<SubscribeButton automation={a} onError={run} />
					</Setting>
				)}
				{a.canEdit && (
					<>
						<Setting label="Status" hint={a.enabled ? "It runs on its own." : "It won't run until you resume it."}>
							<Segmented
								label="Status"
								value={a.enabled ? "running" : "paused"}
								options={[{ value: "running" as const, label: "Running" }, { value: "paused" as const, label: "Paused" }]}
								onChange={(v) => (v === "running") !== a.enabled && run(a.enabled ? update({ automationId: a.id, enabled: false }) : Promise.resolve(resume.start()))}
							/>
						</Setting>
						<Setting label="Agent">
							<Select
								label="Agent"
								className={wideControlClass}
								value={a.agentId ?? ""}
								options={[...(a.agentArchived ? [{ value: a.agentId ?? "", label: `${a.agentName} (deleted)` }] : []), ...agentOptions(active)]}
								onChange={(id) => run(update({ automationId: a.id, agentId: id as Id<"agents"> }))}
							/>
						</Setting>
						<Setting label="Runs for">
							<RunsForSelect
								audience={a.audience ?? "subscribers"}
								channelId={a.channelId}
								channels={channels}
								allowCreator={!!a.custom}
								team={team}
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
						</Setting>
					</>
				)}
				{a.webhookUrl && (
					<Setting wide label="Webhook" hint="Paste this into the app that sends the webhook. Keep it secret: anyone with it can trigger this automation.">
						<input
							readOnly
							aria-label="Webhook URL"
							value={a.webhookUrl}
							onFocus={(e) => e.target.select()}
							className={`${compactControlClass} min-w-0 flex-1 font-mono text-xs`}
						/>
						<button
							type="button"
							className={compactButton}
							onClick={() => navigator.clipboard.writeText(a.webhookUrl!).then(() => setCopied(true))}
						>
							{copied ? "Copied" : "Copy"}
						</button>
						<button
							type="button"
							className={compactButton}
							onClick={() =>
								confirm({ title: "Make a new URL?", action: "Make a new URL", body: "The current one stops working right away.", onConfirm: () => resetWebhook({ automationId: a.id }).then(() => setCopied(false)) })
							}
						>
							New URL
						</button>
					</Setting>
				)}
				{a.canEdit && (
					<Setting
						label="Try it"
						hint={ran ? `Sent. Check your chat with ${a.agentName}.` : a.scheduled ? "Runs once, just for you." : "Runs once with a sample, just for you."}
					>
						<button type="button" className={compactButton} onClick={() => run(runNow({ automationId: a.id }), () => setRan(true))}>
							Run now
						</button>
					</Setting>
				)}
			</Settings>
		</>
	);
}
