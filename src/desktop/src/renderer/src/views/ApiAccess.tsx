import type { FunctionReturnType } from "convex/server";
import { useState } from "react";
import { defaultIntegrationScopes, integrationScopes, type IntegrationScope } from "@companybot/core/integration-api";
import { can, type Access } from "@companybot/core/permissions";
import { api } from "../api";
import { useAction, useMutation, useQuery } from "../convex";
import { Checkbox, Select } from "../controls";
import { Form, Loading, Notice, Settings, Setting, hintClass, wideControlClass, primaryButton, compactDangerButton, compactButton, secondaryButton, useRun } from "../ui";
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
		{adding && <NewToken onClose={() => setAdding(false)} />}
		{(!state.oauthConfigured || !state.endpoint) && <p className={hintClass}>{state.endpoint ? "Connecting apps through browser sign-in is not available on this installation yet. You can use an API token below." : "External app access is not available on this installation yet."} This is managed by the team running Companybot, not workspace admins.</p>}
		{state.endpoint && <Settings title="Endpoints">
			<Setting label="MCP" wide><code className="break-all">{state.endpoint}/mcp</code></Setting>
			<Setting label="API" wide><div className="flex min-w-0 flex-col gap-2"><code className="break-all">{state.endpoint}/api/v1/call</code><p className={hintClass}>Send Authorization: Bearer followed by your token.</p><p className={`${hintClass} break-all`}>Operation schemas: {state.endpoint}/api/v1/schema</p></div></Setting>
		</Settings>}
		<Notice>{error}</Notice>
		{!can(access, "integrations.manage") && <p className={hintClass}>Your role needs permission to create personal API tokens. You can still revoke your existing tokens below.</p>}
		<Settings title="Your tokens" action={can(access, "integrations.manage") && <button className={compactButton} onClick={() => setAdding(true)}>New token</button>}>
			{state.tokens.length ? state.tokens.map(token => <Setting key={token.id} wide label={token.name} hint={`${token.oauth ? "OAuth connection · " : ""}${token.prefix}… · ${token.expiresAt <= Date.now() ? "Expired" : "Expires"} ${new Date(token.expiresAt).toLocaleDateString()}${token.lastUsedAt ? ` · Last used ${new Date(token.lastUsedAt).toLocaleString()}` : " · Not used yet"}`}>
				<div className="flex min-w-0 flex-col items-start gap-2">
				<p className={`${hintClass} break-words`}>{token.scopes.join(", ")}</p>
				{token.lastOperation && <p className={hintClass}>Last operation: {token.lastOperation}</p>}
				<button disabled={busy} className={compactDangerButton} onClick={() => { void run(revoke({ id: token.id })); }}>Revoke</button>
				</div>
			</Setting>) : <p className={`${hintClass} px-4 py-3`}>No API tokens.</p>}
		</Settings>
		<Webhooks tokens={state.tokens} allowed={can(access, "integrations.manage")} configured={state.webhooksConfigured} />
		<RequestLog />
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

function Webhooks({ tokens, allowed, configured }: { configured: boolean; tokens: FunctionReturnType<typeof api.integrationTokens.list>["tokens"]; allowed: boolean }) {
	const rows = useQuery(api.integrationWebhooks.list);
	const remove = useMutation(api.integrationWebhooks.remove);
	const [adding, setAdding] = useState(false);
	const { run, error, busy } = useRun();
	return <Settings title="Event webhooks" note="Signed notifications tell your application when accessible records, pages or messages change. Notifications contain no workspace content." action={allowed && <button className={compactButton} disabled={!configured} onClick={() => setAdding(true)}>New webhook</button>}>
		{!configured && <p className="px-4 py-3 text-sm text-neutral-600">Webhooks are not available on this installation yet. The team running Companybot needs to enable them; workspace admins do not need to change anything.</p>}
		{adding && configured && <NewWebhook tokens={tokens} onClose={() => setAdding(false)} />}
		<Notice>{error}</Notice>
		{rows === undefined ? <Loading /> : rows.length === 0 ? <p className={`${hintClass} px-4 py-3`}>No webhooks yet.</p> : null}
		{rows?.map(row => <Setting key={row._id} label={row.url} hint={row.disabled ? "Delivery stopped. Check that the connection is active and the destination accepts notifications, then remove and recreate this webhook." : row.lastStatus === undefined ? "Waiting for changes" : row.lastStatus >= 200 && row.lastStatus < 300 ? "Last delivery succeeded" : `Retrying delivery (${row.attempts}/5). ${row.lastStatus === 0 ? "Could not reach the destination securely. Check its public HTTPS address and availability." : `The destination returned HTTP ${row.lastStatus}. Check the receiving application's logs.`}`}>
			<button className={compactDangerButton} disabled={busy} onClick={() => { void run(remove({ id: row._id })); }}>Remove</button>
		</Setting>)}
	</Settings>;
}
function NewWebhook({ tokens, onClose }: { tokens: FunctionReturnType<typeof api.integrationTokens.list>["tokens"]; onClose: () => void }) {
	const eligible = tokens.filter(t => t.scopes.includes("events:read") && t.scopes.some(s => ["records:read", "pages:read", "chats:read"].includes(s)) && t.expiresAt > Date.now());
	const create = useAction(api.integrationWebhooks.create);
	const [tokenId, setTokenId] = useState(eligible[0]?.id);
	const [url, setUrl] = useState("");
	const [secret, setSecret] = useState<string>();
	const { run, error, busy } = useRun();
	return <Modal title={secret ? "Copy your signing secret" : "New event webhook"} onClose={() => { if (!busy) onClose(); }}>
		<Notice>{error}</Notice>
		{secret ? <><p className={hintClass}>Save this secret in your receiver's secret storage. It is shown only once.</p><input readOnly aria-label="Webhook signing secret" value={secret} className={wideControlClass} onFocus={e => e.target.select()} /><DialogButtons><button className={primaryButton} onClick={onClose}>Done</button></DialogButtons></> : <Form onSubmit={() => { if (tokenId && eligible.some(t => t.id === tokenId)) void run(create({ tokenId, url }).then(result => setSecret(result.secret))); }}>
			<Setting label="Connection"><Select label="Connection" className={wideControlClass} value={tokenId} onChange={setTokenId} options={eligible.map(t => ({ value: t.id, label: t.name }))} /></Setting>
			{!eligible.length && <p className={hintClass}>First create a token with event access and the read scopes your application needs.</p>}
			<Setting label="HTTPS destination"><input type="url" required maxLength={2048} value={url} onChange={e => setUrl(e.target.value)} className={wideControlClass} placeholder="https://your-app.example/companybot/events" /></Setting>
			<p className={hintClass}>Use a public URL without query parameters. Verify the Companybot-Signature header and deduplicate by delivery id. Failed deliveries retry up to five times.</p>
			<DialogButtons><button type="button" className={secondaryButton} disabled={busy} onClick={onClose}>Cancel</button><button className={primaryButton} disabled={busy || !eligible.some(t => t.id === tokenId)}>Create webhook</button></DialogButtons>
		</Form>}
	</Modal>;
}
function RequestLog() {
	const [cursors, setCursors] = useState<(string | null)[]>([null]);
	const rows = useQuery(api.integrationAudit.list, { cursor: cursors[cursors.length - 1]! });
	return <Settings title="API activity" note="Requests made by apps using your tokens or approved connections, newest first. History is kept for 30 days. Request bodies, results and secrets are not logged.">
		{rows === undefined ? <Loading /> : rows.page.length === 0 ? <p className={`${hintClass} px-4 py-3`}>{cursors.length === 1 ? "No requests yet. Activity appears here when a connected app uses Companybot." : "No requests on this page. Return to the previous page for more recent activity."}</p> : null}
		{rows?.page.map(row => <Setting key={row._id} wide label={`${row.operation} · ${row.status ?? "Unfinished"}`} hint={`${new Date(row._creationTime).toLocaleString()} · ${row.transport}`}><code className="break-all text-xs">{row.requestId}</code></Setting>)}
		{(cursors.length > 1 || (rows && !rows.isDone)) && <nav aria-label="API activity pages" className="flex items-center gap-3 px-4 py-2.5"><button className={compactButton} disabled={!rows || cursors.length === 1} onClick={() => setCursors(cursors.slice(0, -1))}>Previous</button><span className={hintClass} aria-live="polite">Page {cursors.length}</span><button className={compactButton} disabled={!rows || rows.isDone} onClick={() => { if (rows) setCursors([...cursors, rows.continueCursor]); }}>Next</button></nav>}
	</Settings>;
}
