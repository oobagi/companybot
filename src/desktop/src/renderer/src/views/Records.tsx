import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import { can, type Role } from "@companybot/core";
import { useState } from "react";
import { DatabaseIcon } from "../icons";
import { EmptyState, NewButton, NotFound, Page, descriptionClass } from "../ui";
import { DatabaseDialog } from "./records/DatabaseDialog";
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
	const [creating, setCreating] = useState(false);
	if (!types) return <NotFound loaded={false} />;
	if (!typeKey) return (
		<Page title="Databases" actions={can(role, "fields.manage") && <NewButton label="New database" onClick={() => setCreating(true)} />}>
			{types.length ? <p className={descriptionClass}>Choose a database in the sidebar.</p> : (
				<EmptyState icon={<DatabaseIcon />} title="No databases yet">
					{can(role, "fields.manage") ? "Organize your team's work with records and custom fields." : "An owner can create a database for your team."}
				</EmptyState>
			)}
			{creating && <DatabaseDialog onClose={() => setCreating(false)} />}
		</Page>
	);
	const type = types.find((t) => t.key === typeKey);
	if (!type) return <NotFound loaded>This database may have been deleted. Look in Trash.</NotFound>;
	return recordId ? (
		<RecordPage key={recordId} type={type} recordId={recordId as Id<"records">} role={role} />
	) : (
		<RecordList key={type._id} type={type} role={role} />
	);
}
