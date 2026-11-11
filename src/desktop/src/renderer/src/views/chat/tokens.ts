import type { TokenNames } from "./data";

// @names, #channels, /skills and tagged @records in a message's text, found the same way in a person's
// plain text and in an agent's Markdown reply, so both show the same clickable chips. A record reads in the
// text as the server wrote it for this reader (`@Summit Homes`, `@Private record`), listed on the message.

export type Token =
	| { kind: "person"; text: string; ref: TokenNames["people"][number] }
	| { kind: "channel"; text: string; ref: TokenNames["channels"][number] }
	| { kind: "skill"; text: string; ref: TokenNames["skills"][number] }
	| { kind: "record"; text: string; ref: NonNullable<TokenNames["records"]>[number] };

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Longest first, so "@Scout Pro" isn't "@Scout". */
const alternation = (names: string[]) => [...names].sort((a, b) => b.length - a.length).map(escape).join("|");

/**
 * The text cut into plain runs and tokens. Names match any case (agents may write "@quill"), and only
 * at a word's start: "ada@x.co" and "a/Proposal" aren't tokens.
 */
export function splitTokens(text: string, tokens: TokenNames): (string | Token)[] {
	const records = tokens.records ?? [];
	const parts = [
		// First: a message's own tags win over a person who happens to share the name.
		records.length > 0 && `(?:${alternation(records.map((r) => r.text))})(?![\\w-])`,
		tokens.people.length > 0 && `@(?:${alternation(tokens.people.map((p) => p.name))})(?![\\w-])`,
		tokens.channels.length > 0 && `#(?:${alternation(tokens.channels.map((c) => c.name))})(?![\\w-])`,
		tokens.skills.length > 0 && `\\/(?:${alternation(tokens.skills.map((s) => s.name))})(?![\\w-])`,
	].filter(Boolean);
	if (parts.length === 0) return [text];
	const pattern = new RegExp(`(?<![\\w@#/])(${parts.join("|")})`, "gi");
	return text.split(pattern).flatMap((chunk, i): (string | Token)[] => {
		if (i % 2 === 0) return chunk ? [chunk] : [];
		const token = findToken(chunk, tokens);
		return token ? [token] : [chunk];
	});
}

export function findToken(text: string, tokens: TokenNames): Token | undefined {
	const name = text.slice(1).toLowerCase();
	const same = (n: string) => n.toLowerCase() === name;
	const record = tokens.records?.find((r) => r.text.toLowerCase() === text.toLowerCase());
	if (record) return { kind: "record", text, ref: record };
	if (text.startsWith("@")) {
		const ref = tokens.people.find((p) => same(p.name));
		return ref && { kind: "person", text, ref };
	}
	if (text.startsWith("#")) {
		const ref = tokens.channels.find((c) => same(c.name));
		return ref && { kind: "channel", text, ref };
	}
	const ref = tokens.skills.find((s) => same(s.name));
	return ref && { kind: "skill", text, ref };
}

/** The bits of hast (the HTML tree Markdown becomes) this needs. */
type HastNode = { type: string; tagName?: string; value?: string; properties?: Record<string, unknown>; children?: HastNode[] };

/** The element a token becomes in a Markdown tree; `Markdown` renders it as the chip. */
export const TOKEN_TAG = "chat-token";

/** Not inside code, where an @name is an example, or a link, which already goes somewhere. */
const skip = new Set(["code", "pre", "a"]);

/**
 * A rehype plugin, used as `[rehypeTokens, tokens]`: tokens in an agent's reply become `TOKEN_TAG`
 * elements. Runs after the sanitizer, which would drop them. Streamdown caches its Markdown processor
 * by each plugin's function name and options, so the names go in as options, not in a closure.
 */
export function rehypeTokens(tokens: TokenNames) {
	return (tree: HastNode) => {
		const walk = (node: HastNode) => {
			if (!node.children || (node.tagName && skip.has(node.tagName))) return;
			node.children = node.children.flatMap((child): HastNode[] => {
				if (child.type !== "text") return walk(child), [child];
				return splitTokens(child.value ?? "", tokens).map((part) =>
					typeof part === "string"
						? { type: "text", value: part }
						: { type: "element", tagName: TOKEN_TAG, properties: { dataToken: part.text }, children: [{ type: "text", value: part.text }] },
				);
			});
		};
		walk(tree);
	};
}
