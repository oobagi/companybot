#!/usr/bin/env node
// Lists backward-compat code that can be deleted. Mark such code with a comment:
//
//   // COMPAT(0.1.0-alpha.6): what it keeps working, and what to do when removing it.
//
// The version is the first release that no longer needs it: once that release is out,
// installs update within hours, so the next release can delete the code. `pnpm release`
// prints the ones that are due; `node scripts/compat.mjs` lists them all.

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** -1, 0, or 1. Handles x.y.z and x.y.z-alpha.n / -beta.n (a prerelease sorts before its release). */
export function compareVersions(a, b) {
	const parse = (v) => {
		const [base, pre] = v.replace(/^v/, "").split("-");
		const [channel, n] = pre ? pre.split(".") : ["~", "0"]; // "~" sorts after "alpha"/"beta"
		return [...base.split(".").map(Number), channel, Number(n)];
	};
	const [x, y] = [parse(a), parse(b)];
	for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
	return 0;
}

/** Every COMPAT marker in src/: { version, where, note }. */
export function compatMarkers() {
	let lines = "";
	try {
		lines = execSync(`git grep -n -E "COMPAT\\([^)]+\\)" -- src ':!**/_generated/**'`, { encoding: "utf8" });
	} catch {
		return []; // git grep exits 1 when nothing matches
	}
	return lines
		.trim()
		.split("\n")
		.map((line) => {
			const [file, lineNo, ...rest] = line.split(":");
			const text = rest.join(":");
			const [, version, note] = text.match(/COMPAT\(v?([^)]+)\):?\s*(.*)/) ?? [];
			return { version, where: `${file}:${lineNo}`, note: note.replace(/\*\/\s*$/, "").trim() };
		});
}

/** Markers whose version is already released, given the current app version. */
export const dueMarkers = (currentVersion) => compatMarkers().filter((m) => compareVersions(m.version, currentVersion) <= 0);

if (import.meta.url === `file://${process.argv[1]}`) {
	const current = JSON.parse(readFileSync("src/desktop/package.json", "utf8")).version;
	const markers = compatMarkers();
	if (markers.length === 0) console.log("No COMPAT markers.");
	for (const m of markers) {
		const due = compareVersions(m.version, current) <= 0;
		console.log(`${due ? "DUE " : "wait"}  ${m.version.padEnd(16)} ${m.where}  ${m.note}`);
	}
	console.log(`\nApp version: ${current}. DUE = that release is out, so the next release can delete it.`);
}
