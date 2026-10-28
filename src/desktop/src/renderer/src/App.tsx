import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import { type Role, can } from "@companybot/core/permissions";
import { useAuthActions } from "@convex-dev/auth/react";
import { useConvexAuth } from "convex/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import { WorkspaceContext, useMutation, useQuery, useWorkspace } from "./convex";
import { desktop, useUpdates } from "./desktop";
import { useAlerts } from "./notifications";
import { navigate, useRoute } from "./router";
import { ArrowLeftIcon, DatabaseIcon, PlusIcon, SettingsIcon, SignOutIcon } from "./icons";
import { MenuDivider, Notice, Scroll, TopBar, TruncatedTips, useRun } from "./ui";
import { RecordsView, recordTabs } from "./views/Records";
import { SettingsNav, SettingsView, settingsScope, settingsTabAliases, settingsTabs } from "./views/Settings";
import { SignIn } from "./views/SignIn";
import { TitleBar } from "./views/TitleBar";
import { WorkspaceMenu } from "./views/WorkspaceMenu";
import { WorkspaceRail } from "./views/WorkspaceRail";
import { ChatView } from "./views/chat/ChatView";
import { Avatar, MenuItem, Popover, deviceTimeZone } from "./views/chat/common";
import { AddButton, ChannelsNav, DmsNav, Group, Item, type SectionProps } from "./views/chat/Sidebar";
import { useSortable, useStoredIds } from "./sortable";
import { PagesNav, PagesView } from "./views/Pages";
import { DatabaseDialog } from "./views/records/DatabaseDialog";
import { useTypes } from "./views/records/data";
import { builtinTabs, recordPath } from "./views/records/logic";

const views = ["chat", ...recordTabs.map((t) => t.id), "records", "pages", "settings"] as const;
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
	const { error, fail } = useRun();
	const ids = mine?.workspaces.map((w) => w.id) ?? [];
	const id = [chosen, mine?.lastUsed].find((w) => w && ids.includes(w as Id<"workspaces">)) ?? ids[0];

	// An erased account acts as signed out before its old token expires, in every window.
	useEffect(() => {
		if (mine === null) void signOut();
	}, [mine, signOut]);

	// First sign-in (or after leaving your last one): join the workspaces that invited you, or start one.
	useEffect(() => {
		if (mine?.workspaces.length === 0) ensure().catch(fail);
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
	const timeZone = deviceTimeZone();
	useEffect(() => {
		if (prefs && prefs.deviceTimeZone !== timeZone) updatePrefs({ deviceTimeZone: timeZone }).catch(() => {});
	}, [prefs, timeZone, updatePrefs]);
	// Screens are paths: /chat[/<chat>[/thread|message/<id>]], /clients[/<record>] (and other record tabs), /records/<type>[/<record>]
	// for types owners add, /pages[/<page>], /settings/<tab>[/<item>] (Trash, Agents, Connectors, Skills and Automations included).
	const route = useRoute();
	// Trash and Customize used to be their own screens.
	useEffect(() => {
		if (route[0] === "customize") navigate("settings", ...(route.length > 1 ? route.slice(1) : ["agents"]));
		if (route[0] === "trash") navigate("settings", "trash");
	}, [route]);
	const view: View = views.find((v) => v === route[0]) ?? "chat";
	const settingsTab = settingsTabs.find((t) => t.id === (settingsTabAliases[route[1] ?? ""] ?? route[1]))?.id ?? "general";
	const types = useTypes();
	const [newDatabase, setNewDatabase] = useState(false);
	// The database on screen, by key, and the record open in it.
	const builtinKey = Object.keys(builtinTabs).find((k) => builtinTabs[k] === view);
	const typeKey = view === "records" ? route[1] : builtinKey;
	const recordId = view === "records" ? route[2] : route[1];
	// Workspace settings reopen on the tab you left them on.
	const lastWorkspaceSettings = useRef<string[]>(["settings", "general"]);
	if (view === "settings" && settingsScope(settingsTab) === "workspace") lastWorkspaceSettings.current = route;
	// Where "Back to app" goes from Settings.
	const lastApp = useRef<string[]>(["chat"]);
	if (view !== "settings") lastApp.current = route;
	const { error, fail } = useRun();
	const { status: update } = useUpdates();

	const chatId = view === "chat" ? (route[1] as Id<"chats"> | undefined) : undefined;
	const openId = chatId ?? (chats?.channels.find((c) => c.isDefault) ?? chats?.channels[0] ?? chats?.dms[0])?._id;
	const open = (id: Id<"chats">) => {
		navigate("chat", id);
		fail();
	};
	useAlerts();
	// The sidebar's sections: drag a title to move one, click it to fold it. Both stay on this computer.
	const sections = useSortable("sidebar.sections", sectionIds, sectionKey);
	const [folded, setFolded] = useStoredIds("sidebar.folded");
	const fold = (id: string) => setFolded(folded.includes(id) ? folded.filter((f) => f !== id) : [...folded, id]);
	// Hidden or shown, the sidebar stays that way on this computer.
	const [sidebar, setSidebar] = useState(() => localStorage.getItem("sidebar.hidden") !== "true");
	const toggleSidebar = useCallback(() => setSidebar((shown) => (localStorage.setItem("sidebar.hidden", String(shown)), !shown)), []);

	return (
		<div className="flex h-screen flex-col bg-neutral-100 text-[15px] text-neutral-900">
			{/* A title bar the width of the window holds its buttons; everything else sits below it. */}
			<TitleBar sidebar={sidebar} onSidebar={toggleSidebar} />
			<TruncatedTips />
			<div className="flex min-h-0 flex-1">
				<WorkspaceRail
					you={prefs?.displayName || email}
					youMenu={
						<YouMenu
							name={prefs?.displayName || email}
							image={prefs?.image}
							email={email}
							role={role}
							onSettings={() => navigate("settings", "preferences")}
							onSignOut={() => void signOut()}
						/>
					}
				/>
				{/* The sidebar and the open screen share one panel, its corner tucked under the title bar. */}
				<div className="flex min-w-0 flex-1 overflow-hidden rounded-tl-xl border-t border-l border-neutral-200 bg-white">
					{/* The sidebar's lists scroll under the workspace name and you. */}
					{sidebar && (
						<aside className="drag flex w-60 shrink-0 flex-col border-r border-neutral-200 bg-neutral-50 [--scrim:var(--color-neutral-50)]">
							<Scroll
								className="no-drag"
								header={
									<div className="drag px-3 pt-3 pb-4">
										{view === "settings" ? (
											<div className="no-drag flex flex-col">
												<Item icon={<ArrowLeftIcon />} onClick={() => navigate(...lastApp.current)}>
													Back to app
												</Item>
											</div>
										) : (
											<WorkspaceMenu name={workspace} onSettings={() => navigate(...lastWorkspaceSettings.current)} />
										)}
									</div>
								}
								footer={
									update?.state === "ready" && (
										<div className="flex flex-col px-3 pt-4 pb-3">
											<button type="button" onClick={() => void desktop?.updates.install()} className="rounded-lg bg-neutral-900 px-3 py-2 text-left text-xs text-white">
												Update ready · Restart
											</button>
										</div>
									)
								}
							>
								<div className="flex flex-col gap-4 px-3 pb-2">
									{view === "settings" ? (
										<SettingsNav tab={settingsTab} />
									) : (
										<>
											{sections.sorted.map((id) => {
												const section = { collapsed: folded.includes(id), onToggle: () => fold(id), drag: sections.drag(id) };
												if (id === "databases")
													return (
														(!!types?.length || can(role, "fields.manage")) && (
															<DatabasesNav key={id} types={types ?? []} openKey={typeKey} canCreate={can(role, "fields.manage")} onCreate={() => setNewDatabase(true)} section={section} />
														)
													);
												if (id === "pages") return <PagesNav key={id} openId={view === "pages" ? route[1] : undefined} section={section} />;
												const props = { chats, openId: view === "chat" ? openId : undefined, onOpen: open, onError: fail, section };
												if (!chats) return null;
												return id === "channels" ? <ChannelsNav key={id} {...props} chats={chats} /> : <DmsNav key={id} {...props} chats={chats} />;
											})}
										</>
									)}
								</div>
							</Scroll>
						</aside>
					)}

					{newDatabase && <DatabaseDialog onClose={() => setNewDatabase(false)} />}
					<main className="flex min-w-0 flex-1 flex-col">
						<Notice>{error}</Notice>
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
						{view === "settings" && <SettingsView role={role} tab={settingsTab} itemId={route[2]} />}
					</main>
				</div>
			</div>
		</div>
	);
}

const sectionIds = ["databases", "pages", "channels", "dms"];
const sectionKey = (id: string) => id;
const typeKeyOf = (t: { key: string }) => t.key;

/** Your databases, in your order. Folded, only the open one stays. */
function DatabasesNav({
	types,
	openKey,
	canCreate,
	onCreate,
	section,
}: {
	types: { _id: string; key: string; plural: string }[];
	openKey: string | undefined;
	canCreate: boolean;
	onCreate: () => void;
	section: SectionProps;
}) {
	const workspace = useWorkspace();
	const { sorted, drag } = useSortable(`sidebar.databases:${workspace?.id}`, types, typeKeyOf);
	const shown = section.collapsed ? sorted.filter((t) => t.key === openKey) : sorted;
	return (
		<Group title="Databases" section={section} add={canCreate && <AddButton label="New database" onClick={onCreate} />}>
			{shown.map((type) => (
				<Item key={type._id} drag={drag(type.key)} icon={<DatabaseIcon />} active={openKey === type.key} onClick={() => navigate(...recordPath(type.key))}>
					{type.plural}
				</Item>
			))}
			{!types.length && canCreate && !section.collapsed && (
				<Item icon={<PlusIcon />} muted onClick={onCreate}>
					New database
				</Item>
			)}
		</Group>
	);
}

/** You, at the bottom of the workspace rail: who you're signed in as, your account settings, and Sign out. */
function YouMenu({
	name,
	image,
	email,
	role,
	onSettings,
	onSignOut,
}: {
	name: string;
	image?: string | null;
	email: string;
	role: Role;
	onSettings: () => void;
	onSignOut: () => void;
}) {
	return (
		<Popover
			trigger={
				<>
					<span className="sr-only">{name}</span>
					<Avatar name={name} image={image} className="pointer-events-none" />
				</>
			}
			className="no-drag flex rounded-full"
			panelClassName="w-64 p-1"
		>
			{(close) => (
				<>
					<div className="flex items-center gap-3 px-2 py-2">
						<Avatar name={name} image={image} />
						<div className="min-w-0">
							<p className="truncate font-semibold">{name}</p>
							{name !== email && <p className="truncate text-neutral-500">{email}</p>}
							<p className="text-xs text-neutral-500 capitalize">{role}</p>
						</div>
					</div>
					<MenuDivider />
					<MenuItem onClick={() => (close(), onSettings())}>
						<SettingsIcon className="text-neutral-500" /> Account settings
					</MenuItem>
					<MenuItem onClick={() => (close(), onSignOut())}>
						<SignOutIcon className="text-neutral-500" /> Sign out
					</MenuItem>
				</>
			)}
		</Popover>
	);
}
