/** One definition for storage scope and the entity each ordered list belongs to. */
export const arrangementLists = {
	channels: { scope: "shared", entity: undefined },
	dms: { scope: "personal", entity: undefined },
	databases: { scope: "shared", entity: undefined },
	pages: { scope: "shared", entity: "pages" },
	/** The order of the sections people add (`sidebarSections`), every tab's in one list. */
	sectionOrder: { scope: "shared", entity: undefined },
	views: { scope: "shared", entity: "recordTypes" },
	columns: { scope: "shared", entity: "recordTypes" },
	folded: { scope: "personal", entity: undefined },
	channelFolds: { scope: "personal", entity: undefined },
	dmFolds: { scope: "personal", entity: undefined },
	expanded: { scope: "personal", entity: undefined },
	pins: { scope: "personal", entity: undefined },
	recent: { scope: "personal", entity: undefined },
	/** The rail's one group, in your order: its tabs (`railTabs`) and your pins, mixed. */
	rail: { scope: "personal", entity: undefined },
	/** Drive's rows above its tree, in your order: Home and the views (`driveRowIds`). */
	driveRows: { scope: "personal", entity: undefined },
	/** Inbox's views in no section (`inboxRowIds`), in the workspace's order. */
	inbox: { scope: "shared", entity: undefined },
	/** Inbox's Channels group (`inboxChannelIds`), in the workspace's order. */
	inboxChannels: { scope: "shared", entity: undefined },
	workspaces: { scope: "account", entity: undefined },
} as const;
export type ArrangementList = keyof typeof arrangementLists;
export type Arrangement = { list: ArrangementList; entityId?: string; ids: string[] };

/** Recents kept, so a few can be pinned or deleted and some still show. */
export const RECENT_KEPT = 12;

/**
 * One change to a list, applied to whatever the server holds now, so two devices' changes both land.
 * `add` (pin, fold, expand, show a column) appends if absent; `remove` takes it out; `visit` moves it to
 * the front of recents; `move` puts it before `beforeId`, or last when that's null or gone.
 * `seed`: the list to start from when nothing is saved yet (a database's default columns).
 * `fill`: ids shown but never saved, before the drop, appended first if absent so the drop lands where it looked.
 */
export type ArrangementCommand =
	| { op: "add" | "remove" | "visit"; id: string; seed?: string[] }
	| { op: "move"; id: string; beforeId: string | null; fill?: string[] };

export function applyCommand(saved: readonly string[] | undefined, command: ArrangementCommand): string[] {
	const ids = !saved?.length && "seed" in command && command.seed ? command.seed : saved ?? [];
	const { id } = command;
	switch (command.op) {
		case "add": return ids.includes(id) ? [...ids] : [...ids, id];
		case "remove": return ids.filter((k) => k !== id);
		case "visit": return [id, ...ids.filter((k) => k !== id)].slice(0, RECENT_KEPT);
		case "move": {
			const have = new Set(ids);
			const rest = [...ids, ...(command.fill ?? []).filter((k) => !have.has(k) && (have.add(k), true))].filter((k) => k !== id);
			const at = command.beforeId === null ? -1 : rest.indexOf(command.beforeId);
			rest.splice(at < 0 ? rest.length : at, 0, id);
			return rest;
		}
	}
}

/** The ids a command names besides `id`: checked only for shape, never read one by one. */
export const extraIds = (command: ArrangementCommand) => ("fill" in command ? command.fill : "seed" in command ? command.seed : undefined) ?? [];
/**
 * Built-in sidebar sections: Chat's Direct messages, Drive's All files, Inbox's Channels and Tags. They're
 * always there: nobody deletes them. They fold (`folded`) and move (`sectionOrder`) by these ids, among
 * the sections people add (`sidebarSections` rows), which do both by theirs.
 */
export const builtInSections = ["dms", "files", "inboxChannels", "inboxTags"];
/**
 * Tabs whose sidebar takes sections people add, like Discord's categories, and the shared list that
 * orders their items in no section: Chat's channels, Drive's top-level pages, folders and files, the
 * databases, Inbox's views (`inboxRowIds`). Each item is in at most one of its tab's sections.
 */
export const sectionTabs = { chat: "channels", drive: "pages", databases: "databases", inbox: "inbox" } as const;
export type SectionTab = keyof typeof sectionTabs;
/** Sections one tab can have, and items one section holds, so the sidebar's reads stay bounded. */
export const SECTIONS_MAX = 50;
export const SECTION_ITEMS_MAX = 500;
export const SECTION_NAME_MAX = 80;
/** The rail's tabs, in the order a new rail shows them. The one list: the desktop draws these, the server accepts only these. */
export const railTabs: readonly string[] = ["home", "chat", "inbox", "drive", "databases", "sites"];
/** Drive's sidebar rows above its tree: Home (the top level) and the views (desktop `views/drive/Views.tsx`). */
export const driveRowIds = ["home", "recent", "shared", "private"];
/**
 * Inbox's views at the top of its sidebar (desktop `views/Inbox.tsx`): who's handling what. They move
 * like Chat's channels, into and out of sections people add. Fixed, so the server accepts only these.
 */
export const inboxRowIds = ["needs", "mine", "agent", "all"];
/** Inbox's built-in Channels group, like Chat's Direct messages: reordered within it, never deleted or moved out. */
export const inboxChannelIds = ["email", "sms", "calls", "whatsapp", "instagram", "messenger", "webchat"];
/** A pin's key: what it is and its id (`chat:…`, `page:…` (a page or folder), `file:…`, `db:…`, `rec:…`). */
export const isPinKey = (id: string) => /^(chat|page|file|db|rec|inbox):./.test(id);

type Legacy = { list: ArrangementList | "layout"; workspaceId?: string; entityId?: string; databaseKey?: string };
/** COMPAT(0.1.0-alpha.10): used only by the one-time localStorage importer, never by live reads or writes; delete with it. */
export function legacyArrangement(key: string): Legacy | undefined {
	const fixed = { "rail.order": "workspaces", "rail.tabs": "rail", "sidebar.folded": "folded" } as const;
	if (key in fixed) return { list: fixed[key as keyof typeof fixed] };
	const workspace = /^(rail\.pins|rail\.pins\.order|rail\.recent|sidebar\.channels|sidebar\.dms|sidebar\.databases|sidebar\.channels\.folded|sidebar\.dms\.folded|pages-expanded):([^:]+)$/.exec(key);
	if (workspace) {
		const lists = { "rail.pins": "pins", "rail.pins.order": "rail", "rail.recent": "recent", "sidebar.channels": "channels", "sidebar.dms": "dms", "sidebar.databases": "databases", "sidebar.channels.folded": "channelFolds", "sidebar.dms.folded": "dmFolds", "pages-expanded": "expanded" } as const;
		return { list: lists[workspace[1] as keyof typeof lists], workspaceId: workspace[2] };
	}
	const pages = /^sidebar\.pages:([^:]+):([^:]+)$/.exec(key);
	if (pages) return { list: "pages", workspaceId: pages[1], entityId: pages[2] === "top" ? undefined : pages[2] };
	const views = /^views\.order:([^:]+)$/.exec(key);
	if (views) return { list: "views", entityId: views[1] };
	const display = /^records\.(columns|layout)\.(.+)$/.exec(key);
	if (display) return { list: display[1] as "columns" | "layout", databaseKey: display[2] };
}
