import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import type { Role } from "@companybot/core";
import { type AutomationAudience as Audience, CUSTOM_NAME_MAX, type CustomAutomationConfig } from "@companybot/core/automations";
import { can } from "@companybot/core/permissions";
import type { FunctionReturnType } from "convex/server";
import { useState } from "react";
import { api } from "../../api";
import { useMutation, useQuery } from "../../convex";
import { Markdown } from "../../markdown";
import { navigate } from "../../router";
import { Field, Loading, Notice, Page, Section, inputClass, primaryButton, secondaryButton, timeAgo, useRun } from "../../ui";
import { AutomationPermissions, useTurnOn } from "../Permissions";
import { Card, Detail, Facts, MadeItemDetail, Missing, NewItem } from "./shared";

type AutomationItem = FunctionReturnType<typeof api.automations.list>[number];
type Channel = { _id: Id<"chats">; title: string };

/** Schedules run in the installer's time zone. */
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

export function AutomationsTab({ role }: { role: Role }) {
	const automations = useQuery(api.automations.list);
	const setInstalled = useMutation(api.automations.setInstalled);
	const remove = useMutation(api.automations.remove);
	const { error, run } = useRun();
	if (!automations) return <Loading />;
	const canManage = can(role, "automations.manage");
	const ours = automations.filter((a) => a.custom);
	const library = automations.filter((a) => !a.custom);
	const card = (a: AutomationItem) => {
		const offered = a.installed && a.audience === "subscribers";
		return (
			<Card
				key={a.id}
				title={a.name}
				meta={a.trigger}
				description={a.custom ? a.prompt : a.description}
				status={a.installed ? statusLine(a) : undefined}
				installed={a.installed}
				canManage={a.custom ? a.canEdit : canManage}
				onToggle={a.custom || offered ? undefined : () => run(a.installed ? remove({ automationId: a.id }) : setInstalled({ automationId: a.id, installed: true, timeZone }))}
				action={offered ? <SubscribeButton automation={a} onError={run} /> : undefined}
				onOpen={() => navigate("customize", "automations", a.id)}
			/>
		);
	};

	return (
		<>
			<div className="flex items-start justify-between gap-4">
				<p className="text-sm text-neutral-500">
					Jobs that run on their own: on a schedule, when something happens here, or when another app sends a webhook. Each one asks
					an agent to do something. Turn on the ones you want.
				</p>
				{can(role, "automations.create") && (
					<button type="button" className={`${primaryButton} shrink-0`} onClick={() => navigate("customize", "automations", "new")}>
						New automation
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

/** "Turn on for me" asks once for what it will do (useTurnOn); turning off takes that back. */
function SubscribeButton({ automation: a, onError }: { automation: AutomationItem; onError: (p: Promise<unknown>) => void }) {
	const subscribe = useMutation(api.automations.subscribe);
	const on = a.subscribed;
	const turnOn = useTurnOn(a.id, a.name, () => subscribe({ automationId: a.id, on: true }));
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
	const option = (active: boolean) =>
		`rounded-full px-3 py-1 text-sm ${active ? "bg-neutral-900 text-white" : "border border-neutral-200 text-neutral-600 hover:bg-neutral-50"}`;
	const setTrigger = (t: CustomAutomationConfig["trigger"]) => onChange({ ...value, trigger: t });
	const firstChannel = channels[0]?._id ?? "";
	return (
		<>
			<Field label="Name">
				<input
					className={inputClass}
					value={value.name}
					maxLength={CUSTOM_NAME_MAX}
					placeholder="e.g. Weekly pipeline review"
					onChange={(e) => onChange({ ...value, name: e.target.value })}
				/>
			</Field>
			{/* Not a Field: a <label> around buttons would press the first one when its text is clicked. */}
			<div role="group" aria-label="When" className="flex flex-col gap-1.5">
				<span className="text-sm font-medium">When</span>
				<div className="flex flex-col gap-3">
					<div className="flex flex-wrap gap-2">
						<button
							type="button"
							aria-pressed={trigger.type === "schedule"}
							className={option(trigger.type === "schedule")}
							onClick={() => trigger.type !== "schedule" && setTrigger(defaultSchedule)}
						>
							On a schedule
						</button>
						<button
							type="button"
							aria-pressed={trigger.type === "event"}
							className={option(trigger.type === "event")}
							onClick={() =>
								trigger.type !== "event" &&
								setTrigger(firstChannel ? { type: "event", event: "message.posted", channelId: firstChannel } : { type: "event", event: "member.joined" })
							}
						>
							When something happens here
						</button>
						<button
							type="button"
							aria-pressed={trigger.type === "webhook"}
							className={option(trigger.type === "webhook")}
							onClick={() => setTrigger({ type: "webhook" })}
						>
							When another app sends a webhook
						</button>
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
							<span className="text-sm text-neutral-500">at</span>
							<input
								type="time"
								className={`${inputClass} py-1`}
								value={trigger.time}
								onChange={(e) => setTrigger({ ...trigger, time: e.target.value })}
							/>
						</div>
					)}
					{trigger.type === "event" && (
						<div className="flex flex-wrap items-center gap-2 text-sm">
							<select
								aria-label="What happens"
								className={`${inputClass} py-1`}
								value={trigger.event}
								onChange={(e) =>
									setTrigger(
										e.target.value === "member.joined"
											? { type: "event", event: "member.joined" }
											: { type: "event", event: "message.posted", channelId: firstChannel },
									)
								}
							>
								<option value="message.posted" disabled={!firstChannel}>
									Someone posts in
								</option>
								<option value="member.joined">Someone joins the workspace</option>
							</select>
							{trigger.event === "message.posted" && (
								<select
									aria-label="Channel"
									className={`${inputClass} py-1`}
									value={trigger.channelId}
									onChange={(e) => setTrigger({ ...trigger, channelId: e.target.value })}
								>
									{/* One it already watches that you can't see (an owner editing someone's): keep it selectable. */}
									{!channels.some((c) => c._id === trigger.channelId) && (
										<option value={trigger.channelId}>a channel you're not in</option>
									)}
									{channels.map((c) => (
										<option key={c._id} value={c._id}>
											#{c.title}
										</option>
									))}
								</select>
							)}
						</div>
					)}
					{trigger.type === "webhook" && (
						<p className="text-sm text-neutral-500">
							You'll get a URL to paste into the other app. Whatever it sends is handed to the agent with your prompt.
						</p>
					)}
				</div>
			</div>
			<Field label="What to ask the agent" hint="Sent to the agent each run, as if the person it runs for asked it.">
				<textarea
					className={`${inputClass} min-h-32`}
					value={value.prompt}
					placeholder="e.g. List deals that haven't moved in two weeks, with the next step for each."
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
	/** The current channel if it isn't in the list (archived, or you left it). */
	extraChannel?: { id: string; label: string };
}) {
	const value = audience === "channel" ? (channelId ?? "") : audience;
	return (
		<select
			aria-label="Runs for"
			disabled={disabled}
			className={inputClass}
			value={value}
			onChange={(e) => {
				const v = e.target.value;
				if (v === "creator" || v === "subscribers") onChange(v);
				else onChange("channel", v as Id<"chats">);
			}}
		>
			{allowCreator && <option value="creator">Just me</option>}
			<option value="subscribers">Anyone who turns it on</option>
			<optgroup label="Post in a channel">
				{extraChannel && <option value={extraChannel.id}>{extraChannel.label}</option>}
				{channels.map((c) => (
					<option key={c._id} value={c._id}>
						#{c.title}
					</option>
				))}
			</optgroup>
		</select>
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
			<Page title="New automation" back={{ label: "Automations", to: ["customize", "automations"] }}>
				<Notice>Automations need an agent to run them. Ask an owner to create one in Agents.</Notice>
			</Page>
		);

	return (
		<NewItem
			tab="automations"
			noun="automation"
			error={error}
			onCreate={() =>
				run(create({ config, agentId: agent as Id<"agents">, ...audience, timeZone }).then((id) => navigate("customize", "automations", id)))
			}
		>
			<AutomationFields value={config} onChange={setConfig} channels={channels} />
			<Field label="Agent">
				<select className={inputClass} value={agent} onChange={(e) => setAgentId(e.target.value)}>
					{agents.map((x) => (
						<option key={x._id} value={x._id}>
							{x.name}
						</option>
					))}
				</select>
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
			deleteWarning="It stops running and can't be restored."
			onDelete={() => remove({ automationId: a.id })}
			onSave={(config, expectedVersion) => save({ automationId: a.id, config, expectedVersion })}
			fields={(value, onChange) => <AutomationFields value={value} onChange={onChange} channels={channels} />}
		>
			<AutomationSettings automation={a} />
		</MadeItemDetail>
	);
}

function AutomationDetail({ automation: a, canManage }: { automation: AutomationItem; canManage: boolean }) {
	const setInstalled = useMutation(api.automations.setInstalled);
	const remove = useMutation(api.automations.remove);
	const { error, run } = useRun();

	return (
		<Detail
			tab="automations"
			title={a.name}
			meta={`${a.publisher} · v${a.version}`}
			description={a.description}
			installed={a.installed}
			canManage={canManage}
			onToggle={() => run(a.installed ? remove({ automationId: a.id }) : setInstalled({ automationId: a.id, installed: true, timeZone }))}
		>
			{error && <Notice>{error}</Notice>}
			<Markdown className="text-sm leading-relaxed text-neutral-700">{a.details}</Markdown>
			<Facts
				rows={[
					["When", a.scheduled && a.timeZone ? `${a.trigger} (${a.timeZone})` : a.trigger],
					...(a.runsFor ? [["Runs for", a.runsFor] as [string, string]] : []),
					["Needs", a.needs.length ? a.needs.map((n) => `${n.name} connector${n.installed ? "" : " (not installed)"}`).join(", ") : "Nothing extra"],
				]}
			/>
			{a.installed && <AutomationSettings automation={a} />}
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
	const [ran, setRan] = useState(false);
	const [copied, setCopied] = useState(false);
	const resume = useTurnOn(a.id, a.name, () => update({ automationId: a.id, enabled: true }));
	const active = agents?.filter((x) => !x.archived) ?? [];
	const ungranted = a.needs.filter((n) => !n.granted);
	const row = "flex items-center gap-2";
	const label = "w-20 shrink-0 text-neutral-500";

	return (
		<Section title="Settings">
			<div className="flex flex-col gap-3 text-sm">
				{error && <Notice>{error}</Notice>}
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
							<select
								value={a.agentId ?? ""}
								onChange={(e) => run(update({ automationId: a.id, agentId: e.target.value as Id<"agents"> }))}
								className={`${inputClass} py-1`}
							>
								{a.agentArchived && <option value={a.agentId ?? ""}>{a.agentName} (archived)</option>}
								{active.map((x) => (
									<option key={x._id} value={x._id}>
										{x.name}
									</option>
								))}
							</select>
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
										? { id: a.channelId, label: `#${a.channelName}${a.channelArchived ? " (archived)" : ""}` }
										: undefined
								}
								onChange={(audience, channelId) => run(update({ automationId: a.id, audience, channelId }))}
							/>
						</div>
					</>
				)}
				<AutomationPermissions automationId={a.id} name={a.name} />
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
									confirm("Make a new URL? The current one stops working right away.") &&
									run(resetWebhook({ automationId: a.id }), () => setCopied(false))
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
				{ungranted.length > 0 && (
					<p className="rounded-lg bg-amber-50 px-3 py-2 text-amber-900">
						{a.agentName} isn't granted {ungranted.map((n) => n.name).join(", ")}. Grant it in Agents, or pick another agent.
					</p>
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
