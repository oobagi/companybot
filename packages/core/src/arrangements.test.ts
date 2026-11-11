import { expect, it } from "vitest";
import { arrangementLists, legacyArrangement } from "./arrangements";

it("defines scope and entity ownership once and translates local keys only for migration", () => {
	expect(arrangementLists.workspaces.scope).toBe("account");
	expect(arrangementLists.pins.scope).toBe("personal");
	expect(arrangementLists.channels.scope).toBe("shared");
	expect(arrangementLists.views.entity).toBe("recordTypes");
	expect(arrangementLists.pages.entity).toBe("pages");
	expect(legacyArrangement("sidebar.pages:ws:parent")).toEqual({ list: "pages", workspaceId: "ws", entityId: "parent" });
	expect(legacyArrangement("rail.pins:ws")).toEqual({ list: "pins", workspaceId: "ws" });
	for (const key of ["records.columns.job", "records.layout.job", "sidebar.width", "sidebar.hidden", "draft:w", "unknown"]) expect(legacyArrangement(key)).toBeUndefined();
});
