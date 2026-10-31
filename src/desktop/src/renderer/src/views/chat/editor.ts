import { type Editor, Extension, InputRule, mergeAttributes } from "@tiptap/core";
import Document from "@tiptap/extension-document";
import HardBreak from "@tiptap/extension-hard-break";
import Mention, { type MentionNodeAttrs } from "@tiptap/extension-mention";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";
import { Placeholder, UndoRedo } from "@tiptap/extensions";
import type { SuggestionKeyDownProps, SuggestionOptions, SuggestionProps } from "@tiptap/suggestion";
import type { ChannelRef, Participant, SkillRef } from "./data";
import { COMPLETED_SHORTCODE, type EmojiIndex, emojiForShortcode, loadEmoji, loadedEmoji, shortcodeMatches } from "./emoji";

// The composer is a one-block Tiptap editor (the same ProseMirror BlockNote uses for pages).
// Mentions are atomic `token` nodes, so a chip is picked, deleted and sent as one thing:
// `@Ada` (people and agents), `#sales` (channels) and `/Proposal` (skills). The message is
// sent as plain text: the chips serialize back to what was typed. `:smi` opens a fourth menu,
// of emoji; a pick (or a typed `:smile:`) is just the emoji in the text, not a chip.

export type Trigger = "@" | "#" | "/" | ":";

export type Candidate =
	| { kind: "user" | "agent"; id: string; label: string; image?: string | null }
	| { kind: "channel"; id: string; label: string; topic: string | null; private: boolean; joined: boolean }
	| { kind: "skill"; id: string; label: string; description: string }
	/** `id` is the shortcode, `label` the emoji. */
	| { kind: "emoji"; id: string; label: string };

/** What a chip can be: every candidate but emoji. */
export type TokenKind = Exclude<Candidate["kind"], "emoji">;
/** A chip's attributes; Mention's own (`mentionSuggestionChar`) come with it. */
export type TokenAttrs = MentionNodeAttrs & { kind: TokenKind };

/** What each trigger offers. Read live, so the lists can change while the editor stays. */
export interface Sources {
	people: Participant[];
	agents: Participant[];
	channels: ChannelRef[];
	skills: SkillRef[];
}

/** The open menu: what's offered, which row is lit, and how to pick one. */
export interface Menu {
	trigger: Trigger;
	items: Candidate[];
	index: number;
}

const MAX_ITEMS = 8;
/** Shorter than this and `:` is more likely a smiley or a time than a shortcode. */
const MIN_EMOJI_QUERY = 2;

/** `query` matches a name's start or any word's start ("sa" finds "Sam Lee" and "Ada Sampson"). */
export const matches = (name: string, query: string) => {
	const n = name.toLowerCase();
	const q = query.toLowerCase();
	return n.startsWith(q) || n.split(/[\s-]+/).some((w) => w.startsWith(q));
};

/** The emoji `:query` offers, by shortcode. */
export function emojiCandidates(index: EmojiIndex, query: string): Candidate[] {
	if (query.length < MIN_EMOJI_QUERY) return [];
	return shortcodeMatches(index, query, MAX_ITEMS).map((m) => ({ kind: "emoji", id: m.shortcode, label: m.emoji.char }));
}

export function candidatesFor(sources: Sources, trigger: Exclude<Trigger, ":">, query: string): Candidate[] {
	const all: Candidate[] =
		trigger === "@"
			? [...sources.people, ...sources.agents].map((p) => ({ kind: p.type, id: p.id, label: p.name, image: p.image }))
			: trigger === "#"
				? sources.channels.map((c) => ({ kind: "channel", id: c.id, label: c.name, topic: c.topic, private: c.private, joined: c.joined }))
				: sources.skills.map((s) => ({ kind: "skill", id: s.id, label: s.name, description: s.description }));
	return all.filter((c) => matches(c.label, query)).slice(0, MAX_ITEMS);
}

/**
 * The trigger being typed at the end of `text` (the text since the last chip, up to the caret):
 * at the start or after a space, then the query. `@` allows one space inside ("@Sam L"); the
 * others don't, since channels and skills are picked by one word.
 */
export function findTrigger(text: string, trigger: Trigger): { start: number; query: string } | null {
	const t = trigger === "/" ? "\\/" : trigger;
	const m = new RegExp(`(^|\\s)${t}([^\\s${t}]*${trigger === "@" ? `(?: [^\\s${t}]*)?` : ""})$`).exec(text);
	return m ? { start: m.index + m[1]!.length, query: m[2]! } : null;
}

const triggerChar = (kind: TokenKind): Exclude<Trigger, ":"> => (kind === "channel" ? "#" : kind === "skill" ? "/" : "@");

/**
 * Serves the three suggestion plugins and owns the menu: it publishes the state the
 * composer renders, and answers the keys the editor passes it while the menu is open.
 */
export class SuggestionMenu {
	private menu: Menu | null = null;
	private command: ((attrs: TokenAttrs) => void) | null = null;
	/** Hidden on blur: the plugin stays active, but the keys go to the editor until typing resumes. */
	private hidden = false;

	constructor(
		private readonly sources: () => Sources,
		private readonly publish: (menu: Menu | null) => void,
	) {}

	get open() {
		return !this.hidden && this.menu !== null && this.menu.items.length > 0;
	}

	hide() {
		this.hidden = true;
		this.publish(null);
	}

	pick(index: number) {
		const item = this.menu?.items[index];
		// An emoji pick runs its own command (insertEmoji), which reads only the id and label.
		if (item && this.command) this.command({ id: item.id, label: item.label, kind: item.kind as TokenKind });
	}

	highlight(index: number) {
		if (this.menu) this.set({ ...this.menu, index });
	}

	private set(menu: Menu | null) {
		this.menu = menu;
		this.publish(this.open ? menu : null);
	}

	/** One suggestion plugin's options for a trigger. */
	suggestion(trigger: Trigger): Omit<SuggestionOptions<Candidate, TokenAttrs>, "editor"> {
		const show = (props: SuggestionProps<Candidate>) => {
			this.hidden = false;
			this.command = props.command;
			this.set({ trigger, items: props.items, index: Math.min(this.menu?.trigger === trigger ? this.menu.index : 0, Math.max(props.items.length - 1, 0)) });
		};
		return {
			char: trigger,
			items: async ({ query }) => (trigger === ":" ? emojiCandidates(await loadEmoji(), query) : candidatesFor(this.sources(), trigger, query)),
			...(trigger === ":" && { command: insertEmoji }),
			findSuggestionMatch: ({ $position }) => {
				const before = $position.nodeBefore;
				const text = before?.isText ? (before.text ?? "") : "";
				const found = findTrigger(text, trigger);
				if (!found) return null;
				const from = $position.pos - text.length + found.start;
				return { range: { from, to: $position.pos }, query: found.query, text: text.slice(found.start) };
			},
			render: () => ({
				onStart: show,
				onUpdate: show,
				onExit: () => this.set(null),
				onKeyDown: ({ event }: SuggestionKeyDownProps) => {
					if (!this.open || !this.menu) return false;
					const { items, index } = this.menu;
					if (event.key === "ArrowDown" || event.key === "ArrowUp") {
						this.highlight((index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length);
						return true;
					}
					if (event.key === "Enter" || event.key === "Tab") {
						this.pick(index);
						return true;
					}
					return false;
				},
			}),
		};
	}
}

/** A picked emoji replaces the `:query` typed, with a space after like a chip. */
const insertEmoji: SuggestionOptions<Candidate, TokenAttrs>["command"] = ({ editor, range, props }) => {
	editor.chain().focus().insertContentAt(range, `${props.label} `).run();
};

/** A typed `:smile:` becomes 😄, once the emoji data is loaded (opening the menu loads it). */
const EmojiShortcodes = Extension.create({
	name: "emojiShortcodes",
	addInputRules() {
		return [
			new InputRule({
				find: COMPLETED_SHORTCODE,
				handler: ({ state, range, match }) => {
					const index = loadedEmoji();
					const emoji = index && emojiForShortcode(index, match[1]!);
					if (!emoji) return null;
					// The range ends after the typed ":" (it's already in), so back up over ":name:".
					state.tr.insertText(emoji.char, range.to - match[1]!.length - 2, range.to);
				},
			}),
		];
	},
});

/** `@Ada`, `#sales`, `/Proposal`: one inline atom per chip. */
const Token = Mention.extend({
	name: "token",
	addAttributes() {
		return {
			...this.parent?.(),
			kind: {
				default: "user",
				parseHTML: (el: HTMLElement) => el.getAttribute("data-kind"),
				renderHTML: (attrs: { kind: TokenKind }) => ({ "data-kind": attrs.kind }),
			},
		};
	},
});

const chipText = (node: { attrs: Record<string, unknown> }) => `${triggerChar(node.attrs.kind as TokenKind)}${node.attrs.label}`;

export type SendWith = "enter" | "mod-enter";

/** Enter (or ⌘Enter, by preference) sends, unless the menu is open; the other one breaks the line. */
const Send = Extension.create<{ send: () => void; sendWith: () => SendWith; menuOpen: () => boolean }>({
	name: "send",
	// Ahead of the core keymap (100), or Enter splits the paragraph first. It's also ahead of the
	// suggestion plugins (101), so it steps aside while the menu is open and their Enter picks a row.
	priority: 1000,
	addKeyboardShortcuts() {
		const send = (when: SendWith) => () => {
			if (this.options.sendWith() !== when || this.options.menuOpen()) return false;
			this.options.send();
			return true;
		};
		return { Enter: send("enter"), "Mod-Enter": send("mod-enter"), "Shift-Enter": () => this.editor.commands.setHardBreak() };
	},
});

export function composerExtensions(options: {
	menu: SuggestionMenu;
	placeholder: () => string;
	send: () => void;
	sendWith: () => SendWith;
}) {
	return [
		Document,
		Paragraph,
		Text,
		// Only Shift-Enter: Mod-Enter is a send preference (Send above).
		HardBreak.extend({ addKeyboardShortcuts: () => ({}) }),
		UndoRedo,
		Placeholder.configure({ placeholder: () => options.placeholder() }),
		Token.configure({
			deleteTriggerWithBackspace: true,
			renderText: ({ node }) => chipText(node),
			renderHTML: ({ options: o, node }) => ["span", mergeAttributes(o.HTMLAttributes, { class: "token" }), chipText(node)],
			suggestions: (["@", "#", "/", ":"] as const).map((t) => options.menu.suggestion(t) as Omit<SuggestionOptions, "editor">),
		}),
		EmojiShortcodes,
		Send.configure({ send: options.send, sendWith: options.sendWith, menuOpen: () => options.menu.open }),
	];
}

/** The message as typed: chips back to `@Ada`, line breaks kept. */
export const plainText = (editor: Editor) => editor.getText({ blockSeparator: "\n" }).trim();

/**
 * People and agents named as plain text, like a pasted "@Scout" that never became a chip: a full
 * name after @, then no more of a word. Messages show those as chips, so they mention too.
 */
export function typedMentions(text: string, sources: Pick<Sources, "people" | "agents">): Participant[] {
	const found: Participant[] = [];
	// Longest first, and each match blanked, so "@Sam Lee" is Sam Lee and not also Sam.
	for (const who of [...sources.people, ...sources.agents].filter((p) => p.name).sort((a, b) => b.name.length - a.name.length)) {
		const pattern = new RegExp(`(^|[^\\w])@${who.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?!\\w)`, "g");
		const rest = text.replace(pattern, "$1");
		if (rest !== text) found.push(who);
		text = rest;
	}
	return found;
}

/** The chips in the message, by kind. */
export function tokensIn(editor: Editor): Record<TokenKind, string[]> {
	const ids: Record<TokenKind, string[]> = { user: [], agent: [], channel: [], skill: [] };
	editor.state.doc.descendants((node) => {
		if (node.type.name !== "token") return;
		const list = ids[node.attrs.kind as TokenKind];
		if (!list.includes(node.attrs.id)) list.push(node.attrs.id);
	});
	return ids;
}
