import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import type { Role } from "@companybot/core";
import { useAuthActions } from "@convex-dev/auth/react";
import { useConvexAuth, useMutation } from "convex/react";
import { useQuery } from "convex-helpers/react/cache";
import { Fragment, useEffect, useRef, useState } from "react";
import { api, errorMessage } from "./api";
import { desktop, useUpdates } from "./desktop";
import { navigate, useRoute } from "./router";
import { Notice } from "./ui";
import { ChatView } from "./views/chat/ChatView";
import { ChatNav, Item } from "./views/chat/Sidebar";
import { CustomizeView, customizeTabs } from "./views/customize";
import { RecordsView, recordTabs, useAddedTypes } from "./views/Records";
import { builtinTabs } from "./views/records/logic";
import { SettingsView, settingsTabAliases, settingsTabs } from "./views/Settings";
import { SignIn } from "./views/SignIn";

const views = ["chat", ...recordTabs.map((t) => t.id), "records", "customize", "settings"] as const;
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

function Shell({ email, role, workspace }: { email: string; role: Role; workspace: string }) {
	const { signOut } = useAuthActions();
	const chats = useQuery(api.chats.list);
	const prefs = useQuery(api.preferences.get);
	const updatePrefs = useMutation(api.preferences.update);
	// Automatic time zone: keep the backend's copy of this computer's zone current.
	const deviceTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
	useEffect(() => {
		if (prefs && prefs.deviceTimeZone !== deviceTimeZone) updatePrefs({ deviceTimeZone }).catch(() => {});
	}, [prefs, deviceTimeZone, updatePrefs]);
	// Screens are paths: /chat[/<chat>[/thread|message/<id>]], /clients[/<record>] (and other record tabs), /records/<type>[/<record>]
	// for types owners add, /customize/<tab>[/<item>], /settings/<tab>.
	const route = useRoute();
	const view: View = views.find((v) => v === route[0]) ?? "chat";
	const customizeTab = customizeTabs.find((t) => t.id === route[1])?.id ?? "agents";
	const settingsTab = settingsTabs.find((t) => t.id === (settingsTabAliases[route[1] ?? ""] ?? route[1]))?.id ?? "general";
	const addedTypes = useAddedTypes();
	// The record type on screen, by key, and the record open in it.
	const builtinKey = Object.keys(builtinTabs).find((k) => builtinTabs[k] === view) ?? (view === "campaigns" ? "campaign" : undefined);
	const typeKey = view === "records" ? route[1] : builtinKey;
	const recordId = view === "records" ? route[2] : route[1];
	// Each section reopens where you left it.
	const lastPath = useRef<Partial<Record<View, string[]>>>({});
	lastPath.current[view] = route;
	const [error, setError] = useState<string>();
	const { status: update } = useUpdates();

	const chatId = view === "chat" ? (route[1] as Id<"chats"> | undefined) : undefined;
	const openId = chatId ?? (chats?.channels.find((c) => c.isDefault) ?? chats?.channels[0] ?? chats?.dms[0])?._id;
	const open = (id: Id<"chats">) => {
		navigate("chat", id);
		setError(undefined);
	};

	return (
		<div className="flex h-screen text-[15px] text-neutral-900">
			<aside className="drag flex w-60 shrink-0 flex-col border-r border-neutral-200 bg-neutral-50 px-3 pt-12 pb-3">
				<p className="truncate px-2 pb-4 text-sm font-semibold">{workspace}</p>
				<nav className="no-drag mb-3 flex flex-col gap-px border-b border-neutral-200 pb-3">
					{recordTabs.map((t) => (
						<Fragment key={t.id}>
							{t.id === "campaigns" &&
								addedTypes.map((type) => (
									<Item key={type._id} active={view === "records" && route[1] === type.key} onClick={() => navigate("records", type.key)}>
										{type.plural}
									</Item>
								))}
							<Item active={view === t.id} onClick={() => navigate(t.id)}>
								{t.label}
							</Item>
						</Fragment>
					))}
				</nav>
				<ChatNav chats={chats} openId={view === "chat" ? openId : undefined} onOpen={open} onError={(e) => setError(errorMessage(e))} />
				<nav className="no-drag flex flex-col gap-px border-t border-neutral-200 pt-3">
					{(["customize", "settings"] as const).map((v) => (
						<Item key={v} active={view === v} onClick={() => navigate(...(lastPath.current[v] ?? [v]))}>
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
						<ChatView
							key={openId}
							chatId={openId}
							sendWith={prefs?.sendWith ?? "enter"}
							focus={route[2] === "thread" && route[3] ? { thread: route[3] } : route[2] === "message" && route[3] ? { message: route[3] } : undefined}
							onLeft={() => navigate("chat")}
						/>
					) : (
						<div className="drag h-12 shrink-0" />
					))}
				{view !== "chat" && <header className="drag h-12 shrink-0" />}
				{typeKey && <RecordsView key={typeKey} typeKey={typeKey} recordId={recordId} role={role} />}
				{view === "customize" && <CustomizeView role={role} tab={customizeTab} itemId={route[2]} />}
				{view === "settings" && <SettingsView role={role} tab={settingsTab} onTab={(t) => navigate("settings", t)} />}
			</main>
		</div>
	);
}

function Centered({ children }: { children: React.ReactNode }) {
	return <div className="flex h-screen items-center justify-center p-8">{children}</div>;
}
