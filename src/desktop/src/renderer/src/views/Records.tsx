import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import type { Role } from "@companybot/core/permissions";
import { useEffect } from "react";
import { DatabaseIcon } from "../icons";
import { redirect } from "../router";
import { NotFound } from "../ui";
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
	// Databases are opened from the sidebar; /records alone has nothing to show, so it goes to chat.
	useEffect(() => {
		if (!typeKey) redirect("chat");
	}, [typeKey]);
	if (!typeKey) return null;
	if (!types) return <NotFound loaded={false} icon={<DatabaseIcon />} title="Database not found" />;
	const type = types.find((t) => t.key === typeKey);
	if (!type) return <NotFound loaded icon={<DatabaseIcon />} title="Database not found" />;
	return recordId ? (
		<RecordPage key={recordId} type={type} recordId={recordId as Id<"records">} role={role} />
	) : (
		<RecordList key={type._id} type={type} role={role} />
	);
}
