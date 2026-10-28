import { readableValue } from "@companybot/core/action-words";
import type { FunctionReturnType } from "convex/server";
import { useState } from "react";
import { api } from "../../api";
import { useMutation, useQuery } from "../../convex";
import { Notice, descriptionClass, hintClass, primaryButton, secondaryButton, timeAgo, useRun } from "../../ui";
import { AgentBadge, Avatar, clock } from "./common";
import type { Message } from "./data";

type ApprovalPart = Extract<Message["parts"][number], { type: "approval" }>;
type Approval = FunctionReturnType<typeof api.approvals.forReply>[number];

/**
 * Calls the agent held for permission, each shown as its own message from the agent
 * right after its reply: what it wants to do, in its voice, the exact input, and the
 * answers. It stays in the timeline after a decision, showing the outcome.
 */
export function ApprovalMessages({ message, parts }: { message: Message; parts: ApprovalPart[] }) {
	const approvals = useQuery(api.approvals.forReply, { replyId: message._id });
	return parts.map((part) => (
		<div key={part.id} className="flex gap-3 px-5 pt-2 pb-0.5">
			<div className="flex w-9 shrink-0 justify-center">
				<Avatar name={message.author.name} image={message.author.image} agent />
			</div>
			<div className="flex min-w-0 flex-1 flex-col gap-1">
				<div className="flex items-baseline gap-2">
					<span className="font-semibold">{message.author.name}</span>
					<AgentBadge />
					<span className="text-xs text-neutral-400 tabular-nums">{clock(message._creationTime)}</span>
				</div>
				<ApprovalCard part={part} approval={approvals?.find((a) => a.callId === part.id)} />
			</div>
		</div>
	));
}

/**
 * One held call. Shows the exact input that will run, every field in full; the person the
 * agent acts for answers. Answers are locked to what's shown here (`hash`), so nothing else can run.
 */
function ApprovalCard({ part, approval }: { part: ApprovalPart; approval: Approval | undefined }) {
	const decide = useMutation(api.approvals.decide);
	const { error, busy, run } = useRun();
	const [raw, setRaw] = useState(false);
	const send = (approve: boolean, always = false) => {
		if (!approval) return;
		run(decide({ approvalId: approval._id, hash: approval.hash, approve, always: !!always }));
	};
	const service = approval ? [approval.service, approval.action].filter(Boolean).join(" · ") : part.tool;

	return (
		<div className="flex max-w-xl flex-col gap-3 rounded-2xl rounded-tl-sm border border-neutral-200 bg-neutral-50 px-4 py-3">
			<p className="leading-relaxed">{approval?.ask ?? `I'd like to run ${part.tool}.`}</p>
			<div className="flex flex-col gap-2 rounded-xl bg-white px-3 py-2">
				<div className="flex items-baseline justify-between gap-3 text-xs text-neutral-500">
					<span>{service}</span>
					{approval && (
						<button type="button" onClick={() => setRaw(!raw)} className="text-neutral-400 hover:text-neutral-600">
							{raw ? "Fields" : "Raw"}
						</button>
					)}
				</div>
				{approval ? raw ? <Raw text={pretty(approval.input)} /> : <Fields input={approval.input} /> : <p className={hintClass}>Loading…</p>}
			</div>
			{approval && <Status approval={approval} busy={busy} raw={raw} onDecide={send} />}
			<Notice>{error}</Notice>
		</div>
	);
}

/** `raw`: the card's Raw toggle, which also shows what the call returned (the agent's reply says it in words). */
function Status({
	approval,
	busy,
	raw,
	onDecide,
}: {
	approval: Approval;
	busy: boolean;
	raw: boolean;
	onDecide: (approve: boolean, always?: boolean) => void;
}) {
	const by = approval.always ? `Always allowed by ${approval.approver}` : `Allowed once by ${approval.approver}`;
	switch (approval.status) {
		case "pending":
			return approval.canDecide ? (
				<div className="flex flex-col gap-2">
					<p className="text-xs text-neutral-500">Acting for {approval.approver}. Only they can answer.</p>
					<div className="flex flex-wrap items-center gap-2">
						<button type="button" disabled={busy} onClick={() => onDecide(true)} className={`${primaryButton} py-1.5`}>
							Allow once
						</button>
						{approval.alwaysText && (
							<button type="button" disabled={busy} onClick={() => onDecide(true, true)} className={`${secondaryButton} bg-white py-1.5`}>
								{approval.alwaysAutomation ? "Always for this automation" : "Always allow"}
							</button>
						)}
						<button type="button" disabled={busy} onClick={() => onDecide(false)} className={`${secondaryButton} bg-white py-1.5`}>
							Deny
						</button>
					</div>
					{/* Said plainly, so nobody reads "always" as "still ask me at key steps". */}
					<p className="text-xs text-neutral-500" title={`Locked to this exact content (SHA-256 ${approval.hash})`}>
						{approval.alwaysText ?? "This action asks every time."} Expires {timeAgo(approval.expiresAt)}.
					</p>
				</div>
			) : (
				<p className="text-xs text-neutral-500">
					Waiting for {approval.approver}. The agent is acting for them, so only they can answer.
				</p>
			);
		case "approved":
		case "running":
			return <p className="text-xs text-neutral-500">{by} · running…</p>;
		case "done":
			return (
				<div className="flex flex-col gap-1.5">
					<p className="text-xs text-emerald-700">{by} · done</p>
					{raw && approval.result !== null && <Raw text={approval.result} />}
				</div>
			);
		case "failed":
			return <p className="text-xs text-red-700">{by}, but it failed: {approval.error}</p>;
		case "denied":
			return <p className="text-xs text-neutral-500">Denied by {approval.approver}. Nothing ran.</p>;
		case "expired":
			return <p className="text-xs text-neutral-500">Expired without an answer. Nothing ran.</p>;
	}
}

/** Top-level fields, each in full: text as written (phone numbers laid out), numbers plain, anything else as JSON. */
function Fields({ input }: { input: string }) {
	const value: unknown = JSON.parse(input);
	if (!value || typeof value !== "object" || Array.isArray(value)) return <Raw text={pretty(input)} />;
	const entries = Object.entries(value);
	if (entries.length === 0) return <p className={descriptionClass}>No input.</p>;
	return (
		<dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
			{entries.map(([key, v]) => (
				<div key={key} className="contents">
					<dt className="text-neutral-500">{key}</dt>
					<dd className="min-w-0 break-words whitespace-pre-wrap text-neutral-900">
						{typeof v === "string" ? (
							readableValue(v)
						) : typeof v === "number" || typeof v === "boolean" ? (
							v.toLocaleString()
						) : (
							<code className="text-xs">{JSON.stringify(v, null, 2)}</code>
						)}
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
