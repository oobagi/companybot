import type { FunctionReturnType } from "convex/server";
import { useMutation } from "convex/react";
import { useState } from "react";
import { api } from "../../api";
import { Notice, primaryButton, secondaryButton, timeAgo, useRun } from "../../ui";
import type { Message } from "./data";

type ApprovalPart = Extract<Message["parts"][number], { type: "approval" }>;
type Approval = FunctionReturnType<typeof api.approvals.forReply>[number];

/**
 * A call the agent held for approval, shown where it would have run. Shows the exact
 * input that will run, every field in full; the person the agent acts for approves or
 * denies. The decision is locked to what's shown here (`hash`), so nothing else can run.
 */
export function ApprovalCard({ part, approval }: { part: ApprovalPart; approval: Approval | undefined }) {
	const decide = useMutation(api.approvals.decide);
	const { error, run } = useRun();
	const [busy, setBusy] = useState(false);
	const [raw, setRaw] = useState(false);
	const send = (approve: boolean) => {
		if (!approval) return;
		setBusy(true);
		run(decide({ approvalId: approval._id, hash: approval.hash, approve })).finally(() => setBusy(false));
	};
	const title = approval ? [approval.service, approval.action].filter(Boolean).join(" · ") : part.tool;

	return (
		<div className="flex flex-col gap-3 rounded-xl border border-amber-200 bg-amber-50/40 px-4 py-3">
			<div className="flex items-baseline justify-between gap-3">
				<p className="text-sm">
					<span className="font-medium">{approval?.status === "pending" ? "Needs approval" : "Approval"}</span>
					<span className="text-neutral-500"> · {title}</span>
				</p>
				{approval && (
					<button type="button" onClick={() => setRaw(!raw)} className="text-xs text-neutral-400 hover:text-neutral-600">
						{raw ? "Fields" : "Raw"}
					</button>
				)}
			</div>
			{approval ? raw ? <Raw text={pretty(approval.input)} /> : <Fields input={approval.input} /> : <p className="text-sm text-neutral-400">Loading…</p>}
			{approval && <Status approval={approval} busy={busy} onDecide={send} />}
			{error && <Notice>{error}</Notice>}
		</div>
	);
}

function Status({ approval, busy, onDecide }: { approval: Approval; busy: boolean; onDecide: (approve: boolean) => void }) {
	const lock = <span title={`SHA-256 ${approval.hash}`}>Locked to this exact content</span>;
	switch (approval.status) {
		case "pending":
			return approval.canDecide ? (
				<div className="flex items-center gap-2">
					<button type="button" disabled={busy} onClick={() => onDecide(true)} className={`${primaryButton} py-1.5`}>
						Approve
					</button>
					<button type="button" disabled={busy} onClick={() => onDecide(false)} className={`${secondaryButton} bg-white py-1.5`}>
						Deny
					</button>
					<span className="ml-auto text-xs text-neutral-400">
						{lock} · expires {timeAgo(approval.expiresAt)}
					</span>
				</div>
			) : (
				<p className="text-xs text-neutral-500">
					Waiting for {approval.approver} to approve. The agent is acting for them. · {lock}
				</p>
			);
		case "approved":
		case "running":
			return <p className="text-xs text-neutral-500">Approved by {approval.approver} · running…</p>;
		case "done":
			return (
				<div className="flex flex-col gap-1.5">
					<p className="text-xs text-emerald-700">Approved by {approval.approver} · done</p>
					{approval.result !== null && <Raw text={approval.result} />}
				</div>
			);
		case "failed":
			return <p className="text-xs text-red-700">Approved by {approval.approver}, but it failed: {approval.error}</p>;
		case "denied":
			return <p className="text-xs text-neutral-500">Denied by {approval.approver}. Nothing ran.</p>;
		case "expired":
			return <p className="text-xs text-neutral-500">Expired without a decision. Nothing ran.</p>;
	}
}

/** Top-level fields, each in full: text as written, anything else as JSON. */
function Fields({ input }: { input: string }) {
	const value: unknown = JSON.parse(input);
	if (!value || typeof value !== "object" || Array.isArray(value)) return <Raw text={pretty(input)} />;
	const entries = Object.entries(value);
	if (entries.length === 0) return <p className="text-sm text-neutral-500">No input.</p>;
	return (
		<dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
			{entries.map(([key, v]) => (
				<div key={key} className="contents">
					<dt className="text-neutral-500">{key}</dt>
					<dd className="min-w-0 break-words whitespace-pre-wrap text-neutral-900">
						{typeof v === "string" ? v : <code className="text-xs">{JSON.stringify(v, null, 2)}</code>}
					</dd>
				</div>
			))}
		</dl>
	);
}

function Raw({ text }: { text: string }) {
	return (
		<pre className="max-h-64 overflow-auto rounded-lg bg-white px-3 py-2 text-xs break-words whitespace-pre-wrap text-neutral-700">{text}</pre>
	);
}

const pretty = (json: string) => JSON.stringify(JSON.parse(json), null, 2);
