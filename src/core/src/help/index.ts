import accountSettings from "./account-settings";
import activity from "./activity";
import agents from "./agents";
import automations from "./automations";
import chat from "./chat";
import connectors from "./connectors";
import databases from "./databases";
import general from "./general";
import members from "./members";
import memory from "./memory";
import overview from "./overview";
import pages from "./pages";
import permissions from "./permissions";
import settings from "./settings";
import skills from "./skills";
import trash from "./trash";

// Help for the people in a workspace, read by agents through `help.read`. Plain Markdown in
// string modules, so it works unchanged in core, Convex's bundler and vitest. One page per area.
// Keep it current: wiki/extending.md → Help. help.test.ts fails when a settings tab has no link.

export interface HelpPage {
	/** Short and stable: agents pass it as `topic`. */
	id: string;
	title: string;
	/** One line, shown in the topic list. */
	summary: string;
	/** Markdown. Link screens as [Members](#/settings/members). Refer to other pages as **help: topic-id**. */
	text: string;
}

export const helpPages: readonly HelpPage[] = [overview, chat, agents, memory, skills, automations, databases, pages, connectors, permissions, members, trash, activity, settings, accountSettings, general];

export const helpTopics = () => helpPages.map(({ id, title, summary }) => ({ id, title, summary }));

const stopWords = new Set(["the", "and", "how", "can", "do", "does", "what", "where", "which", "who", "why", "for", "with", "from", "that", "this", "are", "you", "your", "its", "into", "get", "make", "use", "change", "set"]);

/** The words worth matching in a query: lowercase, 3+ letters, no filler. */
const words = (text: string) => (text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).filter((w) => !stopWords.has(w));

/** About 160 characters around the first place one of `terms` appears, on one line. */
function excerpt(text: string, terms: string[]) {
	const flat = text.replace(/[#*|>`]/g, "").replace(/\s+/g, " ").trim();
	const at = Math.min(...terms.map((t) => flat.toLowerCase().indexOf(t)).filter((i) => i >= 0), flat.length);
	const start = Math.max(0, at - 60);
	return `${start > 0 ? "…" : ""}${flat.slice(start, start + 160).trim()}${start + 160 < flat.length ? "…" : ""}`;
}

/** Pages matching any word of `query`, best first: title hits count most, then summary, then text. */
export function searchHelp(query: string, limit = 5) {
	const terms = [...new Set(words(query))];
	return helpPages
		.map((page) => {
			const title = page.title.toLowerCase(), summary = page.summary.toLowerCase(), text = page.text.toLowerCase();
			const score = terms.reduce((sum, t) => sum + (title.includes(t) ? 10 : 0) + (summary.includes(t) ? 4 : 0) + Math.min(text.split(t).length - 1, 5), 0);
			return { page, score };
		})
		.filter((m) => m.score > 0)
		.sort((a, b) => b.score - a.score)
		.slice(0, limit)
		.map(({ page }) => ({ id: page.id, title: page.title, excerpt: excerpt(page.text, terms) }));
}

/** What `help.read` returns: the topic list, one page, or search matches. */
export function readHelp({ topic, query }: { topic?: string; query?: string }) {
	if (topic) {
		const page = helpPages.find((p) => p.id === topic.trim().toLowerCase());
		return page ? { id: page.id, title: page.title, text: page.text } : { error: `No help topic "${topic}".`, topics: helpTopics() };
	}
	if (query?.trim()) return { matches: searchHelp(query) };
	return { topics: helpTopics() };
}
