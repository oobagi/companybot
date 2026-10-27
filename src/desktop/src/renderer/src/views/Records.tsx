import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import { can, type Role } from "@companybot/core";
import { Loading, Page, descriptionClass } from "../ui";
import { useTypes } from "./records/data";
import { RecordList } from "./records/RecordList";
import { RecordPage } from "./records/RecordPage";

// COMPAT(0.1.0-alpha.8): existing bookmarks use these routes; all databases also work at /records/<key>.
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
export function RecordsView({ typeKey, recordId, role }: { typeKey?: string; recordId?: string; role: Role }) {
	const types = useTypes();
	if (!types) return <Page title=""><Loading /></Page>;
	if (!typeKey) return (
		<Page title="Databases">
			<p className={descriptionClass}>{types.length
				? "Choose a database in the sidebar."
				: can(role, "fields.manage")
					? "No databases yet. Choose New database in the sidebar, or ask Companybot to make one for your team."
					: "No databases yet. An owner can create one for your team."}</p>
		</Page>
	);
	const type = types.find((t) => t.key === typeKey);
	if (!type) {
		return (
			<Page title="Not found">
				<p className="text-sm text-neutral-500">This database may have been deleted. Look in Trash.</p>
			</Page>
		);
	}
	return recordId ? (
		<RecordPage key={recordId} type={type} recordId={recordId as Id<"records">} role={role} />
	) : (
		<RecordList key={type._id} type={type} role={role} />
	);
}
