import type { FunctionReturnType } from "convex/server";
import { useState } from "react";
import { defaultIntegrationScopes, integrationScopes, type IntegrationScope } from "@companybot/core/integration-api";
import { can, type Access } from "@companybot/core/permissions";
import { api } from "../api";
import { useMutation, useQuery } from "../convex";
import { Checkbox } from "../controls";
import { Form, Loading, Notice, Settings, Setting, PageActions, NewButton, hintClass, wideControlClass, primaryButton, compactDangerButton, secondaryButton, useRun } from "../ui";
import { Modal, DialogButtons } from "./chat/common";

export function ApiAccess({ access }: { access: Access }) {
	const state = useQuery(api.integrationTokens.list);
	return state ? <TokenList key={state.workspaceId} access={access} state={state} /> : <Loading />;
}

function TokenList({ access, state }: { access: Access; state: FunctionReturnType<typeof api.integrationTokens.list> }) {
	const revoke = useMutation(api.integrationTokens.revoke);
	const [adding, setAdding] = useState(false);
	const { run, error, busy } = useRun();
	return <>
		{can(access, "integrations.manage") && <PageActions><NewButton label="New token" onClick={() => setAdding(true)} /></PageActions>}
		{adding && <NewToken onClose={() => setAdding(false)} />}
		{state.endpoint && <Settings title="Endpoints">
			<Setting label="MCP"><code className="break-all">{state.endpoint}/mcp</code></Setting>
			<Setting label="API"><code className="break-all">{state.endpoint}/api/v1/call</code><p className={hintClass}>Send Authorization: Bearer followed by your token. Operation schemas: {state.endpoint}/api/v1/schema</p></Setting>
		</Settings>}
		<Notice>{error}</Notice>
		{!can(access, "integrations.manage") && <p className={hintClass}>Your role needs permission to create personal API tokens. You can still revoke your existing tokens below.</p>}
		<Settings title="Your tokens">
			{state.tokens.length ? state.tokens.map(token => <Setting key={token.id} label={token.name} hint={`${token.prefix}… · Expires ${new Date(token.expiresAt).toLocaleDateString()}${token.lastUsedAt ? ` · Last used ${new Date(token.lastUsedAt).toLocaleString()}` : " · Not used yet"}`}>
				<p className={hintClass}>{token.scopes.join(", ")}</p>
				{token.lastOperation && <p className={hintClass}>Last operation: {token.lastOperation}</p>}
				<button disabled={busy} className={compactDangerButton} onClick={() => { void run(revoke({ id: token.id })); }}>Revoke</button>
			</Setting>) : <p className={hintClass}>No API tokens.</p>}
		</Settings>
	</>;
}

function NewToken({ onClose }: { onClose: () => void }) {
	const create = useMutation(api.integrationTokens.create);
	const [name, setName] = useState("");
	const [days, setDays] = useState(30);
	const [scopes, setScopes] = useState<IntegrationScope[]>(defaultIntegrationScopes);
	const [secret, setSecret] = useState<string>();
	const { run, error, busy } = useRun();
	return <Modal title={secret ? "Copy your token now" : "New API token"} onClose={() => { if (!busy) onClose(); }}>
		{secret ? <>
			<p className={hintClass}>It will not be shown again. Save it in your client's secret storage.</p>
			<input aria-label="New API token" readOnly value={secret} className={wideControlClass} onFocus={e => e.target.select()} />
			<DialogButtons><button className={primaryButton} onClick={onClose}>Done</button></DialogButtons>
		</> : <Form onSubmit={() => { void run(create({ name, scopes, days }).then(result => setSecret(result.secret))); }}>
			<p className={hintClass}>This token acts as you in this workspace and follows your current permissions.</p>
			<Notice>{error}</Notice>
			<Setting label="Name"><input value={name} onChange={e => setName(e.target.value)} maxLength={80} required placeholder="My reporting app" className={wideControlClass} /></Setting>
			<Setting label="Expires after (days)"><input type="number" min={1} max={90} value={days} onChange={e => setDays(Number(e.target.value))} required className={wideControlClass} /></Setting>
			<Setting label="Access"><div className="flex flex-col gap-2">{Object.entries(integrationScopes).map(([key, label]) => <Checkbox key={key} label={label} checked={scopes.includes(key as IntegrationScope)} onChange={checked => setScopes(checked ? [...scopes, key as IntegrationScope] : scopes.filter(s => s !== key))} />)}</div></Setting>
			<p className={hintClass}>Write access authorizes changes without asking you each time. Agent approval rules apply to agent actions; these tokens use the scopes you select here. Chat posts do not wake agents or trigger automations.</p>
			<DialogButtons><button type="button" disabled={busy} className={secondaryButton} onClick={onClose}>Cancel</button><button disabled={busy || !scopes.length} className={primaryButton}>Create token</button></DialogButtons>
		</Form>}
	</Modal>;
}
