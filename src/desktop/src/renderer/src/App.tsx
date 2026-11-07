import { setFormDraftPerson } from "./ui";
import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import { type Access, can } from "@companybot/core/permissions";
import { useAuthActions } from "@convex-dev/auth/react";
import { useConvexAuth } from "convex/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import { LoadedArrangements, useArrangementState, useStoredIds } from "./arrangements";
import { WorkspaceContext, useMutation, useQuery } from "./convex";
import { desktop, useUpdates } from "./desktop";
import { useAlerts } from "./notifications";
import { navigate, useRoute, views } from "./router";
import { ArchiveIcon, ArrowLeftIcon, DatabaseIcon, EditIcon, SettingsIcon, SignOutIcon } from "./icons";
import { MenuDivider, Notice, ResizeHandle, Scroll, TopBar, TruncatedTips, updateButton, useRun, useStoredWidth } from "./ui";
import { RecordsView } from "./views/Records";
import { roleNames } from "./views/Members";
import { SettingsNav, SettingsView, settingsScope, settingsTabAliases, settingsTabs } from "./views/Settings";
import { Landing } from "./views/Landing";
import { NameOnboarding, Onboarding } from "./views/Onboarding";
import { SignIn } from "./views/SignIn";
import { chatBadge } from "./views/chat/data";
import { TitleBar } from "./views/TitleBar";
import { AppRail } from "./views/AppRail";
import { WorkspaceSwitcher } from "./views/WorkspaceSwitcher";
import { type AppTab, type TabBadge, appTabs } from "./views/RailPins";
import { type PinKey, pinOf, usePins } from "./pins";
import { ChatView } from "./views/chat/ChatView";
import { GettingStarted } from "./views/chat/Tutorial";
import { Avatar, MenuItem, Popover, archiveQuestion, deviceTimeZone, useConfirm } from "./views/chat/common";
import { AddButton, AddMenu, ChannelsAdd, ChannelsNav, DmsNav, Item, NewSection, SectionGroup, SectionsNav, SidebarList } from "./views/chat/Sidebar";
import type { DragProps } from "./sortable";
import { type SectionId, useSections, useUnsectioned } from "./sections";
import { DriveNav, PagesView } from "./views/Pages";
import { FileView } from "./views/Files";
import { DriveView } from "./views/drive/Views";
import { ComingSoon } from "./views/ComingSoon";
import { DatabaseDialog } from "./views/records/DatabaseDialog";
import { AccessLock } from "./views/access";
import { type RecordType, useTypes } from "./views/records/data";
import { recordPath } from "./views/records/logic";

// The first databases used to have their own screens (#/clients …). Links to them in old messages still open.
const oldRecordTabs: Record<string, string> = { clients: "client", deals: "deal", tasks: "task", calls: "call" };
type View = (typeof views)[number];

export function App() {
	const { isLoading, isAuthenticated } = useConvexAuth();
	const draftMe = useQuery(api.workspace.me);
	useEffect(() => {
		if (!isLoading && !isAuthenticated) setFormDraftPerson(null);
		else if (draftMe !== undefined) setFormDraftPerson(draftMe?.userId ?? null);
	}, [isLoading, isAuthenticated, draftMe?.userId]);
	// Signed out, the landing comes first; Get started opens sign-in.
	const [started, setStarted] = useState(false);
	if (isLoading) return null;
	if (isAuthenticated) return <Workspace />;
	return started ? <SignIn onBack={() => setStarted(false)} /> : <Landing onStart={() => setStarted(true)} />;
}

/** Where this device keeps the workspace it has open. Each device picks its own. */
const OPEN_KEY = "companybot.workspace";

/**
 * Picks the workspace this window shows: the one this device had open, else the one you
 * used last anywhere (first launch), else your first. Every call below carries it. In none
 * (a first sign-in with no invites, or after deleting your last), onboarding makes one.
 */
function Workspace() {
	const mine = useQuery(api.workspace.mine);
	const { signOut } = useAuthActions();
	const ensure = useMutation(api.workspace.ensure);
	const remember = useMutation(api.workspace.switchTo);
	const [chosen, setChosen] = useState(() => localStorage.getItem(OPEN_KEY));
	const profile = useQuery(api.preferences.get);
	// Whether invites have been checked, so onboarding doesn't flash before they're joined.
	const [ensured, setEnsured] = useState(false);
	const { error, fail } = useRun();
	const ids = mine?.workspaces.map((w) => w.id) ?? [];
	const id = [chosen, mine?.lastUsed].find((w) => w && ids.includes(w as Id<"workspaces">)) ?? ids[0];
	// Closed while an owner resets it: nothing in it can be read. It reopens on #general (no chat named), started fresh.
	const resetting = mine?.workspaces.find((w) => w.id === id && w.resetting);
	const isResetting = !!resetting;
	useEffect(() => {
		if (isResetting) navigate("chat");
	}, [isResetting]);

	// An erased account acts as signed out before its old token expires, in every window.
	useEffect(() => {
		if (mine === null) void signOut();
	}, [mine, signOut]);

	// In no workspace (a first sign-in, or after leaving or deleting your last one): join the
	// workspaces that invited you. With none, onboarding below starts one.
	useEffect(() => {
		if (mine?.workspaces.length === 0) ensure().then(() => setEnsured(true), fail);
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
	// The new workspace opens once `mine` lists it.
	if (mine && ids.length === 0) return ensured ? <Onboarding onDone={(next) => (localStorage.setItem(OPEN_KEY, next), setChosen(next))} /> : null;
	if (!workspace || !profile) return null;
	if (resetting)
		return <div className="drag flex h-screen items-center justify-center p-8 text-sm text-neutral-500">Resetting {resetting.name}…</div>;
	if (!profile.displayName.trim()) return <NameOnboarding />;
	// Keyed by workspace: switching starts every screen fresh.
	return (
		<WorkspaceContext.Provider value={workspace}>
			<Opened key={workspace.id} />
		</WorkspaceContext.Provider>
	);
}

function Opened() {
	const me = useQuery(api.workspace.me);
	if (!me?.access) return null;
	return <LoadedArrangements userId={me.userId}><Shell email={me.email} access={me.access} workspace={me.workspace ?? ""} /></LoadedArrangements>;
}

function Shell({ email, access, workspace }: { email: string; access: Access; workspace: string }) {
	const arrangements = useArrangementState();
	const { signOut } = useAuthActions();
	const chats = useQuery(api.chats.list);
	const prefs = useQuery(api.preferences.get);
	const updatePrefs = useMutation(api.preferences.update);
	// Automatic time zone: keep the backend's copy of this computer's zone current.
	const timeZone = deviceTimeZone();
	useEffect(() => {
		if (prefs && prefs.deviceTimeZone !== timeZone) updatePrefs({ deviceTimeZone: timeZone }).catch(() => {});
	}, [prefs, timeZone, updatePrefs]);
	// Screens are paths: /home, /chat[/<chat>[/thread|message/<id>]], /inbox, /records/<type>[/<record>], /pages[/<page or folder>], /files/<file>, /drive/<view>, /sites, /settings/<tab>[/<item>] (Archive, Agents, Connectors, Skills and Automations included).
	const route = useRoute();
	// Trash (now Archive) and Customize used to be their own screens.
	useEffect(() => {
		if (route[0] === "customize") navigate("settings", ...(route.length > 1 ? route.slice(1) : ["agents"]));
		if (route[0] === "trash" || route[0] === "archive" || (route[0] === "settings" && route[1] === "trash")) navigate("settings", "archive");
		const oldType = oldRecordTabs[route[0] ?? ""];
		if (oldType) navigate("records", oldType, ...route.slice(1));
	}, [route]);
	const view: View = views.find((v) => v === route[0]) ?? "chat";
	const settingsTab = settingsTabs.find((t) => t.id === (settingsTabAliases[route[1] ?? ""] ?? route[1]))?.id ?? "general";
	// The rail's tab on screen. Settings (Customize included) lights none.
	const tab: AppTab | undefined =
		view === "home" ? "home" : view === "chat" ? "chat" : view === "inbox" ? "inbox" : view === "pages" || view === "files" || view === "drive" ? "drive" : view === "records" ? "databases" : view === "sites" ? "sites" : undefined;
	const types = useTypes();
	const [newDatabase, setNewDatabase] = useState(false);
	const [newSection, setNewSection] = useState(false);
	const sectionTab = tab === "chat" || tab === "drive" || tab === "databases" ? tab : undefined;
	const addSection = can(access, "sidebar.arrange") ? { label: "New section", onClick: () => setNewSection(true) } : undefined;
	// The database on screen, by key, and the record open in it.
	const typeKey = view === "records" ? route[1] : undefined;
	const recordId = view === "records" ? route[2] : undefined;
	// Workspace settings reopen on the tab you left them on.
	const lastWorkspaceSettings = useRef<string[]>(["settings", "general"]);
	if (view === "settings" && !tab && settingsScope(settingsTab) === "workspace") lastWorkspaceSettings.current = route;
	// Where "Back to app" goes from Settings.
	const lastApp = useRef<string[]>(["chat"]);
	if (tab) lastApp.current = route;
	// Each tab reopens where you left it; clicking the open one goes to its start (the first database).
	const lastIn = useRef<Partial<Record<AppTab, string[]>>>({});
	if (tab) lastIn.current[tab] = route;
	const startOf = (t: AppTab): string[] =>
		({ home: ["home"], chat: ["chat"], inbox: ["inbox"], drive: ["pages"], databases: types?.[0] ? recordPath(types[0].key) : ["records"], sites: ["sites"] })[t];
	const openTab = useCallback((t: AppTab) => navigate(...(t !== tab && lastIn.current[t] ? lastIn.current[t] : startOf(t))), [tab, types]);
	const { error, fail } = useRun();
	const { status: update } = useUpdates();

	const chatId = view === "chat" ? (route[1] as Id<"chats"> | undefined) : undefined;
	const openId = chatId ?? (chats?.channels.find((c) => c.isDefault) ?? chats?.channels[0] ?? chats?.dms[0])?._id;
	const open = (id: Id<"chats">) => {
		navigate("chat", id);
		fail();
	};
	useAlerts();
	// What's on screen, as a pin: lit in the rail, and added to its recents.
	const here: PinKey | undefined = view === "chat" ? (openId ? `chat:${openId}` : undefined) : pinOf(route);
	const { visit, canSaveRecent } = usePins();
	useEffect(() => {
		if (here && canSaveRecent) visit(here);
	}, [here, visit, canSaveRecent]);
	// What's waiting in Chat: chats with an unread @mention or DM, else any unread one.
	const badges: Partial<Record<AppTab, TabBadge>> = { chat: chats ? chatBadge(chats) : { mentions: 0, unread: false } };
	// The sidebar's sections fold when you click their title; folds sync with your account in this workspace.
	const [folded, changeFolded] = useStoredIds("folded");
	const fold = (id: string) => changeFolded({ op: folded.includes(id) ? "remove" : "add", id });
	// Hidden or shown, the sidebar stays that way on this computer.
	const [sidebar, setSidebar] = useState(() => localStorage.getItem("sidebar.hidden") !== "true");
	const sidebarWidth = useStoredWidth("sidebar.width", 240, 160, 600);
	const toggleSidebar = useCallback(() => setSidebar((shown) => (localStorage.setItem("sidebar.hidden", String(shown)), !shown)), []);

	return (
		<div className="flex h-screen flex-col bg-neutral-100 text-body text-neutral-900">
			{/* A title bar the width of the window holds its buttons; everything else sits below it. */}
			<TitleBar sidebar={sidebar} onSidebar={toggleSidebar} />
			<Notice>{arrangements?.error}</Notice>
			<TruncatedTips />
			<div className="flex min-h-0 flex-1">
				<AppRail
					tab={tab}
					onOpen={openTab}
					badges={badges}
					workspace={<WorkspaceSwitcher name={workspace} onSettings={() => navigate(...lastWorkspaceSettings.current)} />}
					workspaceName={workspace}
					open={here}
					you={prefs?.displayName || email}
					youMenu={
						<YouMenu
							name={prefs?.displayName || email}
							image={prefs?.image}
							email={email}
							access={access}
							onSettings={() => navigate("settings", "preferences")}
							onSignOut={() => { setFormDraftPerson(null); void signOut(); }}
						/>
					}
				/>
				{/* The sidebar and the open screen share one panel, its corner tucked under the title bar. */}
				<div className="flex min-w-0 flex-1 overflow-hidden rounded-tl-xl border-t border-l border-neutral-200 bg-white">
					{/* The sidebar lists the open tab's things, scrolling under its name. */}
					{sidebar && (
						<aside style={{ width: sidebarWidth.width }} className="drag relative flex shrink-0 flex-col border-r border-neutral-200 bg-neutral-50 select-none [--scrim:var(--color-neutral-50)]">
							<Scroll
								className="no-drag"
								header={
									// pt-2.5: its name sits on the same line as the top bar's title.
									<div className="drag px-3 pt-2.5 pb-4">
										{tab ? (
											<div className="flex items-center gap-1 pr-2">
												<h1 className="min-w-0 flex-1 truncate px-2 py-1 text-sm font-semibold">{appTabs.find((t) => t.id === tab)!.label}</h1>
												{/* The + here adds to the rows right under the name (channels, databases) and adds sections; a section (Direct messages, All files, the ones people add) has its own on its header. */}
												{tab === "chat" && (
													<span className="no-drag flex">
														<ChannelsAdd onOpen={open} onNewSection={addSection?.onClick} />
													</span>
												)}
												{(tab === "databases" || tab === "drive") && (
													<span className="no-drag flex">
														<AddMenu label="New" actions={[...(tab === "databases" && can(access, "fields.edit") ? [{ label: "New database", onClick: () => setNewDatabase(true) }] : []), ...(addSection ? [addSection] : [])]} />
													</span>
												)}
											</div>
										) : (
											<div className="no-drag flex flex-col">
												<Item icon={<ArrowLeftIcon />} onClick={() => navigate(...lastApp.current)}>
													Back to app
												</Item>
											</div>
										)}
									</div>
								}
								footer={
									<>
										<GettingStarted agent={chats?.agents[0]?.name ?? "an agent"} />
										{update?.state === "ready" && (
											<div className="flex flex-col px-3 pt-4 pb-3">
												<button type="button" onClick={() => void desktop()?.updates.install()} className={updateButton}>
													Update ready · Restart
												</button>
											</div>
										)}
									</>
								}
							>
								<SidebarList>
									{!tab && <SettingsNav tab={settingsTab} />}
									{tab === "chat" && chats && (
										<>
											<ChannelsNav chats={chats} openId={openId} openThread={route[2] === "thread" ? route[3] : undefined} onOpen={open} onError={fail} canManageAgents={can(access, "agents.manage")} />
											<DmsNav chats={chats} openId={openId} onOpen={open} onError={fail} canManageAgents={can(access, "agents.manage")} section={{ collapsed: folded.includes("dms"), onToggle: () => fold("dms") }} />
										</>
									)}
									{tab === "drive" && <DriveNav openId={view === "pages" ? route[1] : undefined} openFileId={view === "files" ? route[1] : undefined} openView={view === "drive" ? route[1] : undefined} canEdit={can(access, "pages.edit")} />}
									{tab === "databases" && <DatabasesNav types={types ?? []} openKey={typeKey} canCreate={can(access, "fields.edit")} />}
								</SidebarList>
							</Scroll>
							<ResizeHandle side="right" label="Resize sidebar" size={sidebarWidth} />
						</aside>
					)}

					{newDatabase && <DatabaseDialog onClose={() => setNewDatabase(false)} />}
					{newSection && sectionTab && <NewSection tab={sectionTab} onClose={() => setNewSection(false)} />}
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
						{view === "records" && <RecordsView key={typeKey} typeKey={typeKey} recordId={recordId} access={access} />}
						{view === "pages" && <PagesView pageId={route[1]} canEdit={can(access, "pages.edit")} />}
						{view === "files" && <FileView fileId={route[1]} />}
						{view === "drive" && <DriveView id={route[1]} />}
						{(view === "home" || view === "inbox" || view === "sites") && <ComingSoon tab={view} />}
						{view === "settings" && <SettingsView access={access} tab={settingsTab} itemId={route[2]} />}
					</main>
				</div>
			</div>
		</div>
	);
}

const typeKeyOf = (t: { _id: string }) => t._id;

/**
 * Databases' sidebar: the databases in no section, in the workspace's order, then the sections people
 * add (`SectionsNav`). New ones come from the + by the tab's name, or a section's own +.
 */
function DatabasesNav({
	types,
	openKey,
	canCreate,
}: {
	types: RecordType[];
	openKey: string | undefined;
	/** `fields.edit`: a section's + makes a database in it. */
	canCreate: boolean;
}) {
	const { place } = useSections("databases");
	const { sorted, drag } = useUnsectioned("databases", types, typeKeyOf);
	const byId = useMemo(() => new Map<string, RecordType>(types.map((t) => [t._id, t])), [types]);
	const [editing, setEditing] = useState<RecordType>();
	const [creatingIn, setCreatingIn] = useState<SectionId>();
	const remove = useMutation(api.trash.move);
	const update = useMutation(api.recordTypes.update);
	const { error, run } = useRun();
	const { confirm, dialog } = useConfirm();
	const row = (type: RecordType, drag: DragProps | undefined) => (
		<Item
			key={type._id}
			drag={drag}
			pin={`db:${type.key}`}
			icon={<DatabaseIcon />}
			label={type.plural}
			active={openKey === type.key}
			onClick={() => navigate(...recordPath(type.key))}
			rename={type.canManage ? { value: type.plural, onSave: (plural) => run(update({ typeId: type._id, plural, version: type.version })) } : undefined}
			menu={
				type.canManage
					? (close) => (
							<>
								<MenuItem onClick={() => (close(), setEditing(type))}><EditIcon /> Edit database</MenuItem>
								<MenuItem onClick={() => (close(), confirm(archiveQuestion(type.plural, () => remove({ kind: "database", id: type._id }).then(() => openKey === type.key && navigate("records")), "Its records will be archived with it.")))}>
									<ArchiveIcon /> Archive database
								</MenuItem>
							</>
						)
					: undefined
			}
		>
			<span className="truncate">{type.plural}</span>
			<AccessLock lock={type.lock} />
		</Item>
	);
	return (
		<>
			{!!sorted.length && <div className="flex flex-col gap-px">{sorted.map((type) => row(type, drag(type._id)))}</div>}
			<SectionsNav tab="databases">
				{(section, at) => (
					<SectionGroup
						{...at}
						tab="databases"
						section={section}
						rows={section.ids.filter((id) => byId.has(id))}
						// Folded, the open database stays.
						keep={(id) => byId.get(id)!.key === openKey}
						render={(id, drag) => row(byId.get(id)!, drag?.item)}
						add={canCreate && <AddButton label={`New database in ${section.name}`} onClick={() => setCreatingIn(section._id)} />}
					/>
				)}
			</SectionsNav>
			<Notice>{error}</Notice>
			{editing && <DatabaseDialog type={editing} onClose={() => setEditing(undefined)} />}
			{creatingIn && <DatabaseDialog onCreated={(id) => place(id, creatingIn)} onClose={() => setCreatingIn(undefined)} />}
			{dialog}
		</>
	);
}

/** You, at the bottom of the app rail: who you're signed in as, your account settings, and Sign out. */
function YouMenu({
	name,
	image,
	email,
	access,
	onSettings,
	onSignOut,
}: {
	name: string;
	image?: string | null;
	email: string;
	access: Access;
	onSettings: () => void;
	onSignOut: () => void;
}) {
	const roles = useQuery(api.roles.list);
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
							<p className="text-xs text-neutral-500">{roleNames(roles, access.roles).join(", ")}</p>
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
