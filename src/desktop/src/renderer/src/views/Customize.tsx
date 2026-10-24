import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import type { Role } from "@companybot/core";
import { can } from "@companybot/core/permissions";
import { useAction, useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useQuery } from "convex-helpers/react/cache";
import { Fragment, useState } from "react";
import { api } from "../api";
import { Markdown } from "../markdown";
import { Loading, Notice, Page, Section, Tabs, inputClass, primaryButton, secondaryButton, timeAgo, useRun } from "../ui";
import { navigate } from "../router";
import { AgentScreen, AgentsTab } from "./Agents";

export const customizeTabs = [
	{ id: "agents", label: "Agents" },
	{ id: "plugins", label: "Plugins" },
	{ id: "skills", label: "Skills" },
	{ id: "automations", label: "Automations" },
] as const;
export type CustomizeTab = (typeof customizeTabs)[number]["id"];

/** The tab's list, or with `itemId`, that item's own screen. */
export function CustomizeView({ role, tab, itemId }: { role: Role; tab: CustomizeTab; itemId?: string }) {
	if (itemId) {
		if (tab === "agents") return <AgentScreen role={role} agentId={itemId as Id<"agents">} />;
		if (tab === "plugins") return <PluginScreen role={role} id={itemId} />;
		if (tab === "skills") return <SkillScreen role={role} id={itemId} />;
		return <AutomationScreen role={role} id={itemId} />;
	}
	return (
		<Page title="Customize" subtitle="Shape your agents, connect your tools, teach new skills, and automate routine work.">
			<Tabs tabs={customizeTabs} value={tab} onChange={(t) => navigate("customize", t)} />
			{tab === "agents" && <AgentsTab role={role} />}
			{tab === "plugins" && <PluginsTab role={role} />}
			{tab === "skills" && <SkillsTab role={role} />}
			{tab === "automations" && <AutomationsTab role={role} />}
		</Page>
	);
}

// ---- Plugins ----

type PluginItem = FunctionReturnType<typeof api.plugins.list>[number];

function PluginsTab({ role }: { role: Role }) {
	const plugins = useQuery(api.plugins.list);
	const setInstalled = useMutation(api.plugins.setInstalled);
	const { error, run } = useRun();
	if (!plugins) return <Loading />;
	const isOwner = can(role, "plugins.manage");
	const toggle = (p: PluginItem) => run(setInstalled({ pluginId: p.id, installed: !p.installed }));

	return (
		<>
			<p className="text-sm text-neutral-500">
				Connect outside services like Gmail or Calendar. Agents granted a plugin use it for the person they're helping.
			</p>
			{error && <Notice>{error}</Notice>}
			{plugins.length === 0 && <p className="text-sm text-neutral-400">No plugins available yet.</p>}
			{plugins.map((p) => (
				<Card
					key={p.id}
					title={p.name}
					meta={`${p.publisher} · v${p.version}`}
					description={p.description}
					status={p.installed ? pluginStatus(p) : undefined}
					installed={p.installed}
					canManage={isOwner}
					onToggle={() => toggle(p)}
					onOpen={() => navigate("customize", "plugins", p.id)}
				/>
			))}
		</>
	);
}

function pluginStatus(p: PluginItem) {
	if (!p.canUse) return "Your role can't use it";
	if (p.auth.type === "none") return "Ready";
	if (p.error) return "Connection failing";
	return p.connected ? "Connected" : "Not connected";
}

function PluginScreen({ role, id }: { role: Role; id: string }) {
	const plugin = useQuery(api.plugins.list)?.find((p) => p.id === id);
	if (!plugin) return <Missing tab="plugins" />;
	return <PluginDetail plugin={plugin} isOwner={can(role, "plugins.manage")} />;
}

function PluginDetail({ plugin, isOwner }: { plugin: PluginItem; isOwner: boolean }) {
	const setInstalled = useMutation(api.plugins.setInstalled);
	const setRoles = useMutation(api.plugins.setRoles);
	const { error, run } = useRun();
	const signIn = { none: "None needed", api_key: "API key", oauth: "Sign in through your browser" }[plugin.auth.type];

	return (
		<Detail
			tab="plugins"
			title={plugin.name}
			meta={`${plugin.publisher} · v${plugin.version}`}
			description={plugin.description}
			installed={plugin.installed}
			canManage={isOwner}
			onToggle={() => run(setInstalled({ pluginId: plugin.id, installed: !plugin.installed }))}
		>
			{error && <Notice>{error}</Notice>}
			<Facts
				rows={[
					["Account", plugin.connection === "personal" ? "Each person connects their own" : "One shared account for the workspace"],
					["Sign-in", signIn],
					["Tools", `Discovered from the plugin each turn. Grant "${plugin.id}.*" to an agent to use them.`],
					["Server", plugin.server],
				]}
			/>
			{plugin.installed && (
				<Section title="Access">
					<label className="flex items-center gap-2 text-sm">
						<span className="text-neutral-500">Who can use it</span>
						<select
							disabled={!isOwner}
							value={plugin.roles.includes("member") ? "everyone" : "owners"}
							onChange={(e) =>
								run(setRoles({ pluginId: plugin.id, roles: e.target.value === "everyone" ? ["owner", "member"] : ["owner"] }))
							}
							className="rounded-lg border border-neutral-200 px-2 py-1"
						>
							<option value="everyone">Everyone</option>
							<option value="owners">Owners only</option>
						</select>
					</label>
					<Connection plugin={plugin} />
				</Section>
			)}
		</Detail>
	);
}

function Connection({ plugin }: { plugin: PluginItem }) {
	const connect = useAction(api.plugins.connect);
	const startOAuth = useAction(api.plugins.startOAuth);
	const disconnect = useMutation(api.plugins.disconnect);
	const [key, setKey] = useState("");
	const { error, run } = useRun();

	return (
		<div className="flex flex-col gap-2 text-sm">
			{error && <Notice>{error}</Notice>}
			{plugin.auth.type === "none" ? (
				<p className="text-emerald-700">Ready. No account needed.</p>
			) : plugin.connected ? (
				<div className="flex items-center gap-3">
					<span className={plugin.error ? "text-amber-700" : "text-emerald-700"}>
						{plugin.error ? `Connected, but the last try failed: ${plugin.error}` : "Connected"}
					</span>
					{plugin.canConnect && (
						<button
							type="button"
							onClick={() => run(disconnect({ pluginId: plugin.id }))}
							className="text-neutral-500 hover:text-red-600"
						>
							Disconnect
						</button>
					)}
				</div>
			) : plugin.canUse && plugin.canConnect && plugin.auth.type === "oauth" ? (
				<div className="flex items-center gap-3">
					<button
						type="button"
						className={`${primaryButton} self-start`}
						// Opens in the browser (main process routes window.open there). The app
						// flips to Connected on its own once the sign-in finishes.
						onClick={() => run(startOAuth({ pluginId: plugin.id }).then((url) => window.open(url)))}
					>
						Connect with {plugin.name}
					</button>
					<span className="text-neutral-400">Opens your browser to sign in.</span>
				</div>
			) : plugin.canUse && plugin.canConnect ? (
				<form
					className="flex gap-2"
					onSubmit={(e) => {
						e.preventDefault();
						run(connect({ pluginId: plugin.id, credentials: { type: "api_key", key } }), () => setKey(""));
					}}
				>
					<input
						type="password"
						value={key}
						onChange={(e) => setKey(e.target.value)}
						placeholder={plugin.auth.type === "api_key" ? plugin.auth.label : ""}
						className={`${inputClass} flex-1`}
					/>
					<button type="submit" className={primaryButton}>
						Connect
					</button>
				</form>
			) : (
				<p className="text-neutral-400">{plugin.canUse ? "An owner needs to connect it." : "Your role can't use this plugin."}</p>
			)}
			{plugin.auth.type === "api_key" && plugin.auth.help && !plugin.connected && (
				<p className="text-xs text-neutral-400">{plugin.auth.help}</p>
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

	return (
		<>
			<p className="text-sm text-neutral-500">
				Short jobs that run on their own. Each one messages people from an agent when its time comes.
			</p>
			{error && <Notice>{error}</Notice>}
			{automations.map((a) => (
				<Card
					key={a.id}
					title={a.name}
					meta={a.trigger}
					description={a.description}
					status={a.installed ? `${a.enabled ? "On" : "Off"} · ${a.agentName ?? "No agent"}` : undefined}
					installed={a.installed}
					canManage={canManage}
					onToggle={() => toggle(a)}
					onOpen={() => navigate("customize", "automations", a.id)}
				/>
			))}
		</>
	);
}

function AutomationScreen({ role, id }: { role: Role; id: string }) {
	const automation = useQuery(api.automations.list)?.find((a) => a.id === id);
	if (!automation) return <Missing tab="automations" />;
	return <AutomationDetail automation={automation} canManage={can(role, "automations.manage")} />;
}

function AutomationDetail({ automation: a, canManage }: { automation: AutomationItem; canManage: boolean }) {
	const setInstalled = useMutation(api.automations.setInstalled);
	const agents = useQuery(api.agents.list);
	const update = useMutation(api.automations.update);
	const runNow = useMutation(api.automations.runNow);
	const resetWebhook = useMutation(api.automations.resetWebhook);
	const channels = useQuery(api.chats.list)?.channels ?? [];
	const { error, run } = useRun();
	const [ran, setRan] = useState(false);
	const [copied, setCopied] = useState(false);
	const active = agents?.filter((x) => !x.archived) ?? [];
	const ungranted = a.installed ? a.needs.filter((n) => !n.granted) : [];

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
					["Needs", a.needs.length ? a.needs.map((n) => `${n.name} plugin${n.installed ? "" : " (not installed)"}`).join(", ") : "Nothing extra"],
				]}
			/>
			{a.installed && (
				<Section title="Settings">
					<div className="flex flex-col gap-3 text-sm">
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
								<option value="">{a.scheduled ? "Each person's chat with the agent" : "The person's chat with the agent"}</option>
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
									Paste this into the app that sends the event. Keep it secret: anyone with it can trigger this automation.
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
											: "Runs once with a sample event, just for you."}
								</span>
							</div>
						)}
					</div>
				</Section>
			)}
			<Section title="What the agent is asked" hint="Sent to the agent each run, as if the person asked it.">
				<Markdown className="rounded-xl bg-neutral-50 px-4 py-3 text-sm leading-relaxed">{a.prompt}</Markdown>
			</Section>
		</Detail>
	);
}

// ---- Shared ----

/** A library item. Click to open its detail page; the button installs or removes it. */
function Card(props: {
	title: string;
	meta: string;
	description: string;
	status?: string;
	installed: boolean;
	canManage: boolean;
	onToggle: () => void;
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
			<div>
				<h3 className="font-medium">
					{props.title} <span className="text-xs font-normal text-neutral-400">{props.meta}</span>
				</h3>
				<p className="text-sm text-neutral-500">{props.description}</p>
				{props.status && <p className="mt-1 text-xs text-neutral-400">{props.status}</p>}
			</div>
			<InstallButton
				installed={props.installed}
				canManage={props.canManage}
				onToggle={(e) => {
					e.stopPropagation();
					props.onToggle();
				}}
			/>
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
