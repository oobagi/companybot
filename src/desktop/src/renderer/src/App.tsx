import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import type { Role } from "@companybot/core";
import { useAuthActions } from "@convex-dev/auth/react";
import { useConvexAuth, useMutation } from "convex/react";
import { useQuery } from "convex-helpers/react/cache";
import { useEffect, useState } from "react";
import { api, errorMessage } from "./api";
import { desktop, useUpdates } from "./desktop";
import { Notice } from "./ui";
import { ChatView } from "./views/chat/ChatView";
import { ChatNav, Item } from "./views/chat/Sidebar";
import { type CustomizeTab, CustomizeView } from "./views/Customize";
import { type SettingsTab, SettingsView } from "./views/Settings";
import { SignIn } from "./views/SignIn";

type View = "chat" | "customize" | "settings";

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

function Shell({ email, role, workspace }: { email: string; role: Role; workspace: string }) {
	const { signOut } = useAuthActions();
	const chats = useQuery(api.chats.list);
	const prefs = useQuery(api.preferences.get);
	const [view, setView] = useState<View>("chat");
	// Kept here so each page reopens where you left it.
	const [chatId, setChatId] = useState<Id<"chats">>();
	const [customizeTab, setCustomizeTab] = useState<CustomizeTab>("agents");
	const [settingsTab, setSettingsTab] = useState<SettingsTab>("general");
	const [error, setError] = useState<string>();
	const { status: update } = useUpdates();

	const openId = chatId ?? (chats?.channels.find((c) => c.isDefault) ?? chats?.channels[0] ?? chats?.dms[0])?._id;
	const open = (id: Id<"chats">) => {
		setChatId(id);
		setView("chat");
		setError(undefined);
	};

	return (
		<div className="flex h-screen text-[15px] text-neutral-900">
			<aside className="drag flex w-60 shrink-0 flex-col border-r border-neutral-200 bg-neutral-50 px-3 pt-12 pb-3">
				<p className="truncate px-2 pb-4 text-sm font-semibold">{workspace}</p>
				<ChatNav chats={chats} openId={view === "chat" ? openId : undefined} onOpen={open} onError={(e) => setError(errorMessage(e))} />
				<nav className="no-drag flex flex-col gap-px border-t border-neutral-200 pt-3">
					{(["customize", "settings"] as const).map((v) => (
						<Item key={v} active={view === v} onClick={() => setView(v)}>
							<span className="capitalize">{v}</span>
						</Item>
					))}
				</nav>
				{update?.state === "ready" && (
					<button
						type="button"
						onClick={() => void desktop?.updates.install()}
						className="no-drag mt-3 rounded-lg bg-neutral-900 px-3 py-2 text-left text-xs text-white"
					>
						Update ready · Restart
					</button>
				)}
				<div className="no-drag mt-3 flex flex-col gap-1 px-2 text-xs text-neutral-500">
					<span className="truncate" title={email}>
						{prefs?.displayName || email}
					</span>
					<span className="capitalize">{role}</span>
					<button type="button" onClick={() => void signOut()} className="mt-1 text-left text-neutral-400 hover:text-neutral-700">
						Sign out
					</button>
				</div>
			</aside>

			<main className="flex min-w-0 flex-1 flex-col">
				{error && <Notice>{error}</Notice>}
				{view === "chat" &&
					(openId ? (
						<ChatView key={openId} chatId={openId} sendWith={prefs?.sendWith ?? "enter"} onLeft={() => setChatId(undefined)} />
					) : (
						<div className="drag h-12 shrink-0" />
					))}
				{view !== "chat" && <header className="drag h-12 shrink-0" />}
				{view === "customize" && <CustomizeView role={role} tab={customizeTab} onTab={setCustomizeTab} />}
				{view === "settings" && <SettingsView role={role} tab={settingsTab} onTab={setSettingsTab} />}
			</main>
		</div>
	);
}

function Centered({ children }: { children: React.ReactNode }) {
	return <div className="flex h-screen items-center justify-center p-8">{children}</div>;
}
