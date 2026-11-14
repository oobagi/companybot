import { useEffect, useState, useMemo } from "react";
import { integrationConsentSchema, integrationScopes, type IntegrationConsentRequest } from "@companybot/core/integration-api";
import { api } from "../api";
import { useMutation, useQuery, useQueryOnce, useWorkspace } from "../convex";
import { Checkbox, Select } from "../controls";
import { Loading, Notice, Setting, hintClass, wideControlClass, compactPrimaryButton, compactButton, useRun } from "../ui";

export function OAuthConsent({ request }: { request: string }) {
	const parsed = useMemo(() => { try { return integrationConsentSchema.safeParse(JSON.parse(request)); } catch { return null; } }, [request]);
	if (!parsed?.success) return <Notice>Invalid authorization request. Start again from the application you want to connect.</Notice>;
	return <Consent key={request} request={parsed.data} />;
}
function Consent({ request }: { request: IntegrationConsentRequest }) {
	const workspace = useWorkspace();
	const mine = useQuery(api.workspace.mine);
	const inspect = useQueryOnce(api.integrationOAuth.consent);
	const approve = useMutation(api.integrationOAuth.approve);
	const [attempt, setAttempt] = useState(0);
	const [details, setDetails] = useState<{ name: string; workspace: string }>();
	const [selected, setSelected] = useState<string[]>(request.scopes.filter(s => s.endsWith(":read")));
	const { run, error, busy, fail } = useRun();
	useEffect(() => { let active = true; inspect(request).then(value => { if (active) setDetails(value); }, e => { if (active) fail(e); }); return () => { active = false; }; }, [inspect, request, attempt]);
	const decide = (allow: boolean) => { void run(approve({ ...request, selectedScopes: selected, allow }).then(url => { window.location.assign(url); })); };
	return <main className="mx-auto flex max-w-xl flex-col gap-5 p-8">
		<h1 className="text-xl font-semibold">Connect an application</h1>
		<Setting label="Workspace"><Select disabled={busy} className={wideControlClass} label="Workspace" value={workspace?.id} onChange={id => workspace?.open(id)} options={(mine?.workspaces ?? []).filter(w => !w.resetting).map(w => ({ value: w.id, label: w.name }))} /></Setting>
		<Notice>{error}</Notice>
		{error && <div className="flex flex-col gap-2">
			<p className={hintClass}>Check your connection and workspace access, then retry. If this request expired, start again from the application you want to connect.</p>
			<button className={compactButton} disabled={busy} onClick={() => { fail(); setDetails(undefined); setAttempt(n => n + 1); }}>Retry loading request</button>
		</div>}
		{!details && !error && <Loading />}
		{details && <>
			<p><strong>{details.name}</strong> wants access to <strong>{details.workspace}</strong> as you.</p>
			<p className={hintClass}>The application name is supplied by its developer and is not verified. Continue only if you started this connection and trust this destination:</p>
			<code className="break-all text-sm">{request.redirect}</code>
			<div className="flex flex-col gap-3">{request.scopes.map(scope => <Checkbox key={scope} label={integrationScopes[scope]} checked={selected.includes(scope)} onChange={on => setSelected(on ? [...selected, scope] : selected.filter(s => s !== scope))} />)}</div>
			<p className={hintClass}>Write access permits changes without asking each time. Access lasts up to 30 days, follows your current permissions, and can be revoked in Settings &gt; API access.</p>
			<div className="flex justify-end gap-2"><button className={compactButton} disabled={busy} onClick={() => decide(false)}>Deny</button><button className={compactPrimaryButton} disabled={busy || !selected.length} onClick={() => decide(true)}>Allow selected access</button></div>
		</>}
	</main>;
}
