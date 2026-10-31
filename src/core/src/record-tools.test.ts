import { toolLine } from "./action-words";
import { toolRisk } from "./action-rules";
import { MODEL_OUTPUT_MAX, type RecordFindInput, type RecordPage, type RecordStore, forModel } from "./record-tools";
import { describe, expect, it } from "vitest";
import { isStepCount, simulateReadableStream, streamText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { callLabel } from "./activity";
import { agentStopWhen, buildToolSet } from "./agents";
import { builtinTools } from "./builtin-tools";
import { companybot } from "./default-agents";
import { type Field, displayValues } from "./records";
import { platformGuide } from "./guide";
import { widgetTools } from "./widgets";

import { member, ctx } from "../test/helpers";

describe("records tools", () => {
	const tool = (id: string) => builtinTools.find((t) => t.id === id)!;
	const deal = (n: number) => ({ _id: `d${n}`, name: `Deal ${n}`, value: `$${n},000.00` });
	/** A store whose list comes back in short pages, as the backend's can. */
	const store = (pages: RecordPage[]) => {
		const calls: (RecordFindInput & { numItems: number })[] = [];
		const records = {
			find: async (input: RecordFindInput & { numItems: number }) => (calls.push(input), pages.shift() ?? { error: "no more" }),
		} as unknown as RecordStore;
		return { calls, c: { ...ctx(member), records } };
	};

	it("keeps asking while a page comes back short, passing the cursor on", async () => {
		const { calls, c } = store([
			{ type: "Deals", typeName: "Deal", rows: [deal(1)], more: true, cursor: "c1" },
			{ type: "Deals", typeName: "Deal", rows: [], more: true, cursor: "c2" },
			{ type: "Deals", typeName: "Deal", rows: [deal(2), deal(3)], more: true, cursor: "c3" },
		]);
		const filters = [{ field: "stage", in: ["Won"] }];
		const out = await tool("records.find").execute({ type: "deal", filters, limit: 3 }, c);
		expect(out).toEqual({ type: "Deals", typeName: "Deal", rows: [deal(1), deal(2), deal(3)], more: true, cursor: "c3" });
		expect(calls.map((x) => [x.cursor, x.numItems, x.filters])).toEqual([
			[undefined, 3, filters],
			["c1", 2, filters],
			["c2", 2, filters],
		]);
	});

	it("stops when the list is done, or after a few requests, and passes errors through", async () => {
		const done = store([{ type: "Deals", typeName: "Deal", rows: [deal(1)], more: false, cursor: "end" }]);
		expect(await tool("records.find").execute({ type: "deal" }, done.c)).toEqual({ type: "Deals", typeName: "Deal", rows: [deal(1)], more: false });
		const sparse = store(Array.from({ length: 9 }, (_, i) => ({ type: "Deals", typeName: "Deal", rows: [], more: true, cursor: `c${i}` })));
		expect(await tool("records.find").execute({ type: "deal" }, sparse.c)).toEqual({ type: "Deals", typeName: "Deal", rows: [], more: true, cursor: "c4" });
		expect(sparse.calls).toHaveLength(5);
		const bad = store([]);
		expect(await tool("records.find").execute({ type: "deal" }, bad.c)).toEqual({ error: "no more" });
	});

	it("hand every other call straight to the store, acting for the person", async () => {
		const seen: unknown[] = [];
		const record = (name: string) => async (input?: unknown) => (seen.push([name, input]), { ok: name });
		const records = { types: record("types"), get: record("get"), save: record("save"), undo: record("undo"), saveField: record("saveField") };
		const c = { ...ctx(member), records: records as unknown as RecordStore };
		await tool("records.types").execute({}, c);
		await tool("records.get").execute({ id: "r1" }, c);
		await tool("records.save").execute({ type: "client", values: { name: "Acme" } }, c);
		await tool("records.undo").execute({ change: "h1" }, c);
		await tool("records.save_field").execute({ type: "client", label: "Roof type", kind: "text" }, c);
		expect(seen).toEqual([
			["types", {}],
			["get", { id: "r1" }],
			["save", { type: "client", values: { name: "Acme" } }],
			["undo", { change: "h1" }],
			["saveField", { type: "client", label: "Roof type", kind: "text" }],
		]);
	});

	it("reads large history entries without losing content between chunks", async () => {
		const entry = { _id: "h1", changes: [{ key: "notes", old: "x".repeat(10_000), new: '\"'.repeat(20_000) }] };
		const c = { ...ctx(member), records: { history: async () => entry } as unknown as RecordStore };
		let json = "";
		let start = 0;
		for (;;) {
			const chunk: any = await tool("records.history").execute({ change: "h1", start }, c);
			const output = { ref: "r1", data: chunk };
			expect((await tool("records.history").toModelOutput!({ toolCallId: "c", input: { change: "h1" }, output }) as any).value).toEqual(output);
			json += chunk.json;
			if (!chunk.more) break;
			start = chunk.next;
		}
		expect(JSON.parse(json)).toEqual(entry);
	});

	it("run right away: internal, undoable, nothing sent outside", () => {
		const ids = builtinTools.filter((t) => t.id.startsWith("records.")).map((t) => t.id);
		expect(ids).toEqual(["records.types", "records.find", "records.get", "records.history", "records.save", "records.undo", "records.save_field", "records.save_database", "records.views", "records.save_view"]);
		for (const id of ids) expect(toolRisk(tool(id))).toBe(id === "records.undo" ? "locked" : tool(id).readOnly ? "none" : "inside");
		expect(ids.filter((id) => tool(id).readOnly)).toEqual(["records.types", "records.find", "records.get", "records.history", "records.views"]);
		expect(ids.filter((id) => tool(id).permission)).toEqual(["records.save_database", "records.save_view"]);
		expect(toolLine(callLabel("records_undo", builtinTools, []), "done")).toBe("Undid a record change");
		expect(toolLine(callLabel("records_save", builtinTools, []), "running")).toBe("Saving a record…");
	});

	it("tool lines say what each call did, from its input and result", () => {
		const line = (name: string, status: "running" | "done" | "error", input: unknown, output?: unknown) =>
			toolLine(callLabel(name, builtinTools, [], { input, output }), status);
		const created = { id: "r2", type: "deal", typeName: "Deal", name: "Reroof main warehouse", values: {}, change: "h2" };
		const acme = { id: "r1", type: "client", typeName: "Client", name: "Acme Roofing", values: {}, change: "h1" };
		const deal = { type: "deal", values: { name: "Reroof main warehouse" } };
		expect(line("records_types", "done", {})).toBe("Looked up databases");
		expect(line("records_save", "running", deal)).toBe("Creating deal Reroof main warehouse…");
		expect(line("records_save", "done", deal, created)).toBe("Created deal Reroof main warehouse");
		expect(line("records_save", "error", deal)).toBe("Couldn't create deal Reroof main warehouse");
		expect(line("records_save", "done", deal, { error: "No stage “Pitch”." })).toBe("Saved a record");
		expect(line("records_save", "running", { id: "r1", values: { roof_type: "Metal" } })).toBe("Saving a record…");
		expect(line("records_save", "done", { id: "r1", values: { roof_type: "Metal" } }, acme)).toBe("Saved Acme Roofing");
		expect(line("records_save", "done", { id: "r1", trash: true }, acme)).toBe("Archived Acme Roofing");
		expect(line("records_save", "done", { id: "r1", trash: false }, acme)).toBe("Restored Acme Roofing");
		expect(line("records_undo", "done", { change: "h1" }, { undone: "h1", ...acme })).toBe("Undid a change to Acme Roofing");
		expect(line("records_get", "done", { id: "r1" }, { ref: "r1", data: acme })).toBe("Opened Acme Roofing");
		const page = (rows: number, more = false) => ({ ref: "r1", data: { type: "Deals", typeName: "Deal", rows: Array.from({ length: rows }, (_, i) => ({ _id: `d${i}` })), more } });
		expect(line("records_find", "running", { type: "deal" })).toBe("Finding records…");
		expect(line("records_find", "done", { type: "deal" }, page(1))).toBe("Found 1 deal");
		expect(line("records_find", "done", { type: "deal" }, page(3))).toBe("Found 3 deals");
		expect(line("records_find", "done", { type: "deal" }, page(0))).toBe("Found no deals");
		expect(line("records_find", "done", { type: "deal" }, page(20, true))).toBe("Found 20+ deals");
		const field = { type: "client", label: "Roof type", kind: "choice", options: ["Shingle", "Metal", "Flat"] };
		expect(line("records_save_field", "running", field)).toBe("Adding field Roof type…");
		expect(line("records_save_field", "done", field, { type: "client", typePlural: "Clients", key: "roof_type", label: "Roof type" })).toBe(
			"Added field Roof type to Clients",
		);
		expect(line("records_save_field", "done", { type: "client", field: "roof_type", options: ["Tile"] }, { typePlural: "Clients", label: "Roof type" })).toBe(
			"Updated field Roof type on Clients",
		);
		// Tools without a label keep their title.
		expect(line("memory_search", "done", { query: "" }, { ref: "r1", data: [] })).toBe("Searched memory");
	});

	it("show values the way people read them, amounts in their own currency", () => {
		const fields: Field[] = [
			{ key: "name", label: "Name", kind: "text" },
			{ key: "stage", label: "Stage", kind: "choice", options: [{ id: "won", label: "Won" }, { id: "old", label: "Old", retired: true }] },
			{ key: "tags", label: "Tags", kind: "choice", multiple: true, options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] },
			{ key: "value", label: "Value", kind: "currency" },
			{ key: "cad", label: "CAD", kind: "currency" },
			{ key: "owner", label: "Owner", kind: "user" },
			{ key: "client", label: "Client", kind: "link", linkType: "client" },
			{ key: "paid", label: "Paid", kind: "checkbox" },
			{ key: "minutes", label: "Minutes", kind: "number" },
			{ key: "close", label: "Close date", kind: "date" },
		];
		const values = {
			name: "Roof",
			stage: "old",
			tags: ["a", "b"],
			value: { minor: 125050, currency: "USD" },
			cad: { minor: 4000, currency: "CAD" },
			owner: "u1",
			client: "r1",
			paid: true,
			minutes: 12,
			close: "2026-11-15",
			gone: "kept off",
		};
		expect(displayValues(fields, values, { u1: { name: "Jaden" }, r1: { name: "Acme", archived: true } })).toEqual({
			name: "Roof",
			stage: "Old",
			tags: "A, B",
			value: "$1,250.50",
			cad: "CA$40.00",
			owner: "Jaden",
			client: "Acme (deleted)",
			paid: "Yes",
			minutes: 12,
			close: "Nov 15, 2026",
		});
		expect(displayValues(fields, { owner: "u9" })).toEqual({ owner: "u9" });
	});

	it("trim what the model sees of a big result, but keep it whole for widgets", async () => {
		const notes = Object.fromEntries(Array.from({ length: 30 }, (_, f) => [`notes_${f}`, "x".repeat(10_000)]));
		const big = Array.from({ length: 50 }, (_, i) => ({ _id: `d${i}`, name: `Deal ${i}`, ...notes }));
		const records = { find: async () => ({ type: "Deals", typeName: "Deal", rows: big, more: false }) } as unknown as RecordStore;
		const c = { ...ctx(member), records };
		const find = buildToolSet(companybot, c).records_find!;
		const output = await (find.execute as (input: unknown, options: unknown) => Promise<unknown>)({ type: "deal", limit: 50 }, { toolCallId: "1", messages: [] });
		expect(c.results.get("r1")).toEqual({ type: "Deals", typeName: "Deal", rows: big, more: false });
		const seen = (await find.toModelOutput!({ toolCallId: "1", input: {}, output } as never)) as { type: string; value: any };
		expect(JSON.stringify(seen.value).length).toBeLessThanOrEqual(MODEL_OUTPUT_MAX + 400);
		expect(seen.value.ref).toBe("r1");
		expect(seen.value.data.rows[0].notes_0).toMatch(/^x+… \(cut from 10000 characters\)$/);
		expect(seen.value.data.rows.length).toBeLessThan(50);
		expect(seen.value.data.trimmed).toMatch(/\d+ long values cut to 80 characters; showing \d+ of 50 rows\. Widgets using r1 show everything/);
		// Widgets read the whole result by ref.
		const table = await widgetTools.find((t) => t.id === "widgets.table")!.execute({ columns: ["Deal"], from: { ref: "r1", path: "rows", fields: ["name"] } }, c);
		expect((table as any).widget.props.rows).toHaveLength(50);
		// Small results and errors reach the model as they are.
		const small = { ref: "r2", data: { type: "Deals", typeName: "Deal", rows: [deal(1)], more: false } };
		expect(forModel(small, 300)).toBe(small);
		expect(forModel({ error: "Nope" }, 300)).toEqual({ error: "Nope" });
		// One huge record: text cut shorter until it fits.
		const record = { ref: "r3", data: { id: "x", values: Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`f${i}`, "y".repeat(5_000)])) } };
		const fitted = forModel(record, 2_000) as any;
		expect(JSON.stringify(fitted).length).toBeLessThanOrEqual(MODEL_OUTPUT_MAX + 400);
		expect(fitted.data.trimmed).toMatch("60 long values cut");
	});

	it("teach agents records only when granted", () => {
		expect(platformGuide({ tools: ["records.*"] })).toContain("## Databases");
		expect(platformGuide({ tools: ["records.find"] })).not.toContain("records_types");
		expect(platformGuide({ tools: ["memory.*"] })).not.toContain("## Databases");
	});

	it("work in a real turn: the model lists deals, then shows them in a table by ref", async () => {
		const records = {
			find: async () => ({ type: "Deals", typeName: "Deal", rows: [deal(1), deal(2), deal(3)], more: false }),
		} as unknown as RecordStore;
		const c = { ...ctx(member), records };
		const tools = buildToolSet(companybot, c);
		const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
		const finish = { type: "finish" as const, finishReason: { unified: "tool-calls" as const, raw: undefined }, usage };
		const steps = [
			[{ type: "tool-call" as const, toolCallId: "c1", toolName: "records_find", input: JSON.stringify({ type: "deal", filters: [{ field: "close_date", gte: "2026-10-01" }] }) }],
			[
				{
					type: "tool-call" as const,
					toolCallId: "c2",
					toolName: "widgets_table",
					input: JSON.stringify({ columns: ["Deal", "Value"], from: { ref: "r1", path: "rows", fields: ["name", "value"] } }),
				},
			],
			[{ type: "text-start" as const, id: "t" }, { type: "text-delta" as const, id: "t", delta: "Three deals." }, { type: "text-end" as const, id: "t" }],
		];
		const model = new MockLanguageModelV4({
			doStream: async () => ({ stream: simulateReadableStream({ chunks: [...steps.shift()!, finish] }) }),
		});
		const result = streamText({ model, prompt: "what deals close this month?", tools, stopWhen: isStepCount(5) });
		const outputs: unknown[] = [];
		for await (const part of result.stream) if (part.type === "tool-result") outputs.push(part.output);
		expect(outputs[0]).toEqual({ ref: "r1", data: { type: "Deals", typeName: "Deal", rows: [deal(1), deal(2), deal(3)], more: false } });
		expect(outputs[1]).toEqual({
			widget: { type: "table", props: { columns: ["Deal", "Value"], rows: [["Deal 1", "$1,000.00"], ["Deal 2", "$2,000.00"], ["Deal 3", "$3,000.00"]] } },
		});
		expect(model.doStreamCalls).toHaveLength(3);
	});

	it("keep working after a widget: show this month's deals, then mark them all won", async () => {
		const saved: unknown[] = [];
		const records = {
			find: async () => ({ type: "Deals", typeName: "Deal", rows: [deal(1), deal(2)], more: false }),
			save: async (input: unknown) => (saved.push(input), { id: "d1", type: "deal", typeName: "Deal", name: "Deal 1", values: {}, change: "h1" }),
		} as unknown as RecordStore;
		const tools = buildToolSet(companybot, { ...ctx(member), records });
		const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
		const finish = (unified: "tool-calls" | "stop") => ({ type: "finish" as const, finishReason: { unified, raw: undefined }, usage });
		const text = (delta: string) => [{ type: "text-start" as const, id: "t" }, { type: "text-delta" as const, id: "t", delta }, { type: "text-end" as const, id: "t" }];
		const call = (toolCallId: string, toolName: string, input: unknown) => ({ type: "tool-call" as const, toolCallId, toolName, input: JSON.stringify(input) });
		const steps = [
			[call("c1", "records_find", { type: "deal" }), finish("tool-calls")],
			// It has said something and placed only a widget: the run must not stop here.
			[...text("Two deals close this month."), call("c2", "widgets_table", { columns: ["Deal"], from: { ref: "r1", path: "rows", fields: ["name"] } }), finish("tool-calls")],
			[call("c3", "records_save", { id: "d1", values: { stage: "Won" } }), call("c4", "records_save", { id: "d2", values: { stage: "Won" } }), finish("tool-calls")],
			[...text("Both are Won now."), finish("stop")],
		];
		const model = new MockLanguageModelV4({
			doStream: async () => ({ stream: simulateReadableStream({ chunks: steps.shift()! }) }),
		});
		const result = streamText({ model, prompt: "show me deals closing this month, then mark them all won", tools, stopWhen: agentStopWhen });
		const done: string[] = [];
		for await (const part of result.stream) if (part.type === "tool-result") done.push(part.toolName);
		expect(done).toEqual(["records_find", "widgets_table", "records_save", "records_save"]);
		expect(saved).toEqual([{ id: "d1", values: { stage: "Won" } }, { id: "d2", values: { stage: "Won" } }]);
		expect(await result.text).toBe("Both are Won now.");
		expect(model.doStreamCalls).toHaveLength(4);
	});
});
