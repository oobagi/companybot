import { describe, expect, it } from "vitest";
import { buildToolSet } from "./agents";
import { openConnector } from "./mcp";
import { defineConnector } from "./connectors";
import { fakeMcpServer } from "../test/test-mcp-server";
import { platformGuide } from "./guide";
import { describeWidget, isWidgetResult, widgetTools } from "./widgets";

import { owner, ctx } from "../test/helpers";

describe("widgets", () => {
	const table = widgetTools.find((t) => t.id === "widgets.table")!;

	it("returns a widget for the app and a short receipt for the model", async () => {
		const props = { title: "Leads", columns: ["Name", "Stage"], rows: [["Ada", "Won"]] };
		const output = await table.execute(props, ctx(owner));
		expect(output).toEqual({ widget: { type: "table", props } });
		expect(isWidgetResult(output)).toBe(true);
		const receipt = await table.toModelOutput!({ toolCallId: "1", input: props, output } as never);
		expect(receipt).toMatchObject({ type: "text" });
		expect(describeWidget({ type: "table", props })).toBe('[You showed a table "Leads" with 1 rows (Name, Stage) widget]');
	});

	it("shows a tool result by ref without copying rows", async () => {
		const c = ctx(owner);
		const leads = [
			{ name: "Ada", stage: "Won", owner: { email: "a@x.co" }, hot: true },
			{ name: "Grace", stage: "New", owner: null, hot: false },
		];
		// Data tools' results reach the model as { ref, data }.
		const server = fakeMcpServer([{ name: "find" }], () => JSON.stringify({ leads }));
		const crm = defineConnector({
			id: "notes",
			name: "CRM",
			description: "Test",
			version: "1.0.0",
			publisher: "Test",
			mcp: { url: "https://example.com/mcp", transport: "http" },
			connection: "personal",
			auth: { type: "none" },
		});
		const session = await openConnector(crm, { transport: server });
		const tools = buildToolSet({ tools: ["notes.find"] }, c, session.tools);
		const found = await tools.connectors_call!.execute!({ tool: "notes.find", input: {} }, { toolCallId: "1", messages: [] } as never);
		expect(found).toEqual({ ref: "r1", data: { leads } });
		await session.close();

		const from = { ref: "r1", path: "leads", fields: ["name", "owner.email", "hot"] };
		expect(await table.execute({ columns: ["Name", "Owner", "Hot"], from }, c)).toEqual({
			widget: {
				type: "table",
				props: { columns: ["Name", "Owner", "Hot"], rows: [["Ada", "a@x.co", "Yes"], ["Grace", null, "No"]] },
			},
		});
		expect(await table.execute({ columns: ["Name"], from: { ...from, path: undefined, fields: ["name"] } }, c)).toEqual({
			error: "r1 isn't a list. Its keys: leads.",
		});
		expect(await table.execute({ columns: ["Name"], from: { ref: "r9", fields: ["name"] } }, c)).toMatchObject({
			error: expect.stringContaining('No result "r9"'),
		});
	});

	it("sends the model a fixable error for ragged rows", async () => {
		const output = await table.execute({ columns: ["A", "B"], rows: [["only one"]] }, ctx(owner));
		expect(output).toEqual({ error: "Row 1 has 1 cells but there are 2 columns." });
	});

	it("teaches widgets only to agents that have them", () => {
		expect(platformGuide({ tools: ["widgets.*"] })).toContain("## Widgets");
		expect(platformGuide({ tools: ["memory.search"] })).not.toContain("## Widgets");
		expect(platformGuide({ tools: [] })).toContain("Markdown");
		expect(platformGuide({ tools: ["chat.*"] })).toContain("## Chat");
		expect(platformGuide({ tools: [] })).not.toContain("## Chat");
	});
});
