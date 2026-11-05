import { Checkbox, Segmented, Select } from "../../controls";
import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import { CUSTOM_CONNECTOR_DESCRIPTION_MAX, CUSTOM_CONNECTOR_NAME_MAX, type CustomConnectorInput } from "@companybot/core/connectors";
import { type Access, can } from "@companybot/core/permissions";
import type { FunctionReturnType } from "convex/server";
import { useState } from "react";
import { api } from "../../api";
import { useAction, useMutation, useQuery } from "../../convex";
import { navigate } from "../../router";
import { ConnectorIcon } from "../../icons";
import { EmptyState, Field, Form, Loading, Notice, Page, Section, barButton, barDangerButton, compactButton, compactPrimaryButton, inputClass, metadataClass, primaryButton, secondaryButton, useDraft, useRun } from "../../ui";
import { ConnectorActions } from "../Permissions";
import { Card, Detail, Facts, Missing, customizeCrumbs } from "./shared";

import { Modal, useConfirm } from "../chat/common";

type ConnectorItem = FunctionReturnType<typeof api.connectors.list>[number];

export function ConnectorsTab({ access }: { access: Access }) {
	const connectors = useQuery(api.connectors.list);
	const setInstalled = useMutation(api.connectors.setInstalled);
	const { confirm, dialog } = useConfirm();
	const { error, run } = useRun();
	if (!connectors) return <Loading />;
	const canManage = can(access, "connectors.manage");
	const toggle = (p: ConnectorItem) => p.installed ? confirm({ title: `Remove ${p.name}?`, action: "Remove connector", body: "This disconnects it for everyone and deletes its saved connections and permissions. Reinstalling will require connecting it again.", onConfirm: () => setInstalled({ connectorId: p.id, installed: false }) }) : run(setInstalled({ connectorId: p.id, installed: true }));

	return (
		<>
			{dialog}
			<Notice>{error}</Notice>
			{connectors.length === 0 && (
				<EmptyState icon={<ConnectorIcon />} title="No connectors yet">
					{canManage ? "Add an outside service’s MCP server with New connector." : "Someone whose role can install connectors can add one."}
				</EmptyState>
			)}
			{connectors.map((p) => (
				<Card
					key={p.id}
					title={p.name}
					meta={metaOf(p)}
					description={p.description}
					status={p.installed ? connectorStatus(p) : undefined}
					install={{ installed: p.installed, canManage: canManage, onToggle: () => toggle(p) }}
					onOpen={() => navigate("settings", "connectors", p.id)}
				/>
			))}
		</>
	);
}

/** Who made it: the catalog's publisher and version, or "Custom" for your workspace's own. */
const metaOf = (p: ConnectorItem) => (p.custom ? "Custom" : `${p.publisher} · v${p.version}`);

function connectorStatus(p: ConnectorItem) {
	if (!p.canUse) return "None of your roles can use it";
	if (p.auth.type === "none") return "Ready";
	if (p.error) return "Connection failing";
	return p.connected ? "Connected" : "Not connected";
}

export function ConnectorScreen({ access, id }: { access: Access; id: string }) {
	const connectors = useQuery(api.connectors.list);
	const [editing, setEditing] = useState(false);
	const canManage = can(access, "connectors.manage");
	if (id === "new" && canManage) return <NewConnector />;
	const connector = connectors?.find((p) => p.id === id);
	if (!connector) return <Missing tab="connectors" loaded={!!connectors} />;
	if (editing && connector.custom && canManage) return <EditConnector connector={connector} onDone={() => setEditing(false)} />;
	return <ConnectorDetail connector={connector} canManage={canManage} onEdit={() => setEditing(true)} />;
}

function ConnectorDetail({ connector, canManage, onEdit }: { connector: ConnectorItem; canManage: boolean; onEdit: () => void }) {
	const setInstalled = useMutation(api.connectors.setInstalled);
	const remove = useMutation(api.customConnectors.remove);
	const { confirm, dialog } = useConfirm();
	const setRoles = useMutation(api.connectors.setRoles);
	const { error, run } = useRun();
	const signIn = { none: "None needed", api_key: "API key", oauth: "Sign in through your browser" }[connector.auth.type];
	// Your workspace's own: Edit and Remove (which uninstalls it too) in place of Install.
	const customActions = connector.custom && canManage && (
		<>
			<button type="button" className={barButton} onClick={onEdit}>Edit</button>
			<button
				type="button"
				className={barDangerButton}
				onClick={() => confirm({ title: `Remove ${connector.name}?`, action: "Remove connector", body: "This disconnects it for everyone and deletes it, with its saved connections and permissions. Agents granted it lose its tools.", onConfirm: () => remove({ connectorId: connector.id }).then(() => navigate("settings", "connectors")) })}
			>
				Remove
			</button>
		</>
	);

	return (
		<Detail
			tab="connectors"
			title={connector.name}
			meta={metaOf(connector)}
			description={connector.description}
			installed={connector.installed}
			canManage={canManage}
			actions={customActions || undefined}
			onToggle={() => connector.installed ? confirm({ title: `Remove ${connector.name}?`, action: "Remove connector", body: "This disconnects it for everyone and deletes its saved connections and permissions. Reinstalling will require connecting it again.", onConfirm: () => setInstalled({ connectorId: connector.id, installed: false }) }) : run(setInstalled({ connectorId: connector.id, installed: true }))}
		>
			{dialog}
			<Notice>{error}</Notice>
			<Facts
				rows={[
					["Account", connector.connection === "personal" ? "Each person connects their own" : "One shared account for the workspace"],
					["Sign-in", signIn],
					["Tools", `Discovered from the connector each turn. Grant "${connector.id}.*" to an agent to use them.`],
					["Asks first", "Anything that changes something, unless you set it to Always below."],
					["Server", connector.custom ? `${connector.server} (${connector.transport === "sse" ? "SSE" : "Streamable HTTP"})` : connector.server],
				]}
			/>
			{connector.custom && !connector.installed && canManage && <button type="button" className={`${primaryButton} self-start`} onClick={() => run(setInstalled({ connectorId: connector.id, installed: true }))}>Install</button>}
			{connector.installed && (
				<Section title="Access" flush>
					<ConnectorRoles connector={connector} canManage={canManage} onChange={(roles) => run(setRoles({ connectorId: connector.id, roles }))} />
					<Connection connector={connector} />
				</Section>
			)}
			{connector.installed && connector.canUse && <ConnectorActions connectorId={connector.id} connected={connector.connected} />}
		</Detail>
	);
}

/** Which roles may use the connector. Owners always can, so Owner shows checked and fixed. */
function ConnectorRoles({ connector, canManage, onChange }: { connector: ConnectorItem; canManage: boolean; onChange: (roles: Id<"roles">[]) => void }) {
	const roles = useQuery(api.roles.list);
	if (!roles) return null;
	const allowed = connector.roleIds as Id<"roles">[];
	return (
		<div role="group" aria-label="Who can use it" className="flex flex-col gap-1.5 text-sm">
			<span className="text-neutral-500">Who can use it</span>
			<div className="flex flex-wrap gap-x-4 gap-y-1.5">
				{roles.map((r) => {
					const owner = r.builtIn === "owner";
					const on = owner || allowed.includes(r.id);
					return (
						<label key={r.id} className="flex items-center gap-2 has-disabled:text-neutral-400">
							<Checkbox checked={on} disabled={!canManage || owner} onChange={(checked) => onChange(checked ? [...allowed, r.id] : allowed.filter((id) => id !== r.id))} />
							{r.name}
						</label>
					);
				})}
			</div>
		</div>
	);
}

function Connection({ connector }: { connector: ConnectorItem }) {
	const startOAuth = useAction(api.connectors.startOAuth);
	const disconnect = useMutation(api.connectors.disconnect);
	const { confirm, dialog } = useConfirm();
	const [pasting, setPasting] = useState(false);
	const { error, run } = useRun();

	return (
		<div className="flex flex-col gap-2 text-sm">
			{dialog}
			<Notice>{error}</Notice>
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
							onClick={() => confirm({ title: `Disconnect ${connector.name}?`, action: "Disconnect", body: "This deletes the saved connection. You will need to connect again before agents can use it.", onConfirm: () => disconnect({ connectorId: connector.id }) })}
							className={compactButton}
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
			) : connector.canUse && connector.canConnect && connector.auth.type === "api_key" ? (
				<>
					<button type="button" className={`${primaryButton} self-start`} onClick={() => setPasting(true)}>
						Connect
					</button>
					{pasting && <ConnectKeyDialog connector={connector} auth={connector.auth} onClose={() => setPasting(false)} />}
				</>
			) : (
				<p className="text-neutral-400">{connector.canUse ? "An owner needs to connect it." : "None of your roles can use this connector."}</p>
			)}
		</div>
	);
}

/** Pasting an API key: the key's field in a dialog, with Cancel and Connect. */
function ConnectKeyDialog({ connector, auth, onClose }: { connector: ConnectorItem; auth: Extract<ConnectorItem["auth"], { type: "api_key" }>; onClose: () => void }) {
	const connect = useAction(api.connectors.connect);
	const [key, setKey] = useState("");
	const { error, busy, run } = useRun();
	return (
		<Modal title={`Connect ${connector.name}`} onClose={onClose}>
			<Form onSubmit={() => run(connect({ connectorId: connector.id, credentials: { type: "api_key", key } }), onClose)}>
				<Notice>{error}</Notice>
				<Field label={auth.label} hint={auth.help ?? "Stored encrypted. Agents use it only for people whose roles can use this connector."}>
					<input autoFocus type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} className={inputClass} />
				</Field>
				<div className="flex justify-end gap-2">
					<button type="button" className={secondaryButton} onClick={onClose}>Cancel</button>
					<button type="submit" disabled={busy || !key.trim()} className={primaryButton}>Connect</button>
				</div>
			</Form>
		</Modal>
	);
}

type ConnectorForm = CustomConnectorInput;

const emptyForm: ConnectorForm = { name: "", description: "", url: "", transport: "http", connection: "workspace", auth: { type: "none" } };
const apiKeyDefaults = { type: "api_key" as const, header: "Authorization", prefix: "Bearer ", label: "API key" };

/** A custom connector as its form shows it. */
const formOf = (c: ConnectorItem): ConnectorForm => ({
	name: c.name,
	description: c.description,
	url: c.server,
	transport: c.transport,
	connection: c.connection,
	auth: c.auth.type === "api_key" ? { type: "api_key", header: c.auth.header, prefix: c.auth.prefix ?? "", label: c.auth.label } : { type: c.auth.type },
});

/** What changes where agents connect: saving a change here starts the connector strict (customConnectors.update). */
const serverOf = (f: ConnectorForm) => JSON.stringify([f.url.trim(), f.transport, f.connection, f.auth.type, f.auth.type === "api_key" ? [f.auth.header.trim(), f.auth.prefix ?? ""] : null]);

/** Name, server, transport, whose account, and how it signs in: what someone adding an MCP server fills in. */
function ConnectorFields({ value, onChange }: { value: ConnectorForm; onChange: (value: ConnectorForm) => void }) {
	const auth = value.auth;
	const setKey = (patch: Partial<typeof apiKeyDefaults>) => auth.type === "api_key" && onChange({ ...value, auth: { ...auth, ...patch } });
	return (
		<>
			<Field label="Name" hint="What people and agents see, like “Linear” or “Support desk”.">
				<input className={inputClass} value={value.name} maxLength={CUSTOM_CONNECTOR_NAME_MAX} placeholder="e.g. Support desk" onChange={(e) => onChange({ ...value, name: e.target.value })} />
			</Field>
			<Field label="Description" hint="Optional. What it’s for; agents see it when it’s connected.">
				<input className={inputClass} value={value.description} maxLength={CUSTOM_CONNECTOR_DESCRIPTION_MAX} placeholder="e.g. Tickets and customer conversations" onChange={(e) => onChange({ ...value, description: e.target.value })} />
			</Field>
			<Field label="Server URL" hint="The MCP server’s address. It must be https and on the public internet.">
				<input className={inputClass} value={value.url} inputMode="url" spellCheck={false} placeholder="https://example.com/mcp" onChange={(e) => onChange({ ...value, url: e.target.value })} />
			</Field>
			<div className="flex flex-col gap-1.5">
				<span className="text-sm font-medium">Transport</span>
				<Segmented label="Transport" value={value.transport} onChange={(transport) => onChange({ ...value, transport })} options={[{ value: "http", label: "Streamable HTTP" }, { value: "sse", label: "SSE" }]} />
				<span className="text-xs text-neutral-500">Most servers use Streamable HTTP. Pick SSE only if the server’s docs say so.</span>
			</div>
			<div className="flex flex-col gap-1.5">
				<span className="text-sm font-medium">Account</span>
				<Segmented label="Account" value={value.connection} onChange={(connection) => onChange({ ...value, connection })} options={[{ value: "workspace", label: "One shared account" }, { value: "personal", label: "Each person’s own" }]} />
				<span className="text-xs text-neutral-500">{value.connection === "workspace" ? "Someone who can install connectors connects it once for everyone." : "Everyone connects their own; agents use the account of the person they’re helping."}</span>
			</div>
			<Field label="Sign-in">
				<Select
					label="Sign-in"
					className={inputClass}
					value={auth.type}
					options={[{ value: "none", label: "None" }, { value: "api_key", label: "API key" }, { value: "oauth", label: "OAuth (sign in through the browser)" }]}
					onChange={(type) => type !== auth.type && onChange({ ...value, auth: type === "api_key" ? apiKeyDefaults : { type } })}
				/>
			</Field>
			{auth.type === "api_key" && (
				<div className="grid grid-cols-3 gap-3">
					<Field label="Header">
						<input className={inputClass} value={auth.header} spellCheck={false} onChange={(e) => setKey({ header: e.target.value })} />
					</Field>
					<Field label="Prefix">
						<input className={inputClass} value={auth.prefix ?? ""} spellCheck={false} placeholder="None" onChange={(e) => setKey({ prefix: e.target.value })} />
					</Field>
					<Field label="Key name">
						<input className={inputClass} value={auth.label} onChange={(e) => setKey({ label: e.target.value })} />
					</Field>
					<p className="col-span-3 text-xs text-neutral-500">Sent as “{auth.header || "Header"}: {auth.prefix}…”. People paste the key when they connect; it’s stored encrypted.</p>
				</div>
			)}
		</>
	);
}

/** The add and edit screen: the fields, with Discard and Create (or Save) in the top bar. */
function ConnectorFormPage({ title, action, error, onDiscard, onSubmit, children }: { title: string; action: string; error?: string; onDiscard?: () => void; onSubmit: () => void; children: React.ReactNode }) {
	return (
		<Page
			title={title}
			crumbs={customizeCrumbs("connectors")}
			actions={
				<>
					{onDiscard && <button type="button" className={barButton} onClick={onDiscard}>Discard</button>}
					<button type="button" className={compactPrimaryButton} onClick={onSubmit}>{action}</button>
				</>
			}
		>
			<Notice>{error}</Notice>
			<div className="flex flex-col gap-5">{children}</div>
		</Page>
	);
}

function NewConnector() {
	const draft = useDraft<ConnectorForm>("connectors:new", emptyForm, 0);
	const create = useMutation(api.customConnectors.create);
	const { error, run } = useRun();
	return (
		<ConnectorFormPage
			title="New connector"
			action="Create"
			error={error}
			onDiscard={draft.dirty ? draft.discard : undefined}
			onSubmit={() => run(create({ connector: draft.value }).then((id) => { draft.discard(); navigate("settings", "connectors", id); }))}
		>
			<p className={metadataClass}>Agents granted it see the server’s tools and their descriptions. Anything not marked read-only asks first.</p>
			<ConnectorFields value={draft.value} onChange={draft.set} />
		</ConnectorFormPage>
	);
}

function EditConnector({ connector, onDone }: { connector: ConnectorItem; onDone: () => void }) {
	const saved = formOf(connector);
	const [value, setValue] = useState(saved);
	const update = useMutation(api.customConnectors.update);
	const { confirm, dialog } = useConfirm();
	const { error, run } = useRun();
	const resets = connector.installed && serverOf(value) !== serverOf(saved);
	return (
		<ConnectorFormPage
			title={`Edit ${connector.name}`}
			action="Save"
			error={error}
			onDiscard={onDone}
			onSubmit={() => resets
				? confirm({ title: `Change how ${connector.name} connects?`, action: "Save and reset", body: "A new server, transport, account type or sign-in disconnects everyone and deletes its saved connections and its Ask, Always and Never settings. It stays installed for the same roles.", onConfirm: () => update({ connectorId: connector.id, connector: value }).then(onDone) })
				: run(update({ connectorId: connector.id, connector: value }).then(onDone))}
		>
			{dialog}
			<ConnectorFields value={value} onChange={setValue} />
		</ConnectorFormPage>
	);
}
