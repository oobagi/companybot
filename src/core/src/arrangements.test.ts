import { expect, it } from "vitest";
import { arrangementScope } from "./arrangements";

it("assigns every arrangement to its account or workspace scope", () => {
	expect(arrangementScope("rail.order")).toBe("account");
	for (const key of ["rail.tabs", "sidebar.sections", "sidebar.folded", "rail.pins:w", "rail.recent:w", "rail.pins.order:w", "sidebar.dms:w", "sidebar.channels.folded:w", "sidebar.dms.folded:w", "pages-expanded:w"]) expect(arrangementScope(key), key).toBe("personal");
	for (const key of ["sidebar.channels:w", "sidebar.databases:w", "sidebar.pages:w:top", "sidebar.pages:w:page", "views.order:type", "records.columns.job", "records.layout.job"]) expect(arrangementScope(key), key).toBe("shared");
	for (const key of ["sidebar.width", "sidebar.hidden", "draft:w", "unknown", "sidebar.pages:w"]) expect(arrangementScope(key), key).toBeUndefined();
});
