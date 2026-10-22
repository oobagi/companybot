import type { ToolAccess } from "@companybot/core";
import { useState } from "react";
import { type Agent, type PluginInfo, type User, api, useApi } from "../api";
import { Notice } from "./Chat";
import { Page } from "./Memory";

const hiddenReason: Record<Exclude<ToolAccess, { visible: true }>["reason"], string> = {
	role: "owners only",
	not_installed: "plugin not installed",
	not_found: "missing",
};

export function PluginsView({ user, agents, onChange }: { user: User; agents: Agent[]; onChange: () => void }) {
	const { data, error, reload } = useApi<PluginInfo[]>(user.id, "/plugins");
	const [actionError, setActionError] = useState<string>();
	const isOwner = user.role === "owner";

	const toggle = (p: PluginInfo) =>
		api(user.id, `/plugins/${p.id}/${p.installed ? "uninstall" : "install"}`, { method: "POST" }).then(
			() => (setActionError(undefined), reload(), onChange()),
			(e: Error) => setActionError(e.message),
		);

	return (
		<Page title="Plugins" subtitle="Add tools to your workspace. Agents only get the tools they're allowed to use.">
			{(error || actionError) && <Notice>{error ?? actionError}</Notice>}

			<section className="grid gap-3">
				{data?.map((p) => (
					<div key={p.id} className="flex flex-col gap-3 rounded-xl border border-neutral-200 p-4">
						<div className="flex items-start justify-between gap-4">
							<div>
								<h2 className="font-medium">
									{p.name} <span className="text-xs font-normal text-neutral-400">v{p.version}</span>
								</h2>
								<p className="text-sm text-neutral-500">{p.description}</p>
							</div>
							<button
								type="button"
								disabled={!isOwner}
								title={isOwner ? undefined : "Only owners can manage plugins"}
								onClick={() => toggle(p)}
								className={`shrink-0 rounded-full px-3 py-1 text-sm disabled:opacity-50 ${
									p.installed ? "border border-neutral-200 text-neutral-600" : "bg-neutral-900 text-white"
								}`}
							>
								{p.installed ? "Installed" : "Install"}
							</button>
						</div>
						<ul className="flex flex-wrap gap-1.5">
							{p.tools.map((t) => (
								<li key={t.name} title={t.description} className="rounded-md bg-neutral-100 px-2 py-0.5 text-xs text-neutral-600">
									{t.name}
									{t.roles && <span className="text-neutral-400"> · {t.roles.join(", ")}</span>}
								</li>
							))}
						</ul>
					</div>
				))}
			</section>

			<section className="flex flex-col gap-2">
				<h2 className="text-sm font-medium text-neutral-500">What each agent can use, as {user.name}</h2>
				{agents.map((a) => (
					<div key={a.id} className="rounded-xl border border-neutral-200 px-4 py-3">
						<p className="mb-2 font-medium">{a.name}</p>
						<ul className="flex flex-wrap gap-1.5">
							{a.tools.map((t) => (
								<li
									key={t.id}
									className={`rounded-md px-2 py-0.5 text-xs ${
										t.visible ? "bg-emerald-50 text-emerald-700" : "bg-neutral-100 text-neutral-400"
									}`}
									title={t.visible ? "Available" : hiddenReason[t.reason]}
								>
									{t.visible ? t.id : <s>{t.id}</s>}
									{!t.visible && ` (${hiddenReason[t.reason]})`}
								</li>
							))}
						</ul>
					</div>
				))}
			</section>
		</Page>
	);
}
