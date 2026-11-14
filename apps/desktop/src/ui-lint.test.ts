import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// The UI lint's own rules (lint/ui.js), run through Oxlint on small files: what they catch,
// what they let through, and the reviewed escape hatch.
const desktop = join(import.meta.dirname, "..");
const dir = mkdtempSync(join(tmpdir(), "ui-lint-"));
writeFileSync(
	join(dir, ".oxlintrc.json"),
	JSON.stringify({
		jsPlugins: [join(desktop, "lint/ui.js")],
		categories: { correctness: "off" },
		rules: Object.fromEntries(["no-stacked-form", "button-class", "dialog-buttons", "no-native-controls", "no-adhoc-heading", "page-description", "disable-reason"].map((r) => [`ui/${r}`, "error"])),
	}),
);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let n = 0;
function lint(source: string): string[] {
	const file = join(dir, `case${n++}.tsx`);
	writeFileSync(file, source);
	let out = "";
	try {
		out = execFileSync(join(desktop, "node_modules/.bin/oxlint"), ["-c", join(dir, ".oxlintrc.json"), "-f", "json", file], { encoding: "utf8" });
	} catch (e) {
		out = (e as { stdout: string }).stdout;
	}
	return (JSON.parse(out) as { diagnostics: { code: string }[] }).diagnostics.map((d) => d.code.replace(/^ui\((.*)\)$/, "$1")).sort();
}

const header = `import { Field, inputClass, primaryButton, secondaryButton, iconButton, Page } from "./ui";\nimport { Modal, DialogButtons } from "./common";\n`;

describe("UI lint", () => {
	it("reports the old stacked form", () => {
		expect(lint(`${header}export const A = () => <Field label="Name"><input className={inputClass} /></Field>;`)).toEqual(["no-stacked-form", "no-stacked-form"]);
	});

	it("reports text-only and one-off buttons, not shared looks or links in a sentence", () => {
		expect(lint(`${header}export const A = () => <button className="hover:underline">Open</button>;`)).toEqual(["button-class"]);
		expect(lint(`${header}export const A = () => <button className="rounded-md px-2 hover:bg-neutral-100">Open</button>;`)).toEqual(["button-class"]);
		expect(lint(`${header}export const A = () => <button className={iconButton} aria-label="Remove">x</button>;`)).toEqual([]);
		expect(lint(`${header}export const A = () => <p>Read <button className="underline">the guide</button> first.</p>;`)).toEqual([]);
	});

	it("keeps dialog buttons in DialogButtons, placed by it", () => {
		const inside = `<Modal title="New role" onClose={f}><DialogButtons><button className={secondaryButton}>Cancel</button><button className={primaryButton}>Create</button></DialogButtons></Modal>`;
		expect(lint(`${header}const f = () => {};\nexport const A = () => ${inside};`)).toEqual([]);
		expect(lint(`${header}const f = () => {};\nexport const A = () => <Modal title="New role" onClose={f}><button className={\`\${primaryButton} self-end\`}>Create</button></Modal>;`)).toEqual(["button-class", "dialog-buttons"]);
	});

	it("reports native controls and the browser's confirm, not a confirm from useConfirm", () => {
		expect(lint(`${header}export const A = () => <div><select /><input type="checkbox" /></div>;\nexport const b = () => window.confirm("Sure?");`)).toEqual(["no-native-controls", "no-native-controls", "no-native-controls"]);
		expect(lint(`${header}declare const useConfirm: () => (q: string) => void;\nexport function B() { const confirm = useConfirm(); confirm("Sure?"); }`)).toEqual([]);
	});

	it("reports ad-hoc headings and long top-bar descriptions", () => {
		expect(lint(`${header}export const A = () => <div><h3>Members</h3></div>;`)).toEqual(["no-adhoc-heading"]);
		expect(lint(`${header}export const A = () => <Page title="Members" description="Everyone who can sign in to this workspace and what they can do"><h2>People</h2></Page>;`)).toEqual(["no-adhoc-heading", "page-description"]);
		expect(lint(`${header}export const A = () => <Page title="Connectors" description="Outside apps your agents can use">x</Page>;`)).toEqual([]);
	});

	it("takes a reviewed exception only with a reason", () => {
		expect(lint(`${header}export const A = () => (\n\t// eslint-disable-next-line ui/no-adhoc-heading -- an editor's own heading\n\t<h3>Title</h3>\n);`)).toEqual([]);
		expect(lint(`${header}export const A = () => (\n\t// eslint-disable-next-line ui/no-adhoc-heading\n\t<h3>Title</h3>\n);`)).toEqual(["disable-reason"]);
	});
});
