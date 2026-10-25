import { Page } from "../ui";

/** Top-level tabs for business records. Each will list one record type (see wiki/data.md). */
export const recordTabs = [
	{ id: "clients", label: "Clients" },
	{ id: "deals", label: "Deals" },
	{ id: "tasks", label: "Tasks" },
	{ id: "calls", label: "Calls" },
	{ id: "campaigns", label: "Campaigns" },
] as const;
export type RecordTab = (typeof recordTabs)[number]["id"];

export function RecordsView({ tab }: { tab: RecordTab }) {
	return (
		<Page title={recordTabs.find((t) => t.id === tab)!.label}>
			<p className="text-sm text-neutral-500">Coming soon.</p>
		</Page>
	);
}
