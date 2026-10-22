import { code } from "@streamdown/code";
import type { ComponentProps } from "react";
import { type Components, Streamdown } from "streamdown";

// How agent replies render. Streamdown handles Markdown, streaming, and code;
// these are our only overrides, through its `components` prop.

/** Syntax highlighting for code blocks (Shiki, loaded per language on demand). */
const plugins = { code };

/** Bullets sit outside the text, so wrapped lines align with the first line (hanging indent). */
const components: Components = {
	ul: ({ node: _, className: __, ...props }) => <ul className="list-outside list-disc pl-6 whitespace-normal" {...props} />,
	ol: ({ node: _, className: __, ...props }) => <ol className="list-outside list-decimal pl-6 whitespace-normal" {...props} />,
};

export function Markdown(props: Omit<ComponentProps<typeof Streamdown>, "plugins" | "components">) {
	return <Streamdown plugins={plugins} components={components} {...props} />;
}
