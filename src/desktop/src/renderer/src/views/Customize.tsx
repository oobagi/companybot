import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import type { Role } from "@companybot/core";
import { can } from "@companybot/core/permissions";
import { SKILL_DESCRIPTION_MAX, SKILL_NAME_MAX } from "@companybot/core/skills";
import { useAction, useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useQuery } from "convex-helpers/react/cache";
import { Fragment, useState } from "react";
import { api } from "../api";
import { Markdown } from "../markdown";
import {
	ConflictNotice,
	Field,
	Loading,
	Notice,
	Page,
	SaveBar,
	Section,
	Tabs,
	inputClass,
	primaryButton,
	secondaryButton,
	timeAgo,
	useDraft,
	useRun,
} from "../ui";
import { navigate } from "../router";
import { AgentScreen, AgentsTab } from "./Agents";

export const customizeTabs = [
	{ id: "agents", label: "Agents" },
	{ id: "connectors", label: "Connectors" },
	{ id: "skills", label: "Skills" },
	{ id: "automations", label: "Automations" },
] as const;
export type CustomizeTab = (typeof customizeTabs)[number]["id"];

/** The tab's list, or with `itemId`, that item's own screen. */
export function CustomizeView({ role, tab, itemId }: { role: Role; tab: CustomizeTab; itemId?: string }) {
	if (itemId) {
		if (tab === "agents") return <AgentScreen role={role} agentId={itemId as Id<"agents">} />;
		if (tab === "connectors") return <ConnectorScreen role={role} id={itemId} />;
		if (tab === "skills") return <SkillScreen role={role} id={itemId} />;
		return <AutomationScreen role={role} id={itemId} />;
	}
	return (
		<Page title="Customize" subtitle="Shape your agents, connect your tools, teach new skills, and automate routine work.">
			<Tabs tabs={customizeTabs} value={tab} onChange={(t) => navigate("customize", t)} />
			{tab === "agents" && <AgentsTab role={role} />}
			{tab === "connectors" && <ConnectorsTab role={role} />}
			{tab === "skills" && <SkillsTab role={role} />}
			{tab === "automations" && <AutomationsTab role={role} />}
		</Page>
	);
}

// ---- Connectors ----

type ConnectorItem = FunctionReturnType<typeof api.connectors.list>[number];

function ConnectorsTab({ role }: { role: Role }) {
	const connectors = useQuery(api.connectors.list);
	const setInstalled = useMutation(api.connectors.setInstalled);
	const { error, run } = useRun();
	if (!connectors) return <Loading />;
	const isOwner = can(role, "connectors.manage");
	const toggle = (p: ConnectorItem) => run(setInstalled({ connectorId: p.id, installed: !p.installed }));

	return (
		<>
			<p className="text-sm text-neutral-500">
				Connect outside services like Gmail or Calendar. Agents granted a connector use it for the person they're helping.
			</p>
			{error && <Notice>{error}</Notice>}
			{connectors.length === 0 && <p className="text-sm text-neutral-400">No connectors available yet.</p>}
			{connectors.map((p) => (
				<Card
					key={p.id}
					title={p.name}
					meta={`${p.publisher} · v${p.version}`}
					description={p.description}
					status={p.installed ? connectorStatus(p) : undefined}
					installed={p.installed}
					canManage={isOwner}
					onToggle={() => toggle(p)}
					onOpen={() => navigate("customize", "connectors", p.id)}
				/>
			))}
		</>
	);
}

function connectorStatus(p: ConnectorItem) {
	if (!p.canUse) return "Your role can't use it";
	if (p.auth.type === "none") return "Ready";
	if (p.error) return "Connection failing";
	return p.connected ? "Connected" : "Not connected";
}

function ConnectorScreen({ role, id }: { role: Role; id: string }) {
	const connectors = useQuery(api.connectors.list);
	const connector = connectors?.find((p) => p.id === id);
	if (!connector) return <Missing tab="connectors" loaded={!!connectors} />;
	return <ConnectorDetail connector={connector} isOwner={can(role, "connectors.manage")} />;
}

function ConnectorDetail({ connector, isOwner }: { connector: ConnectorItem; isOwner: boolean }) {
	const setInstalled = useMutation(api.connectors.setInstalled);
	const setRoles = useMutation(api.connectors.setRoles);
	const { error, run } = useRun();
	const signIn = { none: "None needed", api_key: "API key", oauth: "Sign in through your browser" }[connector.auth.type];

	return (
		<Detail
			tab="connectors"
			title={connector.name}
			meta={`${connector.publisher} · v${connector.version}`}
			description={connector.description}
			installed={connector.installed}
			canManage={isOwner}
			onToggle={() => run(setInstalled({ connectorId: connector.id, installed: !connector.installed }))}
		>
			{error && <Notice>{error}</Notice>}
			<Facts
				rows={[
					["Account", connector.connection === "personal" ? "Each person connects their own" : "One shared account for the workspace"],
					["Sign-in", signIn],
					["Tools", `Discovered from the connector each turn. Grant "${connector.id}.*" to an agent to use them.`],
					["Server", connector.server],
				]}
			/>
			{connector.installed && (
				<Section title="Access">
					<label className="flex items-center gap-2 text-sm">
						<span className="text-neutral-500">Who can use it</span>
						<select
							disabled={!isOwner}
							value={connector.roles.includes("member") ? "everyone" : "owners"}
							onChange={(e) =>
								run(setRoles({ connectorId: connector.id, roles: e.target.value === "everyone" ? ["owner", "member"] : ["owner"] }))
							}
							className="rounded-lg border border-neutral-200 px-2 py-1"
						>
							<option value="everyone">Everyone</option>
							<option value="owners">Owners only</option>
						</select>
					</label>
					<Connection connector={connector} />
				</Section>
			)}
		</Detail>
	);
}

function Connection({ connector }: { connector: ConnectorItem }) {
	const connect = useAction(api.connectors.connect);
	const startOAuth = useAction(api.connectors.startOAuth);
	const disconnect = useMutation(api.connectors.disconnect);
	const [key, setKey] = useState("");
	const { error, run } = useRun();

	return (
		<div className="flex flex-col gap-2 text-sm">
			{error && <Notice>{error}</Notice>}
			{connector.auth.type === "none" ? (
				<p className="text-emerald-700">Ready. No account needed.</p>
			) : connector.connected ? (
				<div className="flex items-center gap-3">
					<span className={connector.error ? "text-amber-700" : "text-emerald-700"}>
						{connector.error ? `Connected, but the last try failed: ${connector.error}` : "Connected"}
					</span>
					{connector.canConnect && (
						<button
							type="button"
							onClick={() => run(disconnect({ connectorId: connector.id }))}
							className="text-neutral-500 hover:text-red-600"
						>
							Disconnect
						</button>
					)}
				</div>
			) : connector.canUse && connector.canConnect && connector.auth.type === "oauth" ? (
				<div className="flex items-center gap-3">
					<button
						type="button"
						className={`${primaryButton} self-start`}
						// Opens in the browser (main process routes window.open there). The app
						// flips to Connected on its own once the sign-in finishes.
						onClick={() => run(startOAuth({ connectorId: connector.id }).then((url) => window.open(url)))}
					>
						Connect with {connector.name}
					</button>
					<span className="text-neutral-400">Opens your browser to sign in.</span>
				</div>
			) : connector.canUse && connector.canConnect ? (
				<form
					className="flex gap-2"
					onSubmit={(e) => {
						e.preventDefault();
						run(connect({ connectorId: connector.id, credentials: { type: "api_key", key } }), () => setKey(""));
					}}
				>
					<input
						type="password"
						value={key}
						onChange={(e) => setKey(e.target.value)}
						placeholder={connector.auth.type === "api_key" ? connector.auth.label : ""}
						className={`${inputClass} flex-1`}
					/>
					<button type="submit" className={primaryButton}>
						Connect
					</button>
				</form>
			) : (
				<p className="text-neutral-400">{connector.canUse ? "An owner needs to connect it." : "Your role can't use this connector."}</p>
			)}
			{connector.auth.type === "api_key" && connector.auth.help && !connector.connected && (
				<p className="text-xs text-neutral-400">{connector.auth.help}</p>
			)}
		</div>
	);
}

// ---- Skills ----

type SkillItem = FunctionReturnType<typeof api.skills.list>[number];

function SkillsTab({ role }: { role: Role }) {
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
			canManage={canManage}
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
		<Page title="New skill" back={{ label: "Skills", to: ["customize", "skills"] }}>
			{error && <Notice>{error}</Notice>}
			<div className="flex flex-col gap-5">
				<SkillFields value={config} onChange={setConfig} />
				<button
					type="button"
					className={`${primaryButton} self-start`}
					onClick={() => run(create({ config }).then((id) => navigate("customize", "skills", id)))}
				>
					Create
				</button>
			</div>
		</Page>
	);
}

function CustomSkillDetail({ skill: s, custom }: { skill: SkillItem; custom: NonNullable<SkillItem["custom"]> }) {
	const canManage = s.canEdit;
	const save = useMutation(api.skills.save);
	const setSkill = useMutation(api.skills.setInstalled);
	const saved: SkillConfig = { name: s.name, description: s.description, instructions: s.instructions };
	const draft = useDraft(saved, custom.version);
	const { error, run } = useRun();

	return (
		<Page
			title={s.name}
			subtitle={`Made by ${s.createdByName ?? "your team"} · v${custom.version} · edited by ${custom.updatedByName} ${timeAgo(custom.updatedAt)}`}
			back={{ label: "Skills", to: ["customize", "skills"] }}
			actions={
				canManage && (
					<button
						type="button"
						className="text-sm text-neutral-500 hover:text-neutral-900"
						onClick={() =>
							confirm(`Delete "${s.name}"? Agents stop seeing it, and it can't be restored.`) &&
							run(setSkill({ skillId: s.id, installed: false }), () => navigate("customize", "skills"))
						}
					>
						Delete
					</button>
				)
			}
		>
			{draft.stale && <ConflictNotice who={custom.updatedByName} onDiscard={draft.discard} onKeep={draft.keepMine} />}
			{error && <Notice>{error}</Notice>}
			{!canManage && <p className="text-sm text-neutral-500">Only the person who made it or an owner can change it.</p>}
			<fieldset disabled={!canManage} className="flex flex-col gap-5">
				<SkillFields value={draft.value} onChange={draft.set} />
			</fieldset>
			<Facts rows={[["Used by", 'Everyone\'s agents granted "skills.load", when a task calls for it']]} />
			{draft.dirty && (
				<SaveBar
					onDiscard={draft.discard}
					onSave={() => run(save({ skillId: s.id, config: draft.value, expectedVersion: draft.base }), draft.discard)}
				/>
			)}
		</Page>
	);
}

function SkillScreen({ role, id }: { role: Role; id: string }) {
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

// ---- Automations ----

type AutomationItem = FunctionReturnType<typeof api.automations.list>[number];
type Channel = { _id: Id<"chats">; title: string };
type Audience = "creator" | "subscribers" | "channel";

/** Schedules run in the installer's time zone. */
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

function AutomationsTab({ role }: { role: Role }) {
	const automations = useQuery(api.automations.list);
	const setInstalled = useMutation(api.automations.setInstalled);
	const subscribe = useMutation(api.automations.subscribe);
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
				canManage={canManage}
				onToggle={a.custom || offered ? undefined : () => run(setInstalled({ automationId: a.id, installed: !a.installed, timeZone }))}
				action={offered ? <SubscribeButton on={a.subscribed} onToggle={() => run(subscribe({ automationId: a.id, on: !a.subscribed }))} /> : undefined}
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

function SubscribeButton({ on, onToggle }: { on: boolean; onToggle: () => void }) {
	return (
		<button
			type="button"
			title={on ? "Turn off for you" : undefined}
			onClick={(e) => {
				e.stopPropagation();
				onToggle();
			}}
			className={`shrink-0 rounded-full px-3 py-1 text-sm ${on ? "bg-emerald-50 text-emerald-700" : "bg-neutral-900 text-white"}`}
		>
			{on ? "On for you" : "Turn on for me"}
		</button>
	);
}

function AutomationScreen({ role, id }: { role: Role; id: string }) {
	const automations = useQuery(api.automations.list);
	if (id === "new") return <NewAutomation />;
	const automation = automations?.find((a) => a.id === id);
	if (!automation) return <Missing tab="automations" loaded={!!automations} />;
	if (automation.custom) return <CustomAutomationDetail automation={automation} custom={automation.custom} />;
	return <AutomationDetail automation={automation} canManage={can(role, "automations.manage")} />;
}

type CustomConfig = NonNullable<AutomationItem["custom"]>["trigger"] extends infer T
	? { name: string; prompt: string; trigger: T }
	: never;

const weekdays = ["S", "M", "T", "W", "T", "F", "S"];
const weekdayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const defaultSchedule = { type: "schedule" as const, time: "09:00", weekdays: [1, 2, 3, 4, 5] };

/** Name, when, and what to ask: the parts of an automation someone writes. */
function AutomationFields({
	value,
	onChange,
	channels,
}: {
	value: CustomConfig;
	onChange: (value: CustomConfig) => void;
	channels: Channel[];
}) {
	const { trigger } = value;
	const option = (active: boolean) =>
		`rounded-full px-3 py-1 text-sm ${active ? "bg-neutral-900 text-white" : "border border-neutral-200 text-neutral-600 hover:bg-neutral-50"}`;
	const setTrigger = (t: CustomConfig["trigger"]) => onChange({ ...value, trigger: t });
	const firstChannel = channels[0]?._id ?? "";
	return (
		<>
			<Field label="Name">
				<input
					className={inputClass}
					value={value.name}
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
	const [config, setConfig] = useState<CustomConfig>({ name: "", prompt: "", trigger: defaultSchedule });
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
		<Page title="New automation" back={{ label: "Automations", to: ["customize", "automations"] }}>
			{error && <Notice>{error}</Notice>}
			<div className="flex flex-col gap-5">
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
				<button
					type="button"
					className={`${primaryButton} self-start`}
					onClick={() =>
						run(
							create({ config, agentId: agent as Id<"agents">, ...audience, timeZone }).then((id) =>
								navigate("customize", "automations", id),
							),
						)
					}
				>
					Create
				</button>
			</div>
		</Page>
	);
}

function CustomAutomationDetail({ automation: a, custom }: { automation: AutomationItem; custom: NonNullable<AutomationItem["custom"]> }) {
	const save = useMutation(api.automations.save);
	const setInstalled = useMutation(api.automations.setInstalled);
	const channels = useQuery(api.chats.list)?.channels ?? [];
	const saved: CustomConfig = { name: custom.name, prompt: custom.prompt, trigger: custom.trigger };
	const draft = useDraft(saved, custom.version);
	const { error, run } = useRun();

	return (
		<Page
			title={a.name}
			subtitle={`Made by ${a.createdByName} · v${custom.version} · edited by ${custom.updatedByName} ${timeAgo(custom.updatedAt)}`}
			back={{ label: "Automations", to: ["customize", "automations"] }}
			actions={
				a.canEdit && (
					<button
						type="button"
						className="text-sm text-neutral-500 hover:text-neutral-900"
						onClick={() =>
							confirm(`Delete "${a.name}"? It stops running and can't be restored.`) &&
							run(setInstalled({ automationId: a.id, installed: false, timeZone }), () => navigate("customize", "automations"))
						}
					>
						Delete
					</button>
				)
			}
		>
			{draft.stale && <ConflictNotice who={custom.updatedByName} onDiscard={draft.discard} onKeep={draft.keepMine} />}
			{error && <Notice>{error}</Notice>}
			<fieldset disabled={!a.canEdit} className="flex flex-col gap-5">
				<AutomationFields value={draft.value} onChange={draft.set} channels={channels} />
			</fieldset>
			<AutomationSettings automation={a} />
			{draft.dirty && (
				<SaveBar
					onDiscard={draft.discard}
					onSave={() => run(save({ automationId: a.id, config: draft.value, expectedVersion: draft.base }), draft.discard)}
				/>
			)}
		</Page>
	);
}

function AutomationDetail({ automation: a, canManage }: { automation: AutomationItem; canManage: boolean }) {
	const setInstalled = useMutation(api.automations.setInstalled);
	const { error, run } = useRun();

	return (
		<Detail
			tab="automations"
			title={a.name}
			meta={`${a.publisher} · v${a.version}`}
			description={a.description}
			installed={a.installed}
			canManage={canManage}
			onToggle={() => run(setInstalled({ automationId: a.id, installed: !a.installed, timeZone }))}
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
	const subscribe = useMutation(api.automations.subscribe);
	const runNow = useMutation(api.automations.runNow);
	const resetWebhook = useMutation(api.automations.resetWebhook);
	const channels = useQuery(api.chats.list)?.channels ?? [];
	const { error, run } = useRun();
	const [ran, setRan] = useState(false);
	const [copied, setCopied] = useState(false);
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
						<SubscribeButton on={a.subscribed} onToggle={() => run(subscribe({ automationId: a.id, on: !a.subscribed }))} />
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
								onClick={() => run(update({ automationId: a.id, enabled: !a.enabled }))}
								className={`rounded-full px-3 py-1 ${a.enabled ? "bg-emerald-50 text-emerald-700" : "bg-neutral-100 text-neutral-600"}`}
							>
								{a.enabled ? "Running" : "Paused"}
							</button>
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

// ---- Shared ----

/** A library item. Click to open its detail page; the button, if any, installs or removes it. */
function Card(props: {
	title: string;
	meta: string;
	description: string;
	status?: string;
	installed: boolean;
	canManage: boolean;
	/** Without it there's no install button (things your team made are deleted from their page). */
	onToggle?: () => void;
	/** Shown in place of the install button. */
	action?: React.ReactNode;
	onOpen: () => void;
}) {
	return (
		// A div, not a button: it holds the install button.
		<div
			role="button"
			tabIndex={0}
			onClick={props.onOpen}
			onKeyDown={(e) => e.key === "Enter" && e.target === e.currentTarget && props.onOpen()}
			className="flex items-start justify-between gap-4 rounded-xl border border-neutral-200 p-4 text-left hover:bg-neutral-50"
		>
			<div className="min-w-0">
				<h3 className="font-medium">
					{props.title} <span className="text-xs font-normal text-neutral-400">{props.meta}</span>
				</h3>
				<p className="line-clamp-2 text-sm text-neutral-500">{props.description}</p>
				{props.status && <p className="mt-1 text-xs text-neutral-400">{props.status}</p>}
			</div>
			{props.action}
			{props.onToggle && (
				<InstallButton
					installed={props.installed}
					canManage={props.canManage}
					onToggle={(e) => {
						e.stopPropagation();
						props.onToggle?.();
					}}
				/>
			)}
		</div>
	);
}

function InstallButton({
	installed,
	canManage,
	onToggle,
}: {
	installed: boolean;
	canManage: boolean;
	onToggle: (e: React.MouseEvent) => void;
}) {
	return (
		<button
			type="button"
			disabled={!canManage}
			title={canManage ? (installed ? "Remove" : undefined) : "Only owners can install"}
			onClick={onToggle}
			className={`shrink-0 rounded-full px-3 py-1 text-sm disabled:opacity-50 ${
				installed ? "border border-neutral-200 text-neutral-600" : "bg-neutral-900 text-white"
			}`}
		>
			{installed ? "Installed" : "Install"}
		</button>
	);
}

/** An item's own screen, pushed over its tab's list. */
function Detail(props: {
	tab: Exclude<CustomizeTab, "agents">;
	title: string;
	meta: string;
	description: string;
	installed: boolean;
	canManage: boolean;
	onToggle: () => void;
	children: React.ReactNode;
}) {
	const label = customizeTabs.find((t) => t.id === props.tab)!.label;
	return (
		<Page
			title={props.title}
			subtitle={props.meta}
			back={{ label, to: ["customize", props.tab] }}
			actions={<InstallButton installed={props.installed} canManage={props.canManage} onToggle={props.onToggle} />}
		>
			<p className="-mt-3 text-neutral-600">{props.description}</p>
			{props.children}
		</Page>
	);
}

/** Loading, or a link that no longer points at anything. */
/** Loading while `loaded` is false; after that, the item is gone (deleted, or a stale link). */
function Missing({ tab, loaded }: { tab: CustomizeTab; loaded: boolean }) {
	const label = customizeTabs.find((t) => t.id === tab)!.label;
	return (
		<Page title={loaded ? "Not found" : ""} back={{ label, to: ["customize", tab] }}>
			{loaded ? <p className="text-sm text-neutral-500">It may have been deleted.</p> : <Loading />}
		</Page>
	);
}

function Facts({ rows }: { rows: [string, string][] }) {
	return (
		<dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 rounded-xl border border-neutral-200 px-4 py-3 text-sm">
			{rows.map(([label, value]) => (
				<Fragment key={label}>
					<dt className="text-neutral-500">{label}</dt>
					<dd className="break-words">{value}</dd>
				</Fragment>
			))}
		</dl>
	);
}
