import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import type { Access } from "@companybot/core/permissions";
import { DatabaseIcon } from "../icons";
import { EmptyState, NotFound, Page } from "../ui";
import { useTypes } from "./records/data";
import { RecordList } from "./records/RecordList";
import { RecordPage } from "./records/RecordPage";

/**
 * A type's list, or one record's page: /records/<key>[/<id>].
 * Every type shares the same screens.
 */
export function RecordsView({ typeKey, recordId, access }: { typeKey?: string; recordId?: string; access: Access }) {
	const types = useTypes();
	// Databases are opened from the sidebar; /records alone (Databases with none open, or none yet) says so.
	if (!typeKey)
		return (
			// No title: the sidebar beside it already says Databases, as Chat with nothing open.
			<Page title="">
				<EmptyState icon={<DatabaseIcon />} title={types?.length === 0 ? "No databases yet" : "No database open"}>
					{types?.length === 0 ? "People whose role can add databases make one with + beside Databases in the sidebar." : "Open a database from the sidebar."}
				</EmptyState>
			</Page>
		);
	if (!types) return <NotFound loaded={false} icon={<DatabaseIcon />} title="Database not found" />;
	const type = types.find((t) => t.key === typeKey);
	if (!type) return <NotFound loaded icon={<DatabaseIcon />} title="Database not found" />;
	return recordId ? (
		<RecordPage key={recordId} type={type} recordId={recordId as Id<"records">} access={access} />
	) : (
		<RecordList key={type._id} type={type} access={access} />
	);
}
