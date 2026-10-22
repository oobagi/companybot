import { useState } from "react";
import { type Agent, type User, useApi } from "./api";
import { Chat, Notice } from "./views/Chat";
import { MemoryView } from "./views/Memory";
import { PluginsView } from "./views/Plugins";

type View = "chat" | "memory" | "plugins";

export function App() {
	const { data: users, error } = useApi<User[]>("", "/users");
	const [userId, setUserId] = useState("jaden");
	const user = users?.find((u) => u.id === userId);

	if (error) {
		return (
			<div className="flex h-screen items-center justify-center p-8">
				<Notice>Can't reach the server ({error}). Start it with `pnpm dev:server`.</Notice>
			</div>
		);
	}
	if (!users || !user) return null;
	return <Workspace key={user.id} user={user} users={users} onSwitchUser={setUserId} />;
}

function Workspace({ user, users, onSwitchUser }: { user: User; users: User[]; onSwitchUser: (id: string) => void }) {
	const { data: agents, reload: reloadAgents } = useApi<Agent[]>(user.id, "/agents");
	const [view, setView] = useState<View>("chat");
	const [agentId, setAgentId] = useState("companybot");
	const agent = agents?.find((a) => a.id === agentId);

	return (
		<div className="flex h-screen text-[15px] text-neutral-900">
			<aside className="drag flex w-56 shrink-0 flex-col border-r border-neutral-200 bg-neutral-50 px-3 pt-12 pb-3">
				<p className="px-2 pb-4 text-sm font-semibold">Companybot</p>
				<nav className="no-drag flex flex-col gap-0.5">
					{(["chat", "memory", "plugins"] as const).map((v) => (
						<button
							type="button"
							key={v}
							onClick={() => setView(v)}
							className={`rounded-lg px-2 py-1.5 text-left text-sm capitalize ${
								view === v ? "bg-neutral-200/70 font-medium" : "text-neutral-600 hover:bg-neutral-100"
							}`}
						>
							{v}
						</button>
					))}
				</nav>
				<label className="no-drag mt-auto flex flex-col gap-1 px-2 text-xs text-neutral-400">
					Viewing as (dev)
					<select
						value={user.id}
						onChange={(e) => onSwitchUser(e.target.value)}
						className="rounded-lg border border-neutral-200 bg-white px-2 py-1 text-sm text-neutral-700"
					>
						{users.map((u) => (
							<option key={u.id} value={u.id}>
								{u.name} · {u.role}
							</option>
						))}
					</select>
				</label>
			</aside>

			<main className="flex min-w-0 flex-1 flex-col">
				<header className="drag flex h-12 shrink-0 items-center justify-center">
					{view === "chat" && agents && (
						<div className="no-drag flex gap-1 rounded-full bg-neutral-100 p-1">
							{agents.map((a) => (
								<button
									type="button"
									key={a.id}
									title={a.description}
									onClick={() => setAgentId(a.id)}
									className={`rounded-full px-3 py-1 text-sm ${
										a.id === agentId ? "bg-white font-medium shadow-sm" : "text-neutral-500 hover:text-neutral-800"
									}`}
								>
									{a.name}
								</button>
							))}
						</div>
					)}
				</header>
				{view === "chat" && agent && <Chat agent={agent} userId={user.id} />}
				{view === "memory" && <MemoryView user={user} />}
				{view === "plugins" && agents && <PluginsView user={user} agents={agents} onChange={reloadAgents} />}
			</main>
		</div>
	);
}
