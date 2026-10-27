import type { Role } from "@companybot/core";
import { can } from "@companybot/core/permissions";
import type { FunctionReturnType } from "convex/server";
import { useState } from "react";
import { api } from "../../api";
import { useAction, useMutation, useQuery } from "../../convex";
import { navigate } from "../../router";
import { Loading, Notice, Section, compactControlClass, descriptionClass, inputClass, metadataClass, primaryButton, useRun } from "../../ui";
import { ConnectorActions } from "../Permissions";
import { Card, Detail, Facts, Missing } from "./shared";

type ConnectorItem = FunctionReturnType<typeof api.connectors.list>[number];

export function ConnectorsTab({ role }: { role: Role }) {
	const connectors = useQuery(api.connectors.list);
	const setInstalled = useMutation(api.connectors.setInstalled);
	const { error, run } = useRun();
	if (!connectors) return <Loading />;
	const isOwner = can(role, "connectors.manage");
	const toggle = (p: ConnectorItem) => run(setInstalled({ connectorId: p.id, installed: !p.installed }));

	return (
		<>
			<p className={descriptionClass}>
				Connect outside services like Gmail or Calendar. Agents granted a connector use it for the person they're helping.
			</p>
			{error && <Notice>{error}</Notice>}
			{connectors.length === 0 && <p className={descriptionClass}>No connectors available yet. You can still work with chats, databases, pages, skills, and automations in this workspace.</p>}
			{connectors.map((p) => (
				<Card
					key={p.id}
					title={p.name}
					meta={`${p.publisher} · v${p.version}`}
					description={p.description}
					status={p.installed ? connectorStatus(p) : undefined}
					installed={p.installed}
					canManage={isOwner}
					onToggle={() => toggle(p)}
					onOpen={() => navigate("customize", "connectors", p.id)}
				/>
			))}
		</>
	);
}

function connectorStatus(p: ConnectorItem) {
	if (!p.canUse) return "Your role can't use it";
	if (p.auth.type === "none") return "Ready";
	if (p.error) return "Connection failing";
	return p.connected ? "Connected" : "Not connected";
}

export function ConnectorScreen({ role, id }: { role: Role; id: string }) {
	const connectors = useQuery(api.connectors.list);
	const connector = connectors?.find((p) => p.id === id);
	if (!connector) return <Missing tab="connectors" loaded={!!connectors} />;
	return <ConnectorDetail connector={connector} isOwner={can(role, "connectors.manage")} />;
}

function ConnectorDetail({ connector, isOwner }: { connector: ConnectorItem; isOwner: boolean }) {
	const setInstalled = useMutation(api.connectors.setInstalled);
	const setRoles = useMutation(api.connectors.setRoles);
	const { error, run } = useRun();
	const signIn = { none: "None needed", api_key: "API key", oauth: "Sign in through your browser" }[connector.auth.type];

	return (
		<Detail
			tab="connectors"
			title={connector.name}
			meta={`${connector.publisher} · v${connector.version}`}
			description={connector.description}
			installed={connector.installed}
			canManage={isOwner}
			onToggle={() => run(setInstalled({ connectorId: connector.id, installed: !connector.installed }))}
		>
			{error && <Notice>{error}</Notice>}
			<Facts
				rows={[
					["Account", connector.connection === "personal" ? "Each person connects their own" : "One shared account for the workspace"],
					["Sign-in", signIn],
					["Tools", `Discovered from the connector each turn. Grant "${connector.id}.*" to an agent to use them.`],
					["Asks first", "Anything that changes something, unless you set it to Always below."],
					["Server", connector.server],
				]}
			/>
			{connector.installed && (
				<Section title="Access">
					<label className="flex items-center gap-2 text-sm">
						<span className="text-neutral-500">Who can use it</span>
						<select
							disabled={!isOwner}
							value={connector.roles.includes("member") ? "everyone" : "owners"}
							onChange={(e) =>
								run(setRoles({ connectorId: connector.id, roles: e.target.value === "everyone" ? ["owner", "member"] : ["owner"] }))
							}
							className={compactControlClass}
						>
							<option value="everyone">Everyone</option>
							<option value="owners">Owners only</option>
						</select>
					</label>
					<Connection connector={connector} />
				</Section>
			)}
			{connector.installed && connector.canUse && <ConnectorActions connectorId={connector.id} connected={connector.connected} />}
		</Detail>
	);
}

function Connection({ connector }: { connector: ConnectorItem }) {
	const connect = useAction(api.connectors.connect);
	const startOAuth = useAction(api.connectors.startOAuth);
	const disconnect = useMutation(api.connectors.disconnect);
	const [key, setKey] = useState("");
	const { error, run } = useRun();

	return (
		<div className="flex flex-col gap-2 text-sm">
			{error && <Notice>{error}</Notice>}
			{connector.auth.type === "none" ? (
				<p className="text-emerald-700">Ready. No account needed.</p>
			) : connector.connected ? (
				<div className="flex items-center gap-3">
					<span className={connector.error ? "text-amber-700" : "text-emerald-700"}>
						{connector.error ? `Connected, but the last try failed: ${connector.error}` : "Connected"}
					</span>
					{connector.canConnect && (
						<button
							type="button"
							onClick={() => run(disconnect({ connectorId: connector.id }))}
							className="text-neutral-500 hover:text-red-600"
						>
							Disconnect
						</button>
					)}
				</div>
			) : connector.canUse && connector.canConnect && connector.auth.type === "oauth" ? (
				<div className="flex items-center gap-3">
					<button
						type="button"
						className={`${primaryButton} self-start`}
						// Opens in the browser (main process routes window.open there). The app
						// flips to Connected on its own once the sign-in finishes.
						onClick={() => run(startOAuth({ connectorId: connector.id }).then((url) => window.open(url)))}
					>
						Connect with {connector.name}
					</button>
					<span className="text-neutral-400">Opens your browser to sign in.</span>
				</div>
			) : connector.canUse && connector.canConnect ? (
				<form
					className="flex gap-2"
					onSubmit={(e) => {
						e.preventDefault();
						run(connect({ connectorId: connector.id, credentials: { type: "api_key", key } }), () => setKey(""));
					}}
				>
					<input
						type="password"
						value={key}
						onChange={(e) => setKey(e.target.value)}
						placeholder={connector.auth.type === "api_key" ? connector.auth.label : ""}
						className={`${inputClass} flex-1`}
					/>
					<button type="submit" className={primaryButton}>
						Connect
					</button>
				</form>
			) : (
				<p className="text-neutral-400">{connector.canUse ? "An owner needs to connect it." : "Your role can't use this connector."}</p>
			)}
			{connector.auth.type === "api_key" && connector.auth.help && !connector.connected && (
				<p className={metadataClass}>{connector.auth.help}</p>
			)}
		</div>
	);
}
