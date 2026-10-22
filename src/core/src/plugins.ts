import type { z } from "zod";
import type { MemoryStore } from "./memory";
import type { Actor, Role } from "./types";

/** What a tool can reach while it runs. Grows as the platform adds services. */
export interface ToolContext {
	actor: Actor;
	agentId: string;
	memory: MemoryStore;
}

export interface PluginTool<Input = any> {
	name: string;
	description: string;
	input: z.ZodType<Input>;
	/** Roles allowed to use this tool. Omit for everyone. */
	roles?: Role[];
	execute(input: Input, ctx: ToolContext): Promise<unknown>;
}

/**
 * How a plugin connects to an outside service. Connections belong to the
 * workspace, never to one person. Only "none" exists until connectors ship.
 */
export type PluginConnection = { kind: "none" } | { kind: "api_key" } | { kind: "oauth"; scopes: string[] };

export interface Plugin {
	id: string;
	name: string;
	description: string;
	version: string;
	connection: PluginConnection;
	tools: PluginTool[];
}

export const definePlugin = (plugin: Plugin) => plugin;
export const defineTool = <Input>(tool: PluginTool<Input>) => tool;

/** Fully qualified tool id, e.g. "memory.save". Agents grant tools by this id. */
export const toolId = (pluginId: string, toolName: string) => `${pluginId}.${toolName}`;

/** The plugin store: everything available, plus what this workspace installed. */
export class PluginRegistry {
	private catalog = new Map<string, Plugin>();
	private installed = new Set<string>();

	constructor(plugins: Plugin[], installed: string[] = []) {
		for (const p of plugins) this.catalog.set(p.id, p);
		for (const id of installed) this.install(id);
	}

	list() {
		return [...this.catalog.values()].map((plugin) => ({ plugin, installed: this.installed.has(plugin.id) }));
	}

	get(id: string) {
		return this.catalog.get(id);
	}

	isInstalled(id: string) {
		return this.installed.has(id);
	}

	install(id: string) {
		if (!this.catalog.has(id)) throw new Error(`Unknown plugin: ${id}`);
		this.installed.add(id);
	}

	uninstall(id: string) {
		this.installed.delete(id);
	}

	findTool(id: string) {
		const [pluginId, name] = id.split(".");
		const plugin = pluginId ? this.catalog.get(pluginId) : undefined;
		const tool = plugin?.tools.find((t) => t.name === name);
		return plugin && tool ? { plugin, tool } : undefined;
	}
}
