import { ChatIcon, DriveIcon, HistoryIcon, PrivateIcon } from "../../icons";
import { EmptyState, NotFound, Page } from "../../ui";

// Drive's views under Home: Recent, Shared in chat and Private, each a sidebar row and a screen at
// #/drive/<view>. The screens say "Coming soon" until #264 builds them.

const drive = { label: "Drive", to: ["pages"] };

export const driveViews = [
	{ id: "recent", label: "Recent", icon: <HistoryIcon />, soon: "What was edited lately, across every folder, will show here." },
	{ id: "shared", label: "Shared in chat", icon: <ChatIcon />, soon: "Files people posted in channels and DMs you can see will show here, so you can find them again." },
	{ id: "private", label: "Private", icon: <PrivateIcon />, soon: "Pages, folders and files only you can see will live here. Move one out to share it." },
];

export function DriveView({ id }: { id: string | undefined }) {
	const view = driveViews.find((v) => v.id === id);
	if (!view) return <NotFound crumbs={[drive]} loaded icon={<DriveIcon />} title="No such view">Drive has Recent, Shared in chat and Private.</NotFound>;
	return (
		<Page title={view.label} crumbs={[drive]}>
			<EmptyState icon={view.icon} title="Coming soon">{view.soon}</EmptyState>
		</Page>
	);
}
