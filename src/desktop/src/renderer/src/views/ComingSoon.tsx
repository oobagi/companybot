import { HomeIcon, SitesIcon } from "../icons";
import { EmptyState, Page } from "../ui";

// Rail tabs that are planned but not built yet. Each says what it will hold, so the rail shows where the app is going.
const soon = {
	home: { icon: HomeIcon, title: "Home is coming soon", text: "What needs you today will be here: approvals, follow-ups due, new leads, and what your agents did while you were away." },
	sites: { icon: SitesIcon, title: "Sites is coming soon", text: "Your agents will build and keep up your website and lead forms here, using what's in your databases." },
};

export function ComingSoon({ tab }: { tab: keyof typeof soon }) {
	const { icon: Icon, title, text } = soon[tab];
	return (
		// No title: the sidebar beside it already names the tab.
		<Page title="">
			<EmptyState icon={<Icon />} title={title}>
				{text}
			</EmptyState>
		</Page>
	);
}
