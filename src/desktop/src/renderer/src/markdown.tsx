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

/** Bullets sit outside the text, so wrapped lines align with the first line (hanging indent). */
const components: Components = {
	ul: ({ node: _, className: __, ...props }) => <ul className="list-outside list-disc pl-6 whitespace-normal" {...props} />,
	ol: ({ node: _, className: __, ...props }) => <ol className="list-outside list-decimal pl-6 whitespace-normal" {...props} />,
	/** Page links open the page here; every other link keeps Streamdown's open-in-browser confirmation. */
	a: (props) => {
		const id = props.href && linkedPageId(props.href);
		if (!id) return <defaultComponents.a {...props} />;
		const open = (e: MouseEvent) => { e.preventDefault(); navigate("pages", id); };
		return <a className="page-link" href={props.href} onClick={open} onAuxClick={open}>{props.children}</a>;
	},
};

export function Markdown(props: Omit<ComponentProps<typeof Streamdown>, "plugins" | "components" | "rehypePlugins">) {
	return <Streamdown plugins={plugins} components={components} rehypePlugins={rehypePlugins} {...props} />;
}
