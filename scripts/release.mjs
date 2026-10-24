#!/usr/bin/env node
// Cuts a release: checks, snapshots prod, deploys the production backend, runs pending
// migrations, bumps the app version, tags, and pushes. CI (.github/workflows/release.yml) builds and publishes the app.
//
//   pnpm release patch | minor | major | alpha | beta | 1.2.3 | 1.2.3-alpha.1
//
// alpha/beta: the next prerelease (0.2.0-alpha.1 → 0.2.0-alpha.2, → 0.2.0-beta.1),
// or from a stable version, the first one for the next patch. Prereleases are marked as such on GitHub; only installs
// already on a prerelease update to them.
//
//   --notes <file>  Release notes (Markdown). Committed as release-notes/v<version>.md;
//                   the release build shows them above the automatic PR list.
//   --next          Print the version this bump would make, then stop.
//
// The /release skill (.claude/skills/release) drives this end to end.

import { execSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dueMarkers } from "./compat.mjs";

const args = process.argv.slice(2);
const bump = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--notes");
const notesFile = args.includes("--notes") ? args[args.indexOf("--notes") + 1] : undefined;
const printNext = args.includes("--next");
const sh = (cmd, opts = {}) => execSync(cmd, { encoding: "utf8", stdio: opts.quiet ? "pipe" : "inherit", ...opts });
const out = (cmd) => sh(cmd, { quiet: true }).trim();
const fail = (msg) => {
	console.error(`\n✗ ${msg}`);
	process.exit(1);
};

if (!bump) fail("Say how to bump: pnpm release patch | minor | major | alpha | beta | 1.2.3");

const pkgPath = "src/desktop/package.json";
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const [base, pre] = pkg.version.split("-");
const [major, minor, patch] = base.split(".").map(Number);
const [channel, number] = pre ? [pre.split(".")[0], Number(pre.split(".")[1])] : [];
const next =
	bump === "major"
		? `${major + 1}.0.0`
		: bump === "minor"
			? `${major}.${minor + 1}.0`
			: bump === "patch"
				? // From a prerelease, "patch" ships that version for real.
					pre
					? base
					: `${major}.${minor}.${patch + 1}`
				: bump === "alpha" || bump === "beta"
					? channel === bump
						? `${base}-${bump}.${number + 1}`
						: // alpha → beta stays on the same version; from stable, start the next patch.
							pre
							? `${base}-${bump}.1`
							: `${major}.${minor}.${patch + 1}-${bump}.1`
					: /^\d+\.\d+\.\d+(-(alpha|beta)\.\d+)?$/.test(bump)
						? bump
						: fail(`"${bump}" isn't patch, minor, major, alpha, beta, or a version like 1.2.3.`);

if (printNext) {
	console.log(next);
	process.exit(0);
}
if (notesFile && !existsSync(notesFile)) fail(`No notes file at ${notesFile}.`);
if (notesFile && !readFileSync(notesFile, "utf8").trim()) fail("The notes file is empty.");

if (out("git branch --show-current") !== "main") fail("Release from main.");
if (out("git status --porcelain")) fail("Commit or stash your changes first.");
sh("git fetch origin main --tags", { quiet: true });
if (out("git rev-parse HEAD") !== out("git rev-parse origin/main")) fail("main isn't in sync with origin. Pull or push first.");
if (out(`git tag -l v${next}`)) fail(`v${next} already exists.`);

console.log(`Releasing Companybot ${pkg.version} → ${next}\n`);
const due = dueMarkers(pkg.version);
if (due.length > 0) {
	console.log("Backward-compat code that installs no longer need (delete it in a follow-up PR):");
	for (const m of due) console.log(`  ${m.where}  ${m.note}`);
	console.log();
}
sh("pnpm typecheck");
sh("pnpm test");

// Snapshot prod first, so a bad deploy or migration can be undone with
// `npx convex import --prod --replace-all <file>`. Kept locally in backups/ (gitignored).
mkdirSync("backups", { recursive: true });
const snapshot = `backups/prod-before-v${next}-${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.zip`;
sh(`npx convex export --prod --path ${snapshot}`);

// Backend first: the new app may need new functions. Old installs keep working
// because backend changes must stay compatible with the previous app version.
// Codegen is off so the deploy uses the committed convex/_generated as-is.
sh("npx convex deploy -y --codegen disable");

// Then data: every pending migration (convex/migrations.ts), waiting until they finish.
sh("npx convex run migrations:runAll --prod", { quiet: true });
for (let i = 0; ; i++) {
	const statuses = JSON.parse(out("npx convex run migrations:status --prod"));
	const failed = statuses.filter((m) => m.state === "failed" || m.state === "canceled");
	if (failed.length > 0) {
		fail(`Migration failed: ${failed.map((m) => `${m.name}: ${m.error ?? m.state}`).join("; ")}. Nothing was tagged. Fix it, or restore ${snapshot}.`);
	}
	if (!statuses.some((m) => m.state === "inProgress")) break;
	if (i >= 60) fail("Migrations still running after 10 minutes. Check the Convex dashboard, then rerun.");
	execSync("sleep 10");
}

pkg.version = next;
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
const committed = [pkgPath];
if (notesFile) {
	mkdirSync("release-notes", { recursive: true });
	copyFileSync(notesFile, `release-notes/v${next}.md`);
	committed.push(`release-notes/v${next}.md`);
}
sh(`git add ${committed.join(" ")}`);
sh(`git commit -q -m "Release v${next}"`);
// Annotated, so `--follow-tags` pushes it (it skips lightweight tags).
sh(`git tag -a v${next} -m "Release v${next}"`);
sh("git push -q origin main --follow-tags");

console.log(`\n✓ Tagged v${next}. CI is building it: https://github.com/oobagi/companybot/actions/workflows/release.yml`);
