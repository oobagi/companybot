import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import { type Role, can } from "@companybot/core";
import { useAuthActions } from "@convex-dev/auth/react";
import { useConvexAuth } from "convex/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, errorMessage } from "./api";
import { WorkspaceContext, useMutation, useQuery } from "./convex";
import { desktop, useUpdates } from "./desktop";
import { useAlerts } from "./notifications";
import { navigate, useRoute } from "./router";
import { CustomizeIcon, DatabaseIcon, PlusIcon, SettingsIcon, SignOutIcon, TrashIcon } from "./icons";
import { Notice, TopBar } from "./ui";
import { RecordsView, recordTabs } from "./views/Records";
import { SettingsView, settingsTabAliases, settingsTabs } from "./views/Settings";
import { SignIn } from "./views/SignIn";
import { WorkspaceMenu } from "./views/WorkspaceMenu";
import { ChatView } from "./views/chat/ChatView";
import { Avatar, MenuItem, Popover } from "./views/chat/common";
import { ChatNav, Group, Item } from "./views/chat/Sidebar";
import { PagesNav, PagesView } from "./views/Pages";
import { CustomizeView, customizeTabs } from "./views/customize";
import { TrashView } from "./views/Trash";
import { DatabaseDialog } from "./views/records/DatabaseDialog";
import { useTypes } from "./views/records/data";
import { builtinTabs, recordPath } from "./views/records/logic";

const views = ["chat", ...recordTabs.map((t) => t.id), "records", "pages", "trash", "customize", "settings"] as const;
type View = (typeof views)[number];

export function App() {
	const { isLoading, isAuthenticated } = useConvexAuth();
	if (isLoading) return null;
	return isAuthenticated ? <Workspace /> : <SignIn />;
}

/** Where this device keeps the workspace it has open. Each device picks its own. */
const OPEN_KEY = "companybot.workspace";

/**
 * Picks the workspace this window shows: the one this device had open, else the one you
 * used last anywhere (first launch), else your first. Every call below carries it.
 */
function Workspace() {
	const mine = useQuery(api.workspace.mine);
	const { signOut } = useAuthActions();
	const ensure = useMutation(api.workspace.ensure);
	const remember = useMutation(api.workspace.switchTo);
	const [chosen, setChosen] = useState(() => localStorage.getItem(OPEN_KEY));
	const [error, setError] = useState<string>();
	const ids = mine?.workspaces.map((w) => w.id) ?? [];
	const id = [chosen, mine?.lastUsed].find((w) => w && ids.includes(w as Id<"workspaces">)) ?? ids[0];

	// An erased account acts as signed out before its old token expires, in every window.
	useEffect(() => {
		if (mine === null) void signOut();
	}, [mine, signOut]);

	// First sign-in (or after leaving your last one): join the workspaces that invited you, or start one.
	useEffect(() => {
		if (mine?.workspaces.length === 0) ensure().catch((e) => setError(errorMessage(e)));
	}, [mine, ensure]);

	// Once this device has a workspace open it keeps it, even when another device later changes "last used".
	useEffect(() => {
		if (id && id !== chosen) {
			localStorage.setItem(OPEN_KEY, id);
			setChosen(id);
		}
	}, [id, chosen]);

	// Only workspaces you're in: a notification can name one you've since left.
	const joined = useRef(ids);
	joined.current = ids;
	const open = useCallback(
		(next: Id<"workspaces">) => {
			if (!joined.current.includes(next)) return false;
			localStorage.setItem(OPEN_KEY, next);
			setChosen(next);
			remember({ to: next }).catch(() => {});
			return true;
		},
		[remember],
	);
	const workspace = useMemo(() => id && { id: id as Id<"workspaces">, open }, [id, open]);

	if (error) return <div className="flex h-screen items-center justify-center p-8"><Notice>{error}</Notice></div>;
	if (!workspace) return null;
	// Keyed by workspace: switching starts every screen fresh.
	return (
		<WorkspaceContext.Provider value={workspace}>
			<Opened key={workspace.id} />
		</WorkspaceContext.Provider>
	);
}

function Opened() {
	const me = useQuery(api.workspace.me);
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
	// for types owners add, /pages[/<page>], /trash, /customize/<tab>[/<item>], /settings/<tab>.
	const route = useRoute();
	const view: View = views.find((v) => v === route[0]) ?? "chat";
	const customizeTab = customizeTabs.find((t) => t.id === route[1])?.id ?? "agents";
	const settingsTab = settingsTabs.find((t) => t.id === (settingsTabAliases[route[1] ?? ""] ?? route[1]))?.id ?? "general";
	const types = useTypes();
	const [newDatabase, setNewDatabase] = useState(false);
	// The database on screen, by key, and the record open in it.
	const builtinKey = Object.keys(builtinTabs).find((k) => builtinTabs[k] === view);
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
	useAlerts();

	return (
		<div className="flex h-screen text-[15px] text-neutral-900">
			<aside className="drag flex w-60 shrink-0 flex-col border-r border-neutral-200 bg-neutral-50 px-3 pt-12 pb-3">
				<WorkspaceMenu name={workspace} />
				<div className="no-drag -mx-1 flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-1 pb-4">
					<Group title="Databases" onTitle={() => navigate("records")} onAdd={can(role, "fields.manage") ? () => setNewDatabase(true) : undefined} addLabel="New database">
						{types?.length === 0 && <p className="px-2 py-1 text-sm text-neutral-400">No databases yet</p>}
						{types?.map((type) => (
							<Item key={type._id} icon={<DatabaseIcon />} active={typeKey === type.key} onClick={() => navigate(...recordPath(type.key))}>
								{type.plural}
							</Item>
						))}
						{can(role, "fields.manage") && (
							<Item icon={<PlusIcon />} muted onClick={() => setNewDatabase(true)}>
								New database
							</Item>
						)}
					</Group>
					<PagesNav openId={view === "pages" ? route[1] : undefined} />
					<ChatNav chats={chats} openId={view === "chat" ? openId : undefined} onOpen={open} onError={(e) => setError(errorMessage(e))} />
				</div>
				<nav className="no-drag flex flex-col gap-px border-t border-neutral-200 pt-3">
					{(
						[
							["trash", "Trash", <TrashIcon />],
							["customize", "Customize", <CustomizeIcon />],
							["settings", "Settings", <SettingsIcon />],
						] as const
					).map(([v, label, icon]) => (
						<Item key={v} icon={icon} active={view === v} onClick={() => navigate(...(lastPath.current[v] ?? [v]))}>
							{label}
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
				<div className="no-drag mt-2 flex">
					<YouMenu name={prefs?.displayName || email} email={email} role={role} onSignOut={() => void signOut()} />
				</div>
			</aside>

			{newDatabase && <DatabaseDialog onClose={() => setNewDatabase(false)} />}
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
						<TopBar title="" />
					))}
				{(typeKey || view === "records") && <RecordsView key={typeKey} typeKey={typeKey} recordId={recordId} role={role} />}
				{view === "pages" && <PagesView pageId={route[1]} canEdit={can(role, "pages.edit")} />}
				{view === "trash" && <TrashView role={role} />}
				{view === "customize" && <CustomizeView role={role} tab={customizeTab} itemId={route[2]} />}
				{view === "settings" && <SettingsView role={role} tab={settingsTab} onTab={(t) => navigate("settings", t)} />}
			</main>
		</div>
	);
}

/** You, at the bottom of the sidebar: who you're signed in as, your preferences, and Sign out. */
function YouMenu({ name, email, role, onSignOut }: { name: string; email: string; role: Role; onSignOut: () => void }) {
	return (
		<Popover
			trigger={
				<>
					<Avatar name={name} size="sm" />
					<span className="min-w-0 flex-1">
						<span className="block truncate font-medium text-neutral-800">{name}</span>
						<span className="block text-xs text-neutral-500 capitalize">{role}</span>
					</span>
				</>
			}
			className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-neutral-100"
			panelClassName="w-64 p-1"
		>
			{(close) => (
				<>
					<div className="flex items-center gap-3 px-2 py-2">
						<Avatar name={name} />
						<div className="min-w-0">
							<p className="truncate font-semibold">{name}</p>
							{name !== email && <p className="truncate text-neutral-500">{email}</p>}
						</div>
					</div>
					<div className="my-1 border-t border-neutral-100" />
					<MenuItem onClick={() => (close(), navigate("settings", "preferences"))}>
						<SettingsIcon className="text-neutral-500" /> Your preferences
					</MenuItem>
					<MenuItem onClick={() => (close(), onSignOut())}>
						<SignOutIcon className="text-neutral-500" /> Sign out
					</MenuItem>
				</>
			)}
		</Popover>
	);
}
