#!/usr/bin/env node
// Cuts a release: checks, deploys the production backend, bumps the app version,
// tags, and pushes. CI (.github/workflows/release.yml) builds and publishes the app.
//
//   pnpm release patch | minor | major | 1.2.3

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const bump = process.argv[2];
const sh = (cmd, opts = {}) => execSync(cmd, { encoding: "utf8", stdio: opts.quiet ? "pipe" : "inherit", ...opts });
const out = (cmd) => sh(cmd, { quiet: true }).trim();
const fail = (msg) => {
	console.error(`\n✗ ${msg}`);
	process.exit(1);
};

if (!bump) fail("Say how to bump: pnpm release patch | minor | major | 1.2.3");

const pkgPath = "src/desktop/package.json";
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const [major, minor, patch] = pkg.version.split(".").map(Number);
const next =
	bump === "major"
		? `${major + 1}.0.0`
		: bump === "minor"
			? `${major}.${minor + 1}.0`
			: bump === "patch"
				? `${major}.${minor}.${patch + 1}`
				: /^\d+\.\d+\.\d+$/.test(bump)
					? bump
					: fail(`"${bump}" isn't patch, minor, major, or a version like 1.2.3.`);

if (out("git branch --show-current") !== "main") fail("Release from main.");
if (out("git status --porcelain")) fail("Commit or stash your changes first.");
sh("git fetch origin main --tags", { quiet: true });
if (out("git rev-parse HEAD") !== out("git rev-parse origin/main")) fail("main isn't in sync with origin. Pull or push first.");
if (out(`git tag -l v${next}`)) fail(`v${next} already exists.`);

console.log(`Releasing Companybot ${pkg.version} → ${next}\n`);
sh("pnpm typecheck");
sh("pnpm test");

// Backend first: the new app may need new functions. Old installs keep working
// because backend changes must stay compatible with the previous app version.
sh("npx convex deploy -y");

pkg.version = next;
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
sh(`git commit -q -m "Release v${next}" ${pkgPath}`);
sh(`git tag v${next}`);
sh("git push -q origin main --follow-tags");

console.log(`\n✓ Tagged v${next}. CI is building it: https://github.com/oobagi/companybot/actions/workflows/release.yml`);
