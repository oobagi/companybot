import { linkedPageId } from "@companybot/core/page-links";
import { code } from "@streamdown/code";
import type { ComponentProps, MouseEvent } from "react";
import { type Components, defaultComponents, defaultRehypePlugins, Streamdown } from "streamdown";
import { navigate } from "./router";

// How agent replies render. Streamdown handles Markdown, streaming, and code;
// these are our only overrides, through its `components` and `rehypePlugins` props.

/** Syntax highlighting for code blocks (Shiki, loaded per language on demand). */
const plugins = { code };

/** Streamdown's defaults, with the sanitizer also keeping `companybot:` page links (it strips unknown protocols, which then show as "[blocked]"). */
const [sanitize, schema] = defaultRehypePlugins.sanitize as [unknown, { protocols: { href: string[] } }];
const rehypePlugins = Object.values({
	...defaultRehypePlugins,
	sanitize: [sanitize, { ...schema, protocols: { ...schema.protocols, href: [...schema.protocols.href, "companybot"] } }],
}) as ComponentProps<typeof Streamdown>["rehypePlugins"];

/** A screen's address, "#/settings/members" → ["settings", "members"]; undefined for any other link. */
export const appRoute = (href: string) => (href.startsWith("#/") ? href.slice(2).split("/").filter(Boolean).map(decodeURIComponent) : undefined);

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
			return <a className="wrap-anywhere font-medium text-primary underline" href={props.href} onClick={open} onAuxClick={open}>{props.children}</a>;
		}
		if (!id) return <defaultComponents.a {...props} />;
		const open = (e: MouseEvent) => { if (e.button > 1) return; e.preventDefault(); navigate("pages", id); };
		return <a className="page-link" href={props.href} onClick={open} onAuxClick={open}>{props.children}</a>;
	},
};

/**
 * No `allowedTags`: Streamdown only applies it to its own default plugin list. Paragraphs, lists
 * and code are 12px apart.
 */
export function Markdown({ className = "", ...props }: Omit<ComponentProps<typeof Streamdown>, "plugins" | "components" | "rehypePlugins" | "allowedTags">) {
	return <Streamdown plugins={plugins} components={components} rehypePlugins={rehypePlugins} className={`space-y-3 ${className}`} {...props} />;
}
