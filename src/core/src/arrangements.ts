/** One definition for storage scope and the entity each ordered list belongs to. */
export const arrangementLists = {
	channels: { scope: "shared", entity: undefined },
	dms: { scope: "personal", entity: undefined },
	databases: { scope: "shared", entity: undefined },
	pages: { scope: "shared", entity: "pages" },
	views: { scope: "shared", entity: "recordTypes" },
	columns: { scope: "shared", entity: "recordTypes" },
	sections: { scope: "personal", entity: undefined },
	folded: { scope: "personal", entity: undefined },
	channelFolds: { scope: "personal", entity: undefined },
	dmFolds: { scope: "personal", entity: undefined },
	expanded: { scope: "personal", entity: undefined },
	pins: { scope: "personal", entity: undefined },
	recent: { scope: "personal", entity: undefined },
	pinsOrder: { scope: "personal", entity: undefined },
	tabs: { scope: "personal", entity: undefined },
	workspaces: { scope: "account", entity: undefined },
} as const;
export type ArrangementList = keyof typeof arrangementLists;
export type Arrangement = { list: ArrangementList; entityId?: string; ids: string[] };
export const sidebarSections = ["channels", "dms"];
export const railTabs = ["chat", "drive", "databases", "customize"];

type Legacy = { list: ArrangementList | "layout"; workspaceId?: string; entityId?: string; databaseKey?: string };
/** Used only by the one-time localStorage importer, never by live reads or writes. */
export function legacyArrangement(key: string): Legacy | undefined {
	const fixed = { "rail.order": "workspaces", "rail.tabs": "tabs", "sidebar.sections": "sections", "sidebar.folded": "folded" } as const;
	if (key in fixed) return { list: fixed[key as keyof typeof fixed] };
	const workspace = /^(rail\.pins|rail\.pins\.order|rail\.recent|sidebar\.channels|sidebar\.dms|sidebar\.databases|sidebar\.channels\.folded|sidebar\.dms\.folded|pages-expanded):([^:]+)$/.exec(key);
	if (workspace) {
		const lists = { "rail.pins": "pins", "rail.pins.order": "pinsOrder", "rail.recent": "recent", "sidebar.channels": "channels", "sidebar.dms": "dms", "sidebar.databases": "databases", "sidebar.channels.folded": "channelFolds", "sidebar.dms.folded": "dmFolds", "pages-expanded": "expanded" } as const;
		return { list: lists[workspace[1] as keyof typeof lists], workspaceId: workspace[2] };
	}
	const pages = /^sidebar\.pages:([^:]+):([^:]+)$/.exec(key);
	if (pages) return { list: "pages", workspaceId: pages[1], entityId: pages[2] === "top" ? undefined : pages[2] };
	const views = /^views\.order:([^:]+)$/.exec(key);
	if (views) return { list: "views", entityId: views[1] };
	const display = /^records\.(columns|layout)\.(.+)$/.exec(key);
	if (display) return { list: display[1] as "columns" | "layout", databaseKey: display[2] };
}
