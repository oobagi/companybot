/** One definition for storage scope and the entity each ordered list belongs to. */
export const arrangementLists = {
	channels: { scope: "shared", entity: undefined },
	dms: { scope: "personal", entity: undefined },
	databases: { scope: "shared", entity: undefined },
	pages: { scope: "shared", entity: "pages" },
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
/** Sidebar sections that fold (`folded`): Chat's Direct messages and Drive's All files. Channels and Home sit above them, in no section. */
export const sidebarSections = ["dms", "files"];
export const railTabs = ["chat", "drive", "databases", "customize"];
/** A pin's key: what it is and its id (`chat:…`, `page:…`, `db:…`, `rec:…`). */
export const isPinKey = (id: string) => /^(chat|page|db|rec):./.test(id);
/**
 * Lists the rail had before tabs and pins became one (`rail`; `migrations.railOrder` merges them), and the
 * order of Chat's sections from when Channels was one (`migrations.dropSectionOrder` deletes it).
 * COMPAT(0.1.0-alpha.10): delete with them.
 */
export const retiredLists = ["tabs", "pinsOrder", "sections"] as const;

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
