// Companybot's UI rules that @shadcn/lint can't express: it checks classes on components and
// theme tokens, not which elements, imports and layouts a screen uses. The rules live in
// wiki/architecture.md ("Every screen has the same shell"). Each message says what to use instead.
// An exception is a reviewed line comment with a reason:
//   // eslint-disable-next-line ui/button-class -- why this one is different

/** The shared button looks (ui.tsx, views/chat/common.tsx). A raw <button> wears one of these. */
const buttonClasses = new Set([
	"primaryButton",
	"secondaryButton",
	"dangerButton",
	"compactButton",
	"compactPrimaryButton",
	"compactDangerButton",
	"commentPillButton",
	"smallButton",
	"labelButton",
	"toolButton",
	"filterChip",
	"barButton",
	"barDangerButton",
	"barPrimaryButton",
	"iconButton",
	"iconDangerButton",
	"trailingAction",
	"railButton",
	"composerButton",
	"sendButton",
	"actionButton",
	"actionPrimaryButton",
	"heroButton",
	"updateButton",
	"titleBarButton",
	"cornerCloseButton",
	"smallIconButton",
	"quoteToggleButton",
	"bareIconButton",
	"chevronButton",
	"chipRemoveButton",
	"declineButton",
	"answerButton",
	"dialKeyButton",
	"dialDeleteButton",
	"placeCallButton",
	"hangUpButton",
	"callBarButton",
	"callBarHangUpButton",
	"phoneToolButton",
	"phoneCallerButton",
	"callBarNameButton",
	"roundCallButton",
	"callRowButton",
	"playerButton",
	"callTabButton",
	"timeRemoveButton",
	"tabCloseButton",
	"tabAddButton",
	"suggestionButton",
	"membersButton",
	"repliesButton",
	"pillLinkButton",
	"stopButton",
	"pillButton",
	"dayButton",
	"emojiTabButton",
	"skinToneButton",
	"boardCardButton",
	"versionRowButton",
	"cardButton",
	"choiceCardButton",
	"linkButton",
	"recordTagButton",
	"titleButton",
	"rowButton",
	"listRowButton",
	"tileButton",
	"pickedTileButton",
	"swatchButton",
	"imageButton",
	"chipButton",
	"surfaceButton",
]);

/** Dialog-sized buttons: they belong in a dialog's `DialogButtons`, bottom right. */
const dialogButtons = new Set(["primaryButton", "secondaryButton", "dangerButton"]);

const elementName = (node) => (node.name.type === "JSXIdentifier" ? node.name.name : node.name.type === "JSXMemberExpression" ? node.name.property.name : "");

const attribute = (opening, name) => opening.attributes.find((a) => a.type === "JSXAttribute" && a.name.name === name);

/** Identifiers and string pieces anywhere in an attribute's value. */
function parts(value) {
	const names = new Set();
	const strings = [];
	const walk = (node) => {
		if (!node || typeof node.type !== "string") return;
		if (node.type === "Identifier") names.add(node.name);
		else if (node.type === "Literal" && typeof node.value === "string") strings.push(node.value);
		else if (node.type === "TemplateElement") strings.push(node.value.cooked ?? node.value.raw);
		for (const key of Object.keys(node)) {
			if (key === "parent" || key === "loc" || key === "range") continue;
			const child = node[key];
			if (Array.isArray(child)) child.forEach(walk);
			else if (child && typeof child === "object") walk(child);
		}
	};
	walk(value);
	return { names, classes: strings.join(" ").split(/\s+/).filter(Boolean) };
}

/** The nearest JSX element above `node` named one of `names`, stopping at a function boundary. */
function jsxAncestor(node, names) {
	for (let n = node.parent; n; n = n.parent) {
		if (n.type === "JSXElement" && names.has(elementName(n.openingElement))) return n;
		if (n.type === "FunctionDeclaration" || n.type === "FunctionExpression" || n.type === "ArrowFunctionExpression") {
			// A render callback inside the same JSX (`menu={(close) => …}`, `.map(...)`) still counts.
			if (!n.parent || !/^JSX|CallExpression$/.test(n.parent.type)) return null;
		}
	}
	return null;
}

/** Whether `name` at `node` is the browser's global, not a local (`const confirm = useConfirm()`). */
function isGlobal(context, node, name) {
	for (let scope = context.sourceCode.getScope(node); scope; scope = scope.upper) {
		const variable = scope.set?.get(name);
		if (variable && variable.defs.length > 0) return false;
	}
	return true;
}

/** Whether `name` at `node` is an import: a named look shared from another file. */
function isImported(context, node, name) {
	for (let scope = context.sourceCode.getScope(node); scope; scope = scope.upper) {
		const variable = scope.set?.get(name);
		if (variable) return variable.defs.some((d) => d.type === "ImportBinding");
	}
	return false;
}

/** The initializer of a same-file `const` named `name` at `node` (one hop), if any. */
function initializer(context, node, name) {
	for (let scope = context.sourceCode.getScope(node); scope; scope = scope.upper) {
		const variable = scope.set?.get(name);
		if (variable) return variable.defs.find((d) => d.type === "Variable")?.node.init ?? null;
	}
	return null;
}

/** A button inside a line of text (a link in a sentence): its element has words beside it. */
const inSentence = (element) => element.parent?.type === "JSXElement" && element.parent.children.some((c) => c.type === "JSXText" && c.value.trim() !== "");

const rule = (description, messages, create) => ({ meta: { type: "suggestion", docs: { description }, messages, schema: [] }, create });

const rules = {
	"no-stacked-form": rule(
		"`Field` and `inputClass` are the old hand-made form: forms are `Settings`/`Setting`, which stack by themselves in dialogs.",
		{
			field: "`Field` is the old hand-made form. Put each input in a `Setting` inside `Settings`: a row in a card, the same on a screen and in a dialog (`wide` puts a long control under its label); sign-in and onboarding ask with `Question`. Dialogs keep `DialogButtons`; screens keep `SaveBar`.",
			input: "`inputClass` is the old big input. Use `wideControlClass` (or `compactControlClass`) in a `Setting` row; a textarea in a `Setting wide` row takes `compactControlClass w-full`.",
		},
		(context) => ({
			JSXOpeningElement(node) {
				if (elementName(node) === "Field") context.report({ node, messageId: "field" });
			},
			Identifier(node) {
				if (node.name !== "inputClass") return;
				// Only the reference or definition itself, not an import specifier's local copy.
				if (node.parent.type === "ImportSpecifier" || node.parent.type === "ExportSpecifier") return;
				if (node.parent.type === "MemberExpression" && node.parent.property === node && !node.parent.computed) return;
				context.report({ node, messageId: "input" });
			},
			FunctionDeclaration(node) {
				if (node.id?.name === "Field") context.report({ node: node.id, messageId: "field" });
			},
		}),
	),

	"button-class": rule(
		"A raw <button> wears a shared button look, so text-only and one-off buttons can't sneak in.",
		{
			text: "Text-only button. No text-only buttons: use `iconButton` (an icon, with an aria-label and title) or a bordered button (`compactButton`, `smallButton`); a row's several actions go in its ⋯ menu (`MoreMenu`). Plain links only inside sentences.",
			oneOff:
				"One-off button look. Use a shared class (`iconButton`, `compactButton`, `smallButton`, `barButton`, `primaryButton`/`secondaryButton` in `DialogButtons`) or a primitive (`NewButton`, `IconButton`, `MenuItem`, `MoreMenu`, `Toggle`). Clickable text: `linkButton` (opens what it names) or `titleButton` (folds, sorts). Rows: `rowButton`, `listRowButton`. If it's a new kind, add a named class to ui.tsx and import it.",
			placed: "`{{cls}}` places this button by hand. Dialog buttons go in `DialogButtons` (bottom right); screen actions go in the top bar (`SaveBar`, `PageActions`).",
		},
		(context) => ({
			JSXOpeningElement(node) {
				const isButton = elementName(node) === "button";
				const { names, classes } = parts(attribute(node, "className")?.value);
				// Only the named shared looks count: importing a helper like `disabledButtonClass` doesn't make a look shared.
				const shared = [...names].some((n) => buttonClasses.has(n));
				if (isButton || [...names].some((n) => buttonClasses.has(n))) {
					const placed = classes.find((c) => /^(\w+:)*self-(start|end)$/.test(c));
					if (placed) context.report({ node, messageId: "placed", data: { cls: placed } });
				}
				if (!isButton || shared || inSentence(node.parent)) return;
				// A same-file named look (`const tab = "…"`) counts by its classes; it isn't shared, so it's still one-off.
				for (const name of names) classes.push(...parts(initializer(context, node, name)).classes);
				const boxed = classes.some((c) => /^(\w+:)*(rounded|bg-|border|size-|p[xytrbl]?-|h-)/.test(c));
				context.report({ node, messageId: boxed ? "oneOff" : "text" });
			},
		}),
	),

	"dialog-buttons": rule(
		"Dialog-sized buttons sit in `DialogButtons` at the bottom right of a dialog.",
		{
			outside:
				"`{{cls}}` is a dialog button: put it in `DialogButtons` (Cancel, then the action) at the bottom of the `Modal`. On a screen, use the top bar instead (`SaveBar`, `PageActions` with `barButton`/`compactButton`).",
		},
		(context) => ({
			JSXOpeningElement(node) {
				const { names } = parts(attribute(node, "className")?.value);
				const cls = [...names].find((n) => dialogButtons.has(n));
				if (!cls) return;
				if (!jsxAncestor(node.parent, new Set(["DialogButtons"]))) context.report({ node, messageId: "outside", data: { cls } });
			},
		}),
	),

	"no-native-controls": rule(
		"Native selects, checkboxes, radios and browser dialogs have app versions.",
		{
			select: "Use `Select` (or `Segmented` for a few side-by-side choices) from controls.tsx, never a native <select>.",
			checkbox: "Use `Checkbox` from controls.tsx, never the native checkbox.",
			radio: "Use `Segmented` or `Select` from controls.tsx, never native radios.",
			dialog: "Never the browser's `{{name}}()`: destructive actions ask with `useConfirm` (a red `Confirm`); errors show in a `Notice`.",
		},
		(context) => ({
			JSXOpeningElement(node) {
				const name = elementName(node);
				if (name === "select") context.report({ node, messageId: "select" });
				if (name !== "input") return;
				const type = attribute(node, "type")?.value;
				if (type?.type === "Literal" && type.value === "checkbox") context.report({ node, messageId: "checkbox" });
				if (type?.type === "Literal" && type.value === "radio") context.report({ node, messageId: "radio" });
			},
			CallExpression(node) {
				const callee = node.callee;
				const browserDialog = new Set(["confirm", "alert", "prompt"]);
				if (callee.type === "Identifier" && browserDialog.has(callee.name) && isGlobal(context, node, callee.name))
					context.report({ node, messageId: "dialog", data: { name: callee.name } });
				if (
					callee.type === "MemberExpression" &&
					callee.object.type === "Identifier" &&
					(callee.object.name === "window" || callee.object.name === "globalThis") &&
					browserDialog.has(callee.property.name)
				)
					context.report({ node, messageId: "dialog", data: { name: callee.property.name } });
			},
		}),
	),

	"no-adhoc-heading": rule(
		"Headings come from the primitives: `Page`'s title and `heading`, `Section`/`Settings` titles, `Modal`'s title, `EmptyState`.",
		{
			heading:
				"<{{tag}}> is an ad-hoc heading. Headings come from the primitives: use a `Section` or `Settings` title (a title only, no paragraph), `Page`'s `heading` for things you write in, or `EmptyState`.",
		},
		(context) => ({
			JSXOpeningElement(node) {
				const tag = elementName(node);
				if (!/^h[1-6]$/.test(tag)) return;
				// h1/h2 also make the app's chrome (a sidebar's name, a thread's title); inside a screen or dialog they're ad hoc.
				if (/^h[12]$/.test(tag) && !jsxAncestor(node.parent, new Set(["Page", "Modal", "Section", "Settings"]))) return;
				context.report({ node, messageId: "heading", data: { tag } });
			},
		}),
	),

	"page-description": rule(
		"A screen's top-bar description is a few words; details belong in help.",
		{
			long: "This description is {{length}} characters. Keep `description` to a few words (40 at most, like \"Outside apps your agents can use\"); the details belong in help.",
		},
		(context) => ({
			JSXOpeningElement(node) {
				if (!["Page", "TopBar"].includes(elementName(node))) return;
				const value = attribute(node, "description")?.value;
				if (!value) return;
				const text = value.type === "Literal" ? value.value : value.expression?.type === "Literal" ? value.expression.value : value.expression?.type === "TemplateLiteral" ? value.expression.quasis.map((q) => q.value.cooked).join("…") : null;
				if (typeof text === "string" && text.length > 40) context.report({ node: value, messageId: "long", data: { length: String(text.length) } });
			},
		}),
	),

	"disable-reason": rule(
		"A lint exception says why, so it can be reviewed.",
		{ reason: "Say why after ` -- `: `// eslint-disable-next-line ui/button-class -- reason`." },
		(context) => ({
			Program() {
				for (const comment of context.sourceCode.getAllComments()) {
					const text = comment.value.trim();
					if (/^(eslint|oxlint)-disable/.test(text) && !/\s--\s+\S/.test(text)) context.report({ loc: comment.loc, messageId: "reason" });
				}
			},
		}),
	),
};

export default { meta: { name: "ui" }, rules };
