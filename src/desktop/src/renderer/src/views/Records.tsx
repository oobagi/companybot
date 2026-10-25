import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import type { Role } from "@companybot/core";
import { Loading, Page } from "../ui";
import { useTypes } from "./records/data";
import { builtinTabs } from "./records/logic";
import { RecordList } from "./records/RecordList";
import { RecordPage } from "./records/RecordPage";

/** Top-level tabs for business records. Each lists one record type (see wiki/data.md). */
export const recordTabs = [
	{ id: "clients", label: "Clients" },
	{ id: "deals", label: "Deals" },
	{ id: "tasks", label: "Tasks" },
	{ id: "calls", label: "Calls" },
	{ id: "campaigns", label: "Campaigns" },
] as const;
export type RecordTab = (typeof recordTabs)[number]["id"];

/** Types owners added, which get their own tabs under /records/<key>. */
export function useAddedTypes() {
	return useTypes()?.filter((t) => !builtinTabs[t.key]) ?? [];
}

/**
 * A type's list, or one record's page: /clients, /clients/<id>, /records/<key>[/<id>].
 * Every type shares the same screens.
 */
export function RecordsView({ typeKey, recordId, role }: { typeKey: string; recordId?: string; role: Role }) {
	const types = useTypes();
	if (typeKey === "campaign") {
		return (
			<Page title="Campaigns">
				<p className="text-sm text-neutral-500">Coming soon.</p>
			</Page>
		);
	}
	if (!types) return <Loading />;
	const type = types.find((t) => t.key === typeKey);
	if (!type) {
		return (
			<Page title="Not found">
				<p className="text-sm text-neutral-500">This record type may have been archived.</p>
			</Page>
		);
	}
	return recordId ? (
		<RecordPage key={recordId} type={type} recordId={recordId as Id<"records">} role={role} />
	) : (
		<RecordList key={type._id} type={type} role={role} />
	);
}
