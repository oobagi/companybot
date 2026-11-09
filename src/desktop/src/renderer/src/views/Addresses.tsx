import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import { formatPhone, localPartError, suggestLocalPart } from "@companybot/core/inbox";
import { type Access, can } from "@companybot/core/permissions";
import type { FunctionReturnType } from "convex/server";
import { useState } from "react";
import { api } from "../api";
import { Select } from "../controls";
import { useMutation, useQuery } from "../convex";
import { TrashIcon } from "../icons";
import { navigate } from "../router";
import { Form, Loading, Notice, Setting, Settings, compactButton, hintClass, iconDangerButton, primaryButton, secondaryButton, useRun, wideControlClass } from "../ui";
import { DialogButtons, Modal, useConfirm } from "./chat/common";

// Settings → Email and phone: the workspace's addresses and numbers (backend contactPoints.ts), how
// customers reach the business. Each one has the agent that answers new conversations to it, or none
// (your team answers). Every reply goes out from the address a conversation came to, under the name of
// whoever wrote it. Changes apply at once. People with inbox.setup change them; others see them.

type Point = NonNullable<FunctionReturnType<typeof api.contactPoints.list>>["points"][number];

/** Who answers an address: an agent's id, or "" for your team. */
const NOBODY = "";

export function AddressesTab({ access }: { access: Access }) {
	const list = useQuery(api.contactPoints.list);
	const agents = useQuery(api.agents.list);
	const [adding, setAdding] = useState<"email" | "phone">();
	const canEdit = can(access, "inbox.setup");
	if (list === undefined || agents === undefined) return <Loading />;
	if (list === null) return <p className={hintClass}>Your role can't see Inbox, so its addresses aren't shown.</p>;
	const live = agents.filter((a) => !a.archived);
	const answerers = [{ value: NOBODY, label: "Your team" }, ...live.map((a) => ({ value: a._id as string, label: a.name }))];
	const of = (kind: Point["kind"]) => list.points.filter((p) => p.kind === kind);
	const add = (kind: "email" | "phone", offered: boolean) =>
		canEdit && (
			<button type="button" disabled={!offered} title={offered ? undefined : "Not set up on this server"} className={compactButton} onClick={() => setAdding(kind)}>
				{kind === "email" ? "Add an address" : "Add a number"}
			</button>
		);
	return (
		<>
			{adding && <AddDialog kind={adding} domain={list.domain} answerers={answerers} onClose={() => setAdding(undefined)} />}
			<Settings title="Email addresses" note="Customers email these. Replies go out from the address they wrote to, with the name of whoever wrote the reply." action={add("email", list.available.email)}>
				{of("email").map((p) => (
					<Row key={p.id} point={p} answerers={answerers} canEdit={canEdit} />
				))}
				{!of("email").length && <Empty offered={list.available.email} kind="email" />}
			</Settings>
			<Settings title="Phone numbers" note="Customers text these. A number costs money every month until it's released." action={add("phone", list.available.phone)}>
				{of("phone").map((p) => (
					<Row key={p.id} point={p} answerers={answerers} canEdit={canEdit} />
				))}
				{!of("phone").length && <Empty offered={list.available.phone} kind="phone" />}
			</Settings>
			<Settings title="Website chat">
				<Setting label="Chat on your website" hint="A chat box on your site, answered like email and texts.">
					<span className={hintClass}>Coming soon</span>
				</Setting>
			</Settings>
		</>
	);
}

function Empty({ kind, offered }: { kind: "email" | "phone"; offered: boolean }) {
	return (
		<Setting label={kind === "email" ? "No email addresses yet" : "No phone numbers yet"} hint={offered ? undefined : "Not set up on this server yet."}>
			<span />
		</Setting>
	);
}

/** One address or number: who answers it, and removing it. */
function Row({ point: p, answerers, canEdit }: { point: Point; answerers: { value: string; label: string }[]; canEdit: boolean }) {
	const setAgent = useMutation(api.contactPoints.setAgent);
	const remove = useMutation(api.contactPoints.remove);
	const retry = useMutation(api.contactPoints.retry);
	const { confirm, dialog } = useConfirm();
	const { error, run } = useRun();
	const phone = p.kind === "phone";
	const shown = phone ? (p.address ? formatPhone(p.address) : p.areaCode ? `A number in ${p.areaCode}` : "A US number") : p.address;
	const hint = p.status === "getting" ? "Getting a number…" : p.status === "failed" ? `Couldn't get it: ${p.error ?? "unknown error"}` : p.agent ? `${p.agent.name} answers new conversations. Your team can step in.` : "Your team answers. No agent replies.";
	const removeIt = () =>
		confirm(
			phone && p.status === "active"
				? { title: `Release ${shown}?`, action: "Release", body: "The number goes back to the phone company and can't be got back. Texts to it stop reaching you. Its conversations stay in Inbox, but can't be answered.", onConfirm: () => remove({ id: p.id }) }
				: { title: `Remove ${shown}?`, action: "Remove", body: p.status === "active" ? "Email to it bounces from now on. Its conversations stay in Inbox, but can't be answered." : "It won't be got.", onConfirm: () => remove({ id: p.id }) },
		);
	return (
		<>
			{dialog}
			<Setting label={shown} hint={hint}>
				<span className="flex items-center gap-1">
					{p.status === "failed" && canEdit && (
						<button type="button" className={compactButton} onClick={() => run(retry({ id: p.id }))}>
							Try again
						</button>
					)}
					{p.status !== "failed" && (
						<Select
							label={`Who answers ${shown}`}
							value={(p.agent?.id as string | undefined) ?? NOBODY}
							options={answerers}
							disabled={!canEdit}
							onChange={(v) => run(setAgent({ id: p.id, agentId: v === NOBODY ? null : (v as Id<"agents">) }))}
						/>
					)}
					{canEdit && (
						<button type="button" aria-label={`Remove ${shown}`} title={phone && p.status === "active" ? "Release number" : "Remove"} className={iconDangerButton} onClick={removeIt}>
							<TrashIcon />
						</button>
					)}
				</span>
			</Setting>
			{error && <Notice>{error}</Notice>}
		</>
	);
}

/** Picks the part before the @ (or an area code) and who answers it, then gets it. */
function AddDialog({ kind, domain, answerers, onClose }: { kind: "email" | "phone"; domain: string | null; answerers: { value: string; label: string }[]; onClose: () => void }) {
	const add = useMutation(api.contactPoints.add);
	const me = useQuery(api.workspace.me);
	const [name, setName] = useState<string>();
	const [areaCode, setAreaCode] = useState("");
	const [agent, setAgent] = useState(answerers[1]?.value ?? NOBODY);
	const { error, busy, run } = useRun();
	const [random] = useState(() => Math.random().toString(36).slice(2, 6));
	const local = name ?? suggestLocalPart(me?.workspace ?? "", random);
	const problem = kind === "email" ? localPartError(local.trim().toLowerCase()) : areaCode && !/^\d{3}$/.test(areaCode) ? "An area code is 3 digits." : null;
	const agentId = agent === NOBODY ? undefined : (agent as Id<"agents">);
	return (
		<Modal title={kind === "email" ? "Add an email address" : "Add a phone number"} onClose={onClose}>
			<Form onSubmit={() => run(add({ kind, ...(agentId && { agentId }), ...(kind === "email" ? { name: local.trim().toLowerCase() } : areaCode && { areaCode }) }), onClose)}>
				<Settings>
					{kind === "email" ? (
						<Setting label="Address" hint={`Ends in @${domain ?? ""}.`}>
							<input autoFocus aria-label="Address" value={local} onChange={(e) => setName(e.target.value)} className={wideControlClass} />
						</Setting>
					) : (
						<Setting label="Area code" hint="Leave it empty for any US number. A number costs money each month until it's released.">
							<input autoFocus aria-label="Area code" inputMode="numeric" maxLength={3} value={areaCode} onChange={(e) => setAreaCode(e.target.value.replace(/\D/g, ""))} placeholder="512" className={wideControlClass} />
						</Setting>
					)}
					<Setting label="Who answers" hint="The agent that answers new conversations. Your team can always step in.">
						<Select label="Who answers" value={agent} options={answerers} onChange={setAgent} className={wideControlClass} />
					</Setting>
				</Settings>
				<Notice>{error ?? (local && problem) ?? undefined}</Notice>
				<DialogButtons>
					<button type="button" onClick={onClose} className={secondaryButton}>
						Cancel
					</button>
					<button type="submit" disabled={busy || !!problem} className={primaryButton}>
						{kind === "email" ? "Add address" : "Get number"}
					</button>
				</DialogButtons>
			</Form>
		</Modal>
	);
}

/** On an agent's page: the addresses and numbers it answers, picked in Settings → Email and phone. */
export function AgentAddresses({ agentId, agentName }: { agentId: Id<"agents">; agentName: string }) {
	const points = useQuery(api.contactPoints.forAgent, { agentId });
	if (!points) return null;
	return (
		<Settings
			title="How customers reach it"
			note={`${agentName || "It"} answers new conversations to these. Pick who answers each address and number in Email and phone.`}
			action={
				<button type="button" className={compactButton} onClick={() => navigate("settings", "addresses")}>
					Change
				</button>
			}
		>
			{points.map((p) => (
				<Setting key={p.address} label={p.kind === "email" ? "Email address" : "Phone number"}>
					<span className="text-sm select-text">{p.kind === "phone" ? formatPhone(p.address) : p.address}</span>
				</Setting>
			))}
			{!points.length && (
				<Setting label="None yet" hint="It doesn't answer any email address or phone number.">
					<span />
				</Setting>
			)}
		</Settings>
	);
}
