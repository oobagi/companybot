import type { Role } from "@companybot/core";
import { can } from "@companybot/core/permissions";
import { useAction, useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useQuery } from "convex-helpers/react/cache";
import { useState } from "react";
import { api } from "../api";
import { Loading, Notice, Page, Tabs, inputClass, primaryButton, useRun } from "../ui";
import { AgentsTab } from "./Agents";

const tabs = [
	{ id: "agents", label: "Agents" },
	{ id: "plugins", label: "Plugins" },
	{ id: "skills", label: "Skills" },
] as const;
export type CustomizeTab = (typeof tabs)[number]["id"];

export function CustomizeView({ role, tab, onTab }: { role: Role; tab: CustomizeTab; onTab: (tab: CustomizeTab) => void }) {
	return (
		<Page title="Customize" subtitle="Shape your agents, connect your tools, and teach new skills.">
			<Tabs tabs={tabs} value={tab} onChange={onTab} />
			{tab === "agents" && <AgentsTab role={role} />}
			{tab === "plugins" && <PluginsTab role={role} />}
			{tab === "skills" && <SkillsTab role={role} />}
		</Page>
	);
}

function PluginsTab({ role }: { role: Role }) {
	const plugins = useQuery(api.plugins.list);
	if (!plugins) return <Loading />;
	return (
		<>
			<p className="text-sm text-neutral-500">
				Connect outside services like Gmail or Calendar. Agents granted a plugin use it for the person they're helping.
			</p>
			{plugins.length === 0 && <p className="text-sm text-neutral-400">No plugins available yet.</p>}
			{plugins.map((p) => (
				<PluginCard key={p.id} plugin={p} isOwner={can(role, "plugins.manage")} />
			))}
		</>
	);
}

type PluginItem = FunctionReturnType<typeof api.plugins.list>[number];

function PluginCard({ plugin, isOwner }: { plugin: PluginItem; isOwner: boolean }) {
	const setInstalled = useMutation(api.plugins.setInstalled);
	const setRoles = useMutation(api.plugins.setRoles);
	const connect = useAction(api.plugins.connect);
	const startOAuth = useAction(api.plugins.startOAuth);
	const disconnect = useMutation(api.plugins.disconnect);
	const [key, setKey] = useState("");
	const { error, run } = useRun();
	const whose = plugin.connection === "personal" ? "Each person connects their own account." : "One shared account for the workspace.";

	return (
		<div className="flex flex-col gap-3 rounded-xl border border-neutral-200 p-4">
			<Card
				bare
				title={plugin.name}
				meta={`${plugin.publisher} · v${plugin.version}`}
				description={plugin.description}
				installed={plugin.installed}
				canManage={isOwner}
				onToggle={() => run(setInstalled({ pluginId: plugin.id, installed: !plugin.installed }))}
			/>
			{error && <Notice>{error}</Notice>}
			{plugin.installed && (
				<div className="flex flex-col gap-2 border-t border-neutral-100 pt-3 text-sm">
					<label className="flex items-center gap-2">
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
					<p className="text-neutral-500">{whose}</p>
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
						<p className="text-neutral-400">
							{plugin.canUse ? "An owner needs to connect it." : "Your role can't use this plugin."}
						</p>
					)}
					{plugin.auth.type === "api_key" && plugin.auth.help && !plugin.connected && (
						<p className="text-xs text-neutral-400">{plugin.auth.help}</p>
					)}
				</div>
			)}
		</div>
	);
}

function SkillsTab({ role }: { role: Role }) {
	const skills = useQuery(api.skills.list);
	const setSkill = useMutation(api.skills.setInstalled);
	const { error, run } = useRun();
	if (!skills) return <Loading />;
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
					canManage={can(role, "skills.manage")}
					onToggle={() => run(setSkill({ skillId: s.id, installed: !s.installed }))}
				/>
			))}
		</>
	);
}

function Card(props: {
	/** Without its own border, for use inside another card. */
	bare?: boolean;
	title: string;
	meta: string;
	description: string;
	installed: boolean;
	canManage: boolean;
	onToggle: () => void;
}) {
	return (
		<div className={`flex items-start justify-between gap-4 ${props.bare ? "" : "rounded-xl border border-neutral-200 p-4"}`}>
			<div>
				<h3 className="font-medium">
					{props.title} <span className="text-xs font-normal text-neutral-400">{props.meta}</span>
				</h3>
				<p className="text-sm text-neutral-500">{props.description}</p>
			</div>
			<button
				type="button"
				disabled={!props.canManage}
				title={props.canManage ? undefined : "Only owners can install"}
				onClick={props.onToggle}
				className={`shrink-0 rounded-full px-3 py-1 text-sm disabled:opacity-50 ${
					props.installed ? "border border-neutral-200 text-neutral-600" : "bg-neutral-900 text-white"
				}`}
			>
				{props.installed ? "Installed" : "Install"}
			</button>
		</div>
	);
}
