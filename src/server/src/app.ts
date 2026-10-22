import {
	type Actor,
	buildToolSet,
	builtinPlugins,
	defaultAgents,
	describeToolAccess,
	InMemoryMemoryStore,
	type MemoryScope,
	PermissionError,
	PluginRegistry,
	canEditMemory,
} from "@companybot/core";
import {
	type UIMessage,
	convertToModelMessages,
	createUIMessageStreamResponse,
	isStepCount,
	streamText,
	toUIMessageStream,
} from "ai";
import { Hono } from "hono";
import { cors } from "hono/cors";

// Dev-only people for testing permissions. Replaced by real auth later.
export const users = [
	{ id: "jaden", name: "Jaden", role: "owner" },
	{ id: "teammate", name: "Teammate", role: "member" },
] as const;

export function createApp() {
	const registry = new PluginRegistry(builtinPlugins, ["memory", "clock"]);
	const memory = new InMemoryMemoryStore();
	// One continuous conversation per person per agent.
	const conversations = new Map<string, UIMessage[]>();

	const app = new Hono<{ Variables: { actor: Actor } }>();
	app.use(cors());

	app.get("/users", (c) => c.json(users));

	app.use("*", async (c, next) => {
		if (c.req.path === "/users" || c.req.method === "OPTIONS") return next();
		const user = users.find((u) => u.id === c.req.header("x-user-id"));
		if (!user) return c.json({ error: "Unknown user" }, 401);
		c.set("actor", { userId: user.id, role: user.role });
		await next();
	});

	app.onError((err, c) => {
		if (err instanceof PermissionError) return c.json({ error: err.message }, 403);
		return c.json({ error: err.message }, 400);
	});

	app.get("/agents", (c) =>
		c.json(
			defaultAgents.map(({ id, name, description, model }) => ({
				id,
				name,
				description,
				model,
				tools: describeToolAccess(defaultAgents.find((a) => a.id === id)!, c.get("actor"), registry),
			})),
		),
	);

	app.get("/agents/:id/messages", (c) => {
		const key = `${c.get("actor").userId}:${c.req.param("id")}`;
		return c.json(conversations.get(key) ?? []);
	});

	app.post("/agents/:id/chat", async (c) => {
		const actor = c.get("actor");
		const agent = defaultAgents.find((a) => a.id === c.req.param("id"));
		if (!agent) return c.json({ error: "Unknown agent" }, 404);

		// The client sends only its newest message; the server owns history.
		const { message } = await c.req.json<{ message: UIMessage }>();
		const key = `${actor.userId}:${agent.id}`;
		const history = [...(conversations.get(key) ?? []), message];
		const tools = buildToolSet(agent, { actor, agentId: agent.id, memory }, registry);

		const result = streamText({
			model: agent.model,
			instructions: agent.instructions,
			messages: await convertToModelMessages(history),
			tools,
			stopWhen: isStepCount(5),
		});

		return createUIMessageStreamResponse({
			stream: toUIMessageStream({
				stream: result.stream,
				tools,
				originalMessages: history,
				onEnd: ({ messages }) => {
					conversations.set(key, messages);
				},
			}),
		});
	});

	app.get("/plugins", (c) =>
		c.json(
			registry.list().map(({ plugin, installed }) => ({
				id: plugin.id,
				name: plugin.name,
				description: plugin.description,
				version: plugin.version,
				connection: plugin.connection,
				installed,
				tools: plugin.tools.map((t) => ({ name: t.name, description: t.description, roles: t.roles ?? null })),
			})),
		),
	);

	app.post("/plugins/:id/:action{install|uninstall}", (c) => {
		if (c.get("actor").role !== "owner") throw new PermissionError("Only owners can manage plugins.");
		const id = c.req.param("id");
		c.req.param("action") === "install" ? registry.install(id) : registry.uninstall(id);
		return c.json({ id, installed: registry.isInstalled(id) });
	});

	app.get("/memory", async (c) => {
		const actor = c.get("actor");
		const all = await memory.list(actor);
		return c.json(all.map((m) => ({ ...m, canEdit: canEditMemory(actor, m) })));
	});

	app.post("/memory", async (c) => {
		const body = await c.req.json<{ scope: MemoryScope; content: string }>();
		return c.json(await memory.create(c.get("actor"), body), 201);
	});

	app.patch("/memory/:id", async (c) => {
		const { content } = await c.req.json<{ content: string }>();
		return c.json(await memory.update(c.get("actor"), c.req.param("id"), content));
	});

	app.delete("/memory/:id", async (c) => {
		await memory.remove(c.get("actor"), c.req.param("id"));
		return c.body(null, 204);
	});

	return app;
}
