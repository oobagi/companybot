import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import type { Role } from "@companybot/core";
import { can } from "@companybot/core/permissions";
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
	const connector = useQuery(api.connectors.list)?.find((p) => p.id === id);
	if (!connector) return <Missing tab="connectors" />;
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

function SkillsTab({ role }: { role: Role }) {
	const skills = useQuery(api.skills.list);
	const setSkill = useMutation(api.skills.setInstalled);
	const { error, run } = useRun();
	if (!skills) return <Loading />;
	const canManage = can(role, "skills.manage");

	return (
		<>
			<p className="text-sm text-neutral-500">Instructions your agents load when a task calls for them.</p>
			{error && <Notice>{error}</Notice>}
			{skills.map((s) => (
				<Card
					key={s.id}
					title={s.name}
					meta={`v${s.version}`}
					description={s.description}
					installed={s.installed}
					canManage={canManage}
					onToggle={() => run(setSkill({ skillId: s.id, installed: !s.installed }))}
					onOpen={() => navigate("customize", "skills", s.id)}
				/>
			))}
		</>
	);
}

function SkillScreen({ role, id }: { role: Role; id: string }) {
	const open = useQuery(api.skills.list)?.find((s) => s.id === id);
	const setSkill = useMutation(api.skills.setInstalled);
	const { error, run } = useRun();
	if (!open) return <Missing tab="skills" />;
	const canManage = can(role, "skills.manage");
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

/** Schedules run in the installer's time zone. */
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

function AutomationsTab({ role }: { role: Role }) {
	const automations = useQuery(api.automations.list);
	const setInstalled = useMutation(api.automations.setInstalled);
	const { error, run } = useRun();
	if (!automations) return <Loading />;
	const canManage = can(role, "automations.manage");
	const toggle = (a: AutomationItem) => run(setInstalled({ automationId: a.id, installed: !a.installed, timeZone }));
	const ours = automations.filter((a) => a.custom);
	const library = automations.filter((a) => !a.custom);
	const card = (a: AutomationItem) => (
		<Card
			key={a.id}
			title={a.name}
			meta={a.trigger}
			description={a.custom ? a.prompt : a.description}
			status={a.installed ? `${a.enabled ? "On" : "Off"} · ${a.agentName ?? "No agent"}` : undefined}
			installed={a.installed}
			canManage={canManage}
			onToggle={a.custom ? undefined : () => toggle(a)}
			onOpen={() => navigate("customize", "automations", a.id)}
		/>
	);

	return (
		<>
			<div className="flex items-start justify-between gap-4">
				<p className="text-sm text-neutral-500">
					Jobs that run on their own: on a schedule, or when another app sends a webhook. Each one asks an agent to do something
					and posts the reply.
				</p>
				{canManage && (
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

function AutomationScreen({ role, id }: { role: Role; id: string }) {
	const canManage = can(role, "automations.manage");
	const automations = useQuery(api.automations.list);
	if (id === "new") return <NewAutomation />;
	const automation = automations?.find((a) => a.id === id);
	if (!automation) return <Missing tab="automations" />;
	if (automation.custom) return <CustomAutomationDetail automation={automation} custom={automation.custom} canManage={canManage} />;
	return <AutomationDetail automation={automation} canManage={canManage} />;
}

type CustomConfig = { name: string; prompt: string; trigger: { type: "schedule"; time: string; weekdays: number[] } | { type: "webhook" } };

const weekdays = ["S", "M", "T", "W", "T", "F", "S"];
const weekdayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const defaultSchedule = { type: "schedule" as const, time: "09:00", weekdays: [1, 2, 3, 4, 5] };

/** Name, when, and what to ask: the parts of an automation an owner writes. */
function AutomationFields({ value, onChange }: { value: CustomConfig; onChange: (value: CustomConfig) => void }) {
	const { trigger } = value;
	const option = (active: boolean) =>
		`rounded-full px-3 py-1 text-sm ${active ? "bg-neutral-900 text-white" : "border border-neutral-200 text-neutral-600 hover:bg-neutral-50"}`;
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
					<div className="flex gap-2">
						<button
							type="button"
							className={option(trigger.type === "schedule")}
							aria-pressed={trigger.type === "schedule"}
							onClick={() => trigger.type !== "schedule" && onChange({ ...value, trigger: defaultSchedule })}
						>
							On a schedule
						</button>
						<button
							type="button"
							className={option(trigger.type === "webhook")}
							aria-pressed={trigger.type === "webhook"}
							onClick={() => onChange({ ...value, trigger: { type: "webhook" } })}
						>
							When another app sends a webhook
						</button>
					</div>
					{trigger.type === "schedule" ? (
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
												onChange({
													...value,
													trigger: { ...trigger, weekdays: on ? trigger.weekdays.filter((x) => x !== i) : [...trigger.weekdays, i] },
												})
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
								onChange={(e) => onChange({ ...value, trigger: { ...trigger, time: e.target.value } })}
							/>
						</div>
					) : (
						<p className="text-sm text-neutral-500">
							You'll get a URL to paste into the other app. Whatever it sends is handed to the agent with your prompt.
						</p>
					)}
				</div>
			</div>
			<Field label="What to ask the agent" hint="Sent to the agent each run, as if the person asked it.">
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

function NewAutomation() {
	const create = useMutation(api.automations.create);
	const agents = useQuery(api.agents.list)?.filter((x) => !x.archived);
	const channels = useQuery(api.chats.list)?.channels ?? [];
	const { error, run } = useRun();
	const [config, setConfig] = useState<CustomConfig>({ name: "", prompt: "", trigger: defaultSchedule });
	const [agentId, setAgentId] = useState<string>("");
	const [channelId, setChannelId] = useState<string>("");
	if (!agents) return <Missing tab="automations" />;
	const agent = agentId || agents[0]?._id || "";

	return (
		<Page title="New automation" back={{ label: "Automations", to: ["customize", "automations"] }}>
			{error && <Notice>{error}</Notice>}
			<div className="flex flex-col gap-5">
				<AutomationFields value={config} onChange={setConfig} />
				<Field label="Agent">
					<select className={inputClass} value={agent} onChange={(e) => setAgentId(e.target.value)}>
						{agents.map((x) => (
							<option key={x._id} value={x._id}>
								{x.name}
							</option>
						))}
					</select>
				</Field>
				<Field label="Posts to">
					<select className={inputClass} value={channelId} onChange={(e) => setChannelId(e.target.value)}>
						<option value="">
							{config.trigger.type === "schedule" ? "Each person's chat with the agent" : "The person the webhook names"}
						</option>
						{channels.map((c) => (
							<option key={c._id} value={c._id}>
								#{c.title}
							</option>
						))}
					</select>
				</Field>
				<button
					type="button"
					className={`${primaryButton} self-start`}
					onClick={() =>
						run(
							create({
								config,
								agentId: agent as Id<"agents">,
								channelId: (channelId || null) as Id<"chats"> | null,
								timeZone,
							}).then((id) => navigate("customize", "automations", id)),
						)
					}
				>
					Create
				</button>
			</div>
		</Page>
	);
}

function CustomAutomationDetail({
	automation: a,
	custom,
	canManage,
}: {
	automation: AutomationItem;
	custom: NonNullable<AutomationItem["custom"]>;
	canManage: boolean;
}) {
	const save = useMutation(api.automations.save);
	const setInstalled = useMutation(api.automations.setInstalled);
	const saved: CustomConfig = { name: custom.name, prompt: custom.prompt, trigger: custom.trigger };
	const draft = useDraft(saved, custom.version);
	const { error, run } = useRun();

	return (
		<Page
			title={a.name}
			subtitle={`Made by your team · v${custom.version} · edited by ${custom.updatedByName} ${timeAgo(custom.updatedAt)}`}
			back={{ label: "Automations", to: ["customize", "automations"] }}
			actions={
				canManage && (
					<button
						type="button"
						className="text-sm text-neutral-500 hover:text-neutral-900"
						onClick={() =>
							confirm(`Delete "${a.name}"? It stops running and can't be restored.`) &&
							run(setInstalled({ automationId: a.id, installed: false, timeZone }), () =>
								navigate("customize", "automations"),
							)
						}
					>
						Delete
					</button>
				)
			}
		>
			{draft.stale && <ConflictNotice who={custom.updatedByName} onDiscard={draft.discard} onKeep={draft.keepMine} />}
			{error && <Notice>{error}</Notice>}
			<fieldset disabled={!canManage} className="flex flex-col gap-5">
				<AutomationFields value={draft.value} onChange={draft.set} />
			</fieldset>
			<AutomationSettings automation={a} canManage={canManage} />
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
					["Runs for", a.runsFor],
					["Needs", a.needs.length ? a.needs.map((n) => `${n.name} connector${n.installed ? "" : " (not installed)"}`).join(", ") : "Nothing extra"],
				]}
			/>
			{a.installed && <AutomationSettings automation={a} canManage={canManage} />}
			<Section title="What the agent is asked" hint="Sent to the agent each run, as if the person asked it.">
				<Markdown className="rounded-xl bg-neutral-50 px-4 py-3 text-sm leading-relaxed">{a.prompt}</Markdown>
			</Section>
		</Detail>
	);
}

/** On/off, agent, where it posts, its webhook URL, last run, and Run now: the same for every installed automation. */
function AutomationSettings({ automation: a, canManage }: { automation: AutomationItem; canManage: boolean }) {
	const agents = useQuery(api.agents.list);
	const update = useMutation(api.automations.update);
	const runNow = useMutation(api.automations.runNow);
	const resetWebhook = useMutation(api.automations.resetWebhook);
	const channels = useQuery(api.chats.list)?.channels ?? [];
	const { error, run } = useRun();
	const [ran, setRan] = useState(false);
	const [copied, setCopied] = useState(false);
	const active = agents?.filter((x) => !x.archived) ?? [];
	const ungranted = a.needs.filter((n) => !n.granted);

	return (
		<Section title="Settings">
			<div className="flex flex-col gap-3 text-sm">
				{error && <Notice>{error}</Notice>}
				<label className="flex items-center gap-2">
					<span className="w-16 text-neutral-500">Status</span>
					<button
						type="button"
						disabled={!canManage}
						onClick={() => run(update({ automationId: a.id, enabled: !a.enabled }))}
						className={`rounded-full px-3 py-1 disabled:opacity-50 ${a.enabled ? "bg-emerald-50 text-emerald-700" : "bg-neutral-100 text-neutral-600"}`}
					>
						{a.enabled ? "On" : "Off"}
					</button>
				</label>
				<label className="flex items-center gap-2">
					<span className="w-16 text-neutral-500">Agent</span>
					<select
						disabled={!canManage}
						value={a.agentId ?? ""}
						onChange={(e) => run(update({ automationId: a.id, agentId: e.target.value as Id<"agents"> }))}
						className="rounded-lg border border-neutral-200 px-2 py-1"
					>
						{a.agentArchived && <option value={a.agentId ?? ""}>{a.agentName} (archived)</option>}
						{active.map((x) => (
							<option key={x._id} value={x._id}>
								{x.name}
							</option>
						))}
					</select>
				</label>
				<label className="flex items-center gap-2">
					<span className="w-16 text-neutral-500">Posts to</span>
					<select
						disabled={!canManage}
						value={a.channelId ?? ""}
						onChange={(e) => run(update({ automationId: a.id, channelId: (e.target.value || null) as Id<"chats"> | null }))}
						className="rounded-lg border border-neutral-200 px-2 py-1"
					>
						<option value="">{a.scheduled ? "Each person's chat with the agent" : "The person the webhook names"}</option>
						{a.channelId && !channels.some((c) => c._id === a.channelId) && (
							<option value={a.channelId}>
								#{a.channelName}
								{a.channelArchived ? " (archived)" : ""}
							</option>
						)}
						{channels.map((c) => (
							<option key={c._id} value={c._id}>
								#{c.title}
							</option>
						))}
					</select>
				</label>
				{a.webhookUrl && (
					<div className="flex flex-col gap-1">
						<div className="flex items-center gap-2">
							<span className="w-16 shrink-0 text-neutral-500">Webhook</span>
							<input readOnly value={a.webhookUrl} onFocus={(e) => e.target.select()} className={`${inputClass} min-w-0 flex-1 py-1 font-mono text-xs`} />
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
						<p className="pl-[4.5rem] text-neutral-400">
							Paste this into the app that sends the webhook. Keep it secret: anyone with it can trigger this automation.
						</p>
					</div>
				)}
				{ungranted.length > 0 && (
					<p className="rounded-lg bg-amber-50 px-3 py-2 text-amber-900">
						{a.agentName} isn't granted {ungranted.map((n) => n.name).join(", ")}. Grant it in Agents, or pick another agent.
					</p>
				)}
				<p className="text-neutral-500">
					{a.lastRunAt ? `Last ran ${timeAgo(a.lastRunAt)}. ${a.lastResult ?? ""}` : "Hasn't run yet."}
				</p>
				{canManage && (
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
									: "Runs once with a sample webhook, just for you."}
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
function Missing({ tab }: { tab: CustomizeTab }) {
	const label = customizeTabs.find((t) => t.id === tab)!.label;
	return (
		<Page title="" back={{ label, to: ["customize", tab] }}>
			<Loading />
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
