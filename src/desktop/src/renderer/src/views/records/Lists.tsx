import { databaseRowIds } from "@companybot/core/arrangements";
import { DatabaseIcon, FollowUpIcon, UserIcon } from "../../icons";
import { EmptyState, NotFound, Page } from "../../ui";

// Databases' lists above the databases, across every one of them: Assigned to me and Due, each a
// sidebar row (in your order, `databaseRows`) and a screen at #/databases/<list>. The screens say
// "Coming soon" until they're built.

const lists: Record<string, { label: string; icon: React.ReactNode; soon: string }> = {
	mine: { label: "Assigned to me", icon: <UserIcon />, soon: "Records where a person field is you, across every database, will show here." },
	due: { label: "Due", icon: <FollowUpIcon />, soon: "Records with a date coming up or past, and agents' follow-ups, will show here." },
};
export const databaseLists = databaseRowIds.map((id) => ({ id, ...lists[id]! }));

export function DatabaseList({ id }: { id: string | undefined }) {
	const list = databaseLists.find((l) => l.id === id);
	if (!list) return <NotFound loaded icon={<DatabaseIcon />} title="No such list">Databases has Assigned to me and Due.</NotFound>;
	return (
		<Page title={list.label}>
			<EmptyState icon={list.icon} title="Coming soon">{list.soon}</EmptyState>
		</Page>
	);
}
