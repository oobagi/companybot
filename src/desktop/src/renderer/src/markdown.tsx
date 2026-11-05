import { withoutFileImages } from "@companybot/core/files";
import { linkedPageId } from "@companybot/core/page-links";
import { code } from "@streamdown/code";
import { type ComponentProps, type MouseEvent, useMemo, useState } from "react";
import { type Components, type LinkSafetyModalProps, defaultComponents, defaultRehypePlugins, Streamdown } from "streamdown";
import { navigate } from "./router";
import { Notice, descriptionClass, primaryButton, secondaryButton, useRun } from "./ui";
import { DialogButtons, Modal } from "./views/chat/common";
import type { TokenNames } from "./views/chat/data";
import { TokenChip } from "./views/chat/TokenChip";
import { TOKEN_TAG, findToken, rehypeTokens } from "./views/chat/tokens";

// How agent replies render. Streamdown handles Markdown, streaming, and code;
// our overrides keep its content and link confirmation in the app's shared UI.

/** Syntax highlighting for code blocks (Shiki, loaded per language on demand). */
const plugins = { code };

/** Keep Streamdown's link checks and opening behavior, using the app's own modal. */
const linkSafety = {
	enabled: true,
	renderModal: (props: LinkSafetyModalProps) => props.isOpen ? <ExternalLinkModal key={props.url} {...props} /> : null,
};

function ExternalLinkModal({ url, onClose, onConfirm }: LinkSafetyModalProps) {
	const [copied, setCopied] = useState(false);
	const { busy, error, run } = useRun();
	return (
		<Modal title="Open external link?" onClose={onClose}>
			<p className={descriptionClass}>This link opens in your browser.</p>
			<p className="max-h-40 overflow-y-auto rounded-xl border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm wrap-anywhere select-text">{url}</p>
			<Notice>{error}</Notice>
			<DialogButtons>
				<button type="button" disabled={busy} onClick={() => void run(navigator.clipboard.writeText(url), () => setCopied(true))} className={secondaryButton}>
					{copied ? "Copied" : "Copy link"}
				</button>
				<button type="button" onClick={onConfirm} className={primaryButton}>Open link</button>
			</DialogButtons>
		</Modal>
	);
}

/** Streamdown's defaults, with the sanitizer also keeping `companybot:` page links (it strips unknown protocols, which then show as "[blocked]"). */
const [sanitize, schema] = defaultRehypePlugins.sanitize as [unknown, { protocols: { href: string[] } }];
const rehypePlugins = Object.values({
	...defaultRehypePlugins,
	sanitize: [sanitize, { ...schema, protocols: { ...schema.protocols, href: [...schema.protocols.href, "companybot"] } }],
}) as ComponentProps<typeof Streamdown>["rehypePlugins"];

/** A screen's address, "#/settings/members" → ["settings", "members"]; undefined for any other link (or a malformed one). */
export function appRoute(href: string) {
	if (!href.startsWith("#/")) return undefined;
	try {
		return href.slice(2).split("/").filter(Boolean).map(decodeURIComponent);
	} catch {
		return undefined;
	}
}

/** Bullets sit outside the text, so wrapped lines align with the first line (hanging indent). */
const components: Components = {
	ul: ({ node: _, className: __, ...props }) => <ul className="list-outside list-disc pl-6 whitespace-normal" {...props} />,
	ol: ({ node: _, className: __, ...props }) => <ol className="list-outside list-decimal pl-6 whitespace-normal" {...props} />,
	/** Items sit close (4px), like lines of one block; blocks are 12px apart (`Markdown`). */
	li: ({ node: _, className: __, ...props }) => <li className="py-0.5 [&>p]:inline" {...props} />,
	/** Page links and screen links (#/settings/members) open here; every other link keeps Streamdown's open-in-browser confirmation. */
	a: (props) => {
		const id = props.href && linkedPageId(props.href);
		const route = props.href && appRoute(props.href);
		if (route?.length) {
			const open = (e: MouseEvent) => { if (e.button > 1) return; e.preventDefault(); navigate(...route); };
			return <a className="wrap-anywhere font-medium text-link hover:underline" href={props.href} onClick={open} onAuxClick={open}>{props.children}</a>;
		}
		if (!id) return <defaultComponents.a {...props} className="text-link no-underline hover:underline" />;
		const open = (e: MouseEvent) => { if (e.button > 1) return; e.preventDefault(); navigate("pages", id); };
		return <a className="page-link" href={props.href} onClick={open} onAuxClick={open}>{props.children}</a>;
	},
};

/**
 * No `allowedTags`: Streamdown only applies it to its own default plugin list. Paragraphs, lists
 * and code are 12px apart. With `tokens` (a chat reply), @names, #channels and /skills are chips.
 */
export function Markdown({ className = "", tokens, children, ...props }: Omit<ComponentProps<typeof Streamdown>, "plugins" | "components" | "rehypePlugins" | "allowedTags"> & { tokens?: TokenNames }) {
	// Keyed on the names, not the object: the directory makes a new one every render.
	const key = tokens && JSON.stringify(tokens);
	const withTokens = useMemo(() => {
		if (!tokens) return { components, rehypePlugins };
		const chip = ({ node }: { node?: { properties?: Record<string, unknown> } }) => {
			const text = String(node?.properties?.dataToken ?? "");
			const token = findToken(text, tokens);
			return token ? <TokenChip token={token} /> : text;
		};
		return { components: { ...components, [TOKEN_TAG]: chip } as Components, rehypePlugins: [...(rehypePlugins ?? []), [rehypeTokens, tokens]] as typeof rehypePlugins };
	}, [key]);
	// Remounted when the names change: Streamdown re-renders only when the text changes, not its plugins.
	return (
		<Streamdown key={key} plugins={plugins} components={withTokens.components} rehypePlugins={withTokens.rehypePlugins} linkSafety={linkSafety} className={`space-y-3 ${className}`} {...props}>
			{typeof children === "string" ? imagesAsLinks(children) : children}
		</Streamdown>
	);
}

/**
 * Images in text never load (the app fetches nothing from outside; pictures come as files), and
 * Streamdown would show "[Image blocked: …]". They read as links instead: ![Logo](url) → [Logo](url).
 * Ones pointed at a chat file id go: the file shows on the message already.
 */
export const imagesAsLinks = (markdown: string) => withoutFileImages(markdown).replace(/!\[([^\]]*)\]\(/g, (_, alt: string) => `[${alt || "Picture"}](`);
