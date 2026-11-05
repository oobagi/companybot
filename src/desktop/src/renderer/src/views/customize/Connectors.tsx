import { Checkbox, Segmented, Select } from "../../controls";
import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import { CUSTOM_CONNECTOR_DESCRIPTION_MAX, CUSTOM_CONNECTOR_NAME_MAX, type CustomConnectorInput } from "@companybot/core/connectors";
import { type Access, can } from "@companybot/core/permissions";
import type { FunctionReturnType } from "convex/server";
import { useState } from "react";
import { api } from "../../api";
import { useAction, useMutation, useQuery } from "../../convex";
import { navigate } from "../../router";
import { ConnectorIcon, EditIcon, TrashIcon } from "../../icons";
import { EmptyState, Form, Loading, Notice, Section, Setting, Settings, barButton, compactButton, compactPrimaryButton, primaryButton, secondaryButton, useDraft, useRun, wideControlClass } from "../../ui";
import { ConnectorActions } from "../Permissions";
import { Card, Detail, Facts, Missing } from "./shared";

import { DialogButtons, MenuItem, Modal, useConfirm } from "../chat/common";

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
	const connector = connectors?.find((p) => p.id === id);
	if (!connector) return <Missing tab="connectors" loaded={!!connectors} />;
	return <ConnectorDetail connector={connector} canManage={can(access, "connectors.manage")} />;
}

function ConnectorDetail({ connector, canManage }: { connector: ConnectorItem; canManage: boolean }) {
	const setInstalled = useMutation(api.connectors.setInstalled);
	const { confirm, dialog } = useConfirm();
	const setRoles = useMutation(api.connectors.setRoles);
	const [editing, setEditing] = useState(false);
	const { error, run } = useRun();
	const signIn = { none: "None needed", api_key: "API key", oauth: "Sign in through your browser" }[connector.auth.type];
	// Your workspace's own: Edit opens its settings (Remove is in their ⋯), in place of Install.
	const customActions = connector.custom && canManage && (
		<>
			<button type="button" className={barButton} onClick={() => setEditing(true)}><EditIcon /> Edit</button>
			{!connector.installed && <button type="button" className={compactPrimaryButton} onClick={() => run(setInstalled({ connectorId: connector.id, installed: true }))}>Install</button>}
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
			{editing && <ConnectorSettingsDialog connector={connector} onClose={() => setEditing(false)} />}
			<Notice>{error}</Notice>
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
						className={compactPrimaryButton}
						// Opens in the browser (main process routes window.open there). The app
						// flips to Connected on its own once the sign-in finishes.
						onClick={() => run(startOAuth({ connectorId: connector.id }).then((url) => window.open(url)))}
					>
						Connect with {connector.name}
					</button>
					<span className="text-neutral-400">Opens your browser to sign in.</span>
				</div>
			) : connector.canUse && connector.canConnect && connector.auth.type === "api_key" ? (
				<div className="flex items-center gap-3">
					<button type="button" className={compactPrimaryButton} onClick={() => setPasting(true)}>
						Connect
					</button>
					<span className="text-neutral-400">Paste a key from {connector.name}.</span>
					{pasting && <ConnectKeyDialog connector={connector} auth={connector.auth} onClose={() => setPasting(false)} />}
				</div>
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
		<Modal title={`Connect ${connector.name}`} size="lg" onClose={onClose}>
			<Form className="flex flex-col gap-3" onSubmit={() => run(connect({ connectorId: connector.id, credentials: { type: "api_key", key } }), onClose)}>
				<Settings>
					<Setting label={auth.label} hint={auth.help ?? "Stored encrypted. Agents use it only for people whose roles can use this connector."}>
						<input aria-label={auth.label} autoFocus type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} className={wideControlClass} />
					</Setting>
				</Settings>
				<Notice>{error}</Notice>
				<DialogButtons>
					<button type="button" className={secondaryButton} onClick={onClose}>Cancel</button>
					<button type="submit" disabled={busy || !key.trim()} className={primaryButton}>Connect</button>
				</DialogButtons>
			</Form>
		</Modal>
	);
}

type ConnectorForm = CustomConnectorInput;

const emptyForm: ConnectorForm = { name: "", description: "", url: "", connection: "workspace", auth: { type: "none" } };
const apiKeyDefaults = { type: "api_key" as const, header: "Authorization", prefix: "Bearer ", label: "API key" };

/** A custom connector as its form shows it. */
const formOf = (c: ConnectorItem): ConnectorForm => ({
	name: c.name,
	description: c.description,
	url: c.server,
	connection: c.connection,
	auth: c.auth.type === "api_key" ? { type: "api_key", header: c.auth.header, prefix: c.auth.prefix ?? "", label: c.auth.label } : { type: c.auth.type },
});

/** What changes where agents connect: saving a change here starts the connector strict (customConnectors.update). */
const serverOf = (f: ConnectorForm) => JSON.stringify([f.url.trim(), f.connection, f.auth.type, f.auth.type === "api_key" ? [f.auth.header.trim(), f.auth.prefix ?? ""] : null]);

const accountOptions = [{ value: "workspace" as const, label: "One shared account" }, { value: "personal" as const, label: "Each person’s own" }];
const signInOptions = [{ value: "none" as const, label: "None" }, { value: "api_key" as const, label: "API key" }, { value: "oauth" as const, label: "OAuth (browser sign-in)" }];
const urlHint = "Streamable HTTP only (often ends in /mcp). https, on the public internet.";

/** The form's edits, shared by both dialogs: changing sign-in type starts an API key from defaults. */
function fieldSetters(value: ConnectorForm, onChange: (value: ConnectorForm) => void) {
	const auth = value.auth;
	return {
		set: (patch: Partial<ConnectorForm>) => onChange({ ...value, ...patch }),
		setSignIn: (type: ConnectorForm["auth"]["type"]) => type !== auth.type && onChange({ ...value, auth: type === "api_key" ? apiKeyDefaults : { type } }),
		setKey: (patch: Partial<typeof apiKeyDefaults>) => auth.type === "api_key" && onChange({ ...value, auth: { ...auth, ...patch } }),
	};
}

/** The connector's rows, shared by New connector and its settings: name, server, whose account, and how it signs in. */
function ConnectorFields({ value, onChange, autoFocus }: { value: ConnectorForm; onChange: (value: ConnectorForm) => void; autoFocus?: boolean }) {
	const auth = value.auth;
	const { set, setSignIn, setKey } = fieldSetters(value, onChange);
	return (
		<Settings title="Connector">
			<Setting label="Name">
				<input aria-label="Name" autoFocus={autoFocus} required maxLength={CUSTOM_CONNECTOR_NAME_MAX} placeholder="e.g. Support desk" className={wideControlClass} value={value.name} onChange={(e) => set({ name: e.target.value })} />
			</Setting>
			<Setting label="Description" hint="Optional. Agents see it when it’s connected.">
				<input aria-label="Description" maxLength={CUSTOM_CONNECTOR_DESCRIPTION_MAX} placeholder="e.g. Tickets and customer conversations" className={wideControlClass} value={value.description} onChange={(e) => set({ description: e.target.value })} />
			</Setting>
			<Setting label="Server URL" hint={urlHint}>
				<input aria-label="Server URL" required inputMode="url" spellCheck={false} placeholder="https://example.com/mcp" className={wideControlClass} value={value.url} onChange={(e) => set({ url: e.target.value })} />
			</Setting>
			<Setting label="Account">
				<Segmented label="Account" value={value.connection} onChange={(connection) => set({ connection })} options={accountOptions} />
			</Setting>
			<Setting label="Sign-in">
				<Select label="Sign-in" className={wideControlClass} value={auth.type} options={signInOptions} onChange={setSignIn} />
			</Setting>
			{auth.type === "api_key" && (
				<>
					<Setting label="Header" hint="Where the key goes in each request.">
						<input aria-label="Header" spellCheck={false} className={wideControlClass} value={auth.header} onChange={(e) => setKey({ header: e.target.value })} />
					</Setting>
					<Setting label="Prefix" hint="Text before the key, like “Bearer ”.">
						<input aria-label="Prefix" spellCheck={false} placeholder="None" className={wideControlClass} value={auth.prefix ?? ""} onChange={(e) => setKey({ prefix: e.target.value })} />
					</Setting>
					<Setting label="Key name" hint="What people are asked for when they connect.">
						<input aria-label="Key name" className={wideControlClass} value={auth.label} onChange={(e) => setKey({ label: e.target.value })} />
					</Setting>
				</>
			)}
		</Settings>
	);
}

/** New connector: a form dialog, opened from the Connectors top bar. Opens the new connector's page. */
export function NewConnectorDialog({ onClose }: { onClose: () => void }) {
	const draft = useDraft<ConnectorForm>("connectors:new", emptyForm, 0);
	const create = useMutation(api.customConnectors.create);
	const { error, busy, run } = useRun();
	const close = () => (draft.discard(), onClose());
	return (
		<Modal title="New connector" size="lg" onClose={close}>
			<Form className="flex flex-col gap-3" onSubmit={() => run(create({ connector: draft.value }).then((id) => { close(); navigate("settings", "connectors", id); }))}>
				<ConnectorFields autoFocus value={draft.value} onChange={draft.set} />
				<Notice>{error}</Notice>
				<DialogButtons>
					<button type="button" onClick={close} className={secondaryButton}>Cancel</button>
					<button type="submit" disabled={busy} className={primaryButton}>Create connector</button>
				</DialogButtons>
			</Form>
		</Modal>
	);
}

/** A custom connector's settings: one card, Discard/Save under it when changed, Remove in ⋯. */
function ConnectorSettingsDialog({ connector, onClose }: { connector: ConnectorItem; onClose: () => void }) {
	const saved = formOf(connector);
	const [value, setValue] = useState(saved);
	const update = useMutation(api.customConnectors.update);
	const remove = useMutation(api.customConnectors.remove);
	const { confirm, dialog } = useConfirm();
	const { error, busy, run } = useRun();
	const dirty = JSON.stringify(value) !== JSON.stringify(saved);
	const resets = connector.installed && serverOf(value) !== serverOf(saved);
	const save = () => update({ connectorId: connector.id, connector: value });
	const removeIt = () =>
		confirm({ title: `Remove ${connector.name}?`, action: "Remove connector", body: "This disconnects it for everyone and deletes it, with its saved connections and permissions. Agents granted it lose its tools.", onConfirm: () => remove({ connectorId: connector.id }).then(() => { onClose(); navigate("settings", "connectors"); }) });
	return (
		<Modal title={connector.name} size="lg" onClose={onClose} menu={(closeMenu) => <MenuItem danger onClick={() => (closeMenu(), removeIt())}><TrashIcon /> Remove connector</MenuItem>}>
			{dialog}
			<Form
				className="flex flex-col gap-3"
				onSubmit={() => resets
					? confirm({ title: `Change how ${connector.name} connects?`, action: "Save and reset", body: "A new server, account type or sign-in disconnects everyone and deletes its saved connections and its Ask, Always and Never settings. It stays installed for the same roles.", onConfirm: save })
					: run(save())}
			>
				<ConnectorFields value={value} onChange={setValue} />
				<Notice>{error}</Notice>
				{dirty && (
					<DialogButtons>
						<button type="button" onClick={() => setValue(saved)} className={compactButton}>Discard</button>
						<button type="submit" disabled={busy} className={compactPrimaryButton}>Save</button>
					</DialogButtons>
				)}
			</Form>
		</Modal>
	);
}
