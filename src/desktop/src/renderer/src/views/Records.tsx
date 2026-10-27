import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import type { Role } from "@companybot/core";
import { Loading, Page } from "../ui";
import { useTypes } from "./records/data";
import { RecordList } from "./records/RecordList";
import { RecordPage } from "./records/RecordPage";

/** Top-level tabs for business records. Each lists one database (see wiki/data.md). */
export const recordTabs = [
	{ id: "clients", label: "Clients" },
	{ id: "deals", label: "Deals" },
	{ id: "tasks", label: "Tasks" },
	{ id: "calls", label: "Calls" },
] as const;

/**
 * A type's list, or one record's page: /clients, /clients/<id>, /records/<key>[/<id>].
 * Every type shares the same screens.
 */
export function RecordsView({ typeKey, recordId, role }: { typeKey: string; recordId?: string; role: Role }) {
	const types = useTypes();
	if (!types) return <Loading />;
	const type = types.find((t) => t.key === typeKey);
	if (!type) {
		return (
			<Page title="Not found">
				<p className="text-sm text-neutral-500">This database may have been archived.</p>
			</Page>
		);
	}
	return recordId ? (
		<RecordPage key={recordId} type={type} recordId={recordId as Id<"records">} role={role} />
	) : (
		<RecordList key={type._id} type={type} role={role} />
	);
}
