import { useAuthActions } from "@convex-dev/auth/react";
import { useConvexAuth, useMutation } from "convex/react";
import { useQuery } from "convex-helpers/react/cache";
import { useEffect, useState } from "react";
import { api, errorMessage } from "./api";
import { Chat, Notice } from "./views/Chat";
import { CustomizeView } from "./views/Customize";
import { MemoryView } from "./views/Memory";
import { SignIn } from "./views/SignIn";
import { TeamView } from "./views/Team";

const views = ["chat", "memory", "customize", "team"] as const;
type View = (typeof views)[number];

export function App() {
	const { isLoading, isAuthenticated } = useConvexAuth();
	if (isLoading) return null;
	return isAuthenticated ? <Workspace /> : <SignIn />;
}

function Workspace() {
	const me = useQuery(api.workspace.me);
	const ensure = useMutation(api.workspace.ensure);
	const [error, setError] = useState<string>();

	// First sign-in: join the workspace you were invited to, or start one.
	useEffect(() => {
		if (me && !me.role) ensure().catch((e) => setError(errorMessage(e)));
	}, [me, ensure]);

	if (error) return <Centered><Notice>{error}</Notice></Centered>;
	if (!me?.role) return null;
	return <Shell email={me.email} role={me.role} workspace={me.workspace ?? ""} />;
}

function Shell({ email, role, workspace }: { email: string; role: "owner" | "member"; workspace: string }) {
	const { signOut } = useAuthActions();
	const agents = useQuery(api.agents.list);
	const [view, setView] = useState<View>("chat");
	const [agentId, setAgentId] = useState("companybot");
	const agent = agents?.find((a) => a.id === agentId);

	return (
		<div className="flex h-screen text-[15px] text-neutral-900">
			<aside className="drag flex w-56 shrink-0 flex-col border-r border-neutral-200 bg-neutral-50 px-3 pt-12 pb-3">
				<p className="px-2 pb-4 text-sm font-semibold">{workspace}</p>
				<nav className="no-drag flex flex-col gap-0.5">
					{views.map((v) => (
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
				<div className="no-drag mt-auto flex flex-col gap-1 px-2 text-xs text-neutral-500">
					<span className="truncate" title={email}>
						{email}
					</span>
					<span className="capitalize">{role}</span>
					<button type="button" onClick={() => void signOut()} className="mt-1 text-left text-neutral-400 hover:text-neutral-700">
						Sign out
					</button>
				</div>
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
				{view === "chat" && agent && <Chat key={agent.id} agent={agent} />}
				{view === "memory" && <MemoryView role={role} />}
				{view === "customize" && agents && <CustomizeView role={role} agents={agents} />}
				{view === "team" && <TeamView role={role} />}
			</main>
		</div>
	);
}

function Centered({ children }: { children: React.ReactNode }) {
	return <div className="flex h-screen items-center justify-center p-8">{children}</div>;
}
