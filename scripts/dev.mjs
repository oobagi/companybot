#!/usr/bin/env node
// Runs this checkout against its own local Convex backend, with its own data, then
// starts the desktop app. Safe to run from several worktrees at once: each gets its
// own backend, database, and ports, and none touch the shared cloud dev deployment.
//
//   pnpm dev            set up (first run only), then start backend + app
//   pnpm dev --setup    set up only
//   pnpm dev --reset    wipe this checkout's local data first
//
// First run: installs packages, creates the local deployment (state in .convex/),
// and gives it secrets. The AI Gateway key is copied from the cloud dev deployment
// (or taken from AI_GATEWAY_API_KEY in your shell); sign-in and encryption keys are
// generated fresh, never copied. Without access to the team's Convex project, the
// backend is an anonymous local one (no Convex account needed). Sign in with any
// email: local backends send no email, and the app signs straight in (backend auth.ts).
// The /dev skill (.claude/skills/dev) explains the workflow.

import { execFileSync, spawn } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const PROJECT = "jaden-watson:companybot";
/** Copied from the cloud dev deployment, else from your shell. Everything else is generated per checkout. */
const SHARED_SECRETS = ["AI_GATEWAY_API_KEY"];
const STATE = ".convex/local/default/config.json";

const args = process.argv.slice(2);
const log = (msg) => console.log(`▸ ${msg}`);
const fail = (msg) => {
	console.error(`\n✗ ${msg}`);
	process.exit(1);
};
const convex = (cmdArgs, input) =>
	execFileSync("npx", ["convex", ...cmdArgs], {
		encoding: "utf8",
		input,
		stdio: [input === undefined ? "inherit" : "pipe", "pipe", "pipe"],
	}).trim();

if (!existsSync("pnpm-workspace.yaml")) fail("Run from the repo root.");

if (args.includes("--reset")) {
	log("Wiping this checkout's local data");
	rmSync(".convex", { recursive: true, force: true });
}

if (!existsSync("node_modules")) {
	log("Installing packages");
	execFileSync("pnpm", ["install"], { stdio: "inherit" });
}

// pnpm sometimes skips Electron's download (e.g. a fast install from its store).
const electron = execFileSync("node", ["-p", "require.resolve('electron/package.json')"], { cwd: "src/desktop", encoding: "utf8" })
	.trim()
	.replace(/package\.json$/, "");
if (!existsSync(`${electron}path.txt`)) {
	log("Downloading Electron");
	execFileSync("node", ["install.js"], { cwd: electron, stdio: "inherit" });
}

// 1. A local deployment for this checkout. The CLI moves it to free ports if another
// checkout's backend holds the usual ones.
// Outside the team (no access to PROJECT), it's an anonymous one instead, which needs no login.
const deployment = readEnv().CONVEX_DEPLOYMENT ?? "";
if (!existsSync(STATE) || !/^(local|anonymous):/.test(deployment)) {
	log("Creating a local backend for this checkout");
	try {
		convex(["deployment", "create", `${PROJECT}:local`, "--select"], "");
	} catch {
		log("No access to the team's Convex project, so using an anonymous local backend (no account needed)");
		process.env.CONVEX_AGENT_MODE = "anonymous";
	}
}
const anonymous = process.env.CONVEX_AGENT_MODE === "anonymous" || readEnv().CONVEX_DEPLOYMENT?.startsWith("anonymous:");
// 2. Secrets, once. Setting them needs the backend running, so start it briefly.
// Its own process group, so stopping it also stops the backend binary it starts.
const backend = spawn("npx", ["convex", "dev", "--tail-logs", "disable"], { stdio: ["ignore", "pipe", "pipe"], detached: true });
await waitFor(backend, /Convex functions ready/, "the local backend to start");
const { ports } = JSON.parse(readFileSync(STATE, "utf8"));
// The CLI can leave CONVEX_SITE_URL pointing at the cloud; auth and plugin sign-in need the local one.
writeEnv({ CONVEX_URL: `http://127.0.0.1:${ports.cloud}`, CONVEX_SITE_URL: `http://127.0.0.1:${ports.site}` });
const have = new Set(
	convex(["env", "list"])
		.split("\n")
		.map((l) => l.split("=")[0]),
);
const missing = (name) => !have.has(name);
for (const name of SHARED_SECRETS.filter(missing)) {
	let value = process.env[name];
	let from = "your shell";
	if (!anonymous) {
		try {
			const copied = convex(["env", "get", name, "--deployment", "dev"], "");
			if (copied) [value, from] = [copied, "cloud dev"];
		} catch {}
	}
	if (value) {
		log(`Setting ${name} from ${from}`);
		convex(["env", "set", name], value);
	} else {
		log(`No ${name}, so agents won't reply. Export it and run \`pnpm dev\` again.`);
	}
}
if (missing("JWT_PRIVATE_KEY") || missing("JWKS")) {
	log("Generating sign-in keys");
	const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
	const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
	convex(["env", "set", "JWT_PRIVATE_KEY"], pem.trimEnd().replace(/\n/g, " "));
	convex(["env", "set", "JWKS"], JSON.stringify({ keys: [{ use: "sig", ...publicKey.export({ format: "jwk" }) }] }));
}
if (missing("CONNECTIONS_KEY")) {
	log("Generating a plugin encryption key");
	convex(["env", "set", "CONNECTIONS_KEY"], randomBytes(32).toString("base64"));
}
if (missing("SITE_URL")) convex(["env", "set", "SITE_URL"], "http://localhost");
const stopped = new Promise((r) => backend.once("exit", r));
process.kill(-backend.pid, "SIGINT");
await stopped;

if (args.includes("--setup")) {
	log(`Ready. Backend: http://127.0.0.1:${ports.cloud}. Run \`pnpm dev\` to start.`);
	process.exit(0);
}

// 3. Backend + app together; Ctrl-C stops both.
log(`Starting backend (http://127.0.0.1:${ports.cloud}) and the desktop app. Sign in with any email; no code needed.`);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE; // Set in some terminals (T3 Code); makes Electron run as plain Node.
const dev = spawn("npx", ["convex", "dev", "--start", "pnpm dev:desktop"], { stdio: "inherit", env });
dev.on("exit", (code) => process.exit(code ?? 0));
process.on("SIGINT", () => dev.kill("SIGINT"));

// ---- helpers ----

function readEnv() {
	if (!existsSync(".env.local")) return {};
	return Object.fromEntries(
		readFileSync(".env.local", "utf8")
			.split("\n")
			.filter((l) => /^[A-Z_]+=/.test(l))
			.map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).replace(/\s+#.*$/, "")]),
	);
}

function writeEnv(values) {
	let text = existsSync(".env.local") ? readFileSync(".env.local", "utf8") : "";
	for (const [key, value] of Object.entries(values)) {
		const line = `${key}=${value}`;
		text = new RegExp(`^${key}=.*$`, "m").test(text) ? text.replace(new RegExp(`^${key}=.*$`, "m"), line) : `${text}${line}\n`;
	}
	writeFileSync(".env.local", text);
}

function waitFor(child, pattern, what) {
	return new Promise((resolve, reject) => {
		let output = "";
		const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${what}:\n${output}`)), 120_000);
		const onData = (chunk) => {
			output += chunk;
			if (pattern.test(output)) {
				clearTimeout(timer);
				resolve();
			}
		};
		child.stdout.on("data", onData);
		child.stderr.on("data", onData);
		child.once("exit", (code) => reject(new Error(`Backend exited (${code}) while waiting for ${what}:\n${output}`)));
	}).catch((e) => fail(e.message));
}
