import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import { formatPhone, localPartError, suggestLocalPart } from "@companybot/core/inbox";
import { useState } from "react";
import { api } from "../api";
import { useMutation, useQuery } from "../convex";
import { TrashIcon } from "../icons";
import { Form, Notice, Setting, Settings, compactButton, hintClass, iconDangerButton, primaryButton, secondaryButton, useRun, wideControlClass } from "../ui";
import { DialogButtons, Modal, useConfirm } from "./chat/common";

// An agent's page, Contact: its own email address and phone number (backend contactPoints.ts). They
// apply at once, like its picture; what customers send lands in Inbox. Website chat isn't built yet.
// Posting about new conversations somewhere is an automation ("When someone new emails or texts an agent").

export function AgentContact({ agentId, agentName, canManage }: { agentId: Id<"agents">; agentName: string; canManage: boolean }) {
	const contact = useQuery(api.contactPoints.forAgent, { agentId });
	const remove = useMutation(api.contactPoints.remove);
	const add = useMutation(api.contactPoints.add);
	const [adding, setAdding] = useState<"email" | "phone">();
	const { confirm, dialog } = useConfirm();
	const { error, run } = useRun();
	if (!contact) return null;
	const { email, phone, available } = contact;
	return (
		<Settings title="Contact" note="How customers reach this agent. What they send lands in Inbox, where it answers and your team can step in.">
			{dialog}
			{adding && <AddDialog kind={adding} agentId={agentId} agentName={agentName} domain={contact.domain} onClose={() => setAdding(undefined)} />}
			<Setting label="Email address" hint="Its own address: it reads and answers email.">
				{email ? (
					<span className="flex items-center gap-1">
						<span className="text-sm select-text">{email.address}</span>
						{canManage && (
							<button
								type="button"
								aria-label="Remove email address"
								title="Remove email address"
								className={iconDangerButton}
								onClick={() => confirm({ title: `Remove ${email.address}?`, action: "Remove", body: "Email to it bounces from now on. Its conversations stay in Inbox.", onConfirm: () => remove({ agentId, kind: "email" }) })}
							>
								<TrashIcon />
							</button>
						)}
					</span>
				) : available.email ? (
					canManage ? <button type="button" className={compactButton} onClick={() => setAdding("email")}>Get an address</button> : <span className={hintClass}>None</span>
				) : (
					<span className={hintClass}>Not set up on this server</span>
				)}
			</Setting>
			<Setting label="Phone number" hint={phone?.status === "failed" ? `Couldn't get one: ${phone.error}` : "Its own number: it answers texts. Calls are coming soon."}>
				{phone?.status === "active" ? (
					<span className="flex items-center gap-1">
						<span className="text-sm select-text">{formatPhone(phone.address)}</span>
						{canManage && (
							<button
								type="button"
								aria-label="Release phone number"
								title="Release phone number"
								className={iconDangerButton}
								onClick={() =>
									confirm({
										title: `Release ${formatPhone(phone.address)}?`,
										action: "Release",
										body: "The number goes back to the phone company and can't be got back. Texts to it stop reaching you. Its conversations stay in Inbox.",
										onConfirm: () => remove({ agentId, kind: "phone" }),
									})
								}
							>
								<TrashIcon />
							</button>
						)}
					</span>
				) : phone?.status === "getting" ? (
					<span className={hintClass}>Getting a number…</span>
				) : available.phone ? (
					canManage ? (
						<button type="button" className={compactButton} onClick={() => (phone ? run(add({ agentId, kind: "phone", ...(phone.areaCode && { areaCode: phone.areaCode }) })) : setAdding("phone"))}>
							{phone ? "Try again" : "Get a number"}
						</button>
					) : (
						<span className={hintClass}>None</span>
					)
				) : (
					<span className={hintClass}>Not set up on this server</span>
				)}
			</Setting>
			<Setting label="Website chat" hint="A chat box on your website that it answers.">
				<span className={hintClass}>Coming soon</span>
			</Setting>
			<Notice>{error}</Notice>
		</Settings>
	);
}

/** Picks the part before the @, or an area code, then gets it. */
function AddDialog({ kind, agentId, agentName, domain, onClose }: { kind: "email" | "phone"; agentId: Id<"agents">; agentName: string; domain: string | null; onClose: () => void }) {
	const add = useMutation(api.contactPoints.add);
	const [name, setName] = useState(() => suggestLocalPart(agentName, Math.random().toString(36).slice(2, 6)));
	const [areaCode, setAreaCode] = useState("");
	const { error, busy, run } = useRun();
	const problem = kind === "email" ? localPartError(name.trim().toLowerCase()) : areaCode && !/^\d{3}$/.test(areaCode) ? "An area code is 3 digits." : null;
	return (
		<Modal title={kind === "email" ? "Get an email address" : "Get a phone number"} onClose={onClose}>
			<Form onSubmit={() => run(add({ agentId, kind, ...(kind === "email" ? { name: name.trim().toLowerCase() } : areaCode && { areaCode }) }), onClose)}>
				<Settings>
					{kind === "email" ? (
						<Setting label="Address" hint={`Ends in @${domain ?? ""}.`}>
							<input autoFocus aria-label="Address" value={name} onChange={(e) => setName(e.target.value)} className={wideControlClass} />
						</Setting>
					) : (
						<Setting label="Area code" hint="Leave it empty for any US number. A number costs money each month until you release it.">
							<input autoFocus aria-label="Area code" inputMode="numeric" maxLength={3} value={areaCode} onChange={(e) => setAreaCode(e.target.value.replace(/\D/g, ""))} placeholder="512" className={wideControlClass} />
						</Setting>
					)}
				</Settings>
				<Notice>{error ?? (name && problem) ?? undefined}</Notice>
				<DialogButtons>
					<button type="button" onClick={onClose} className={secondaryButton}>
						Cancel
					</button>
					<button type="submit" disabled={busy || !!problem} className={primaryButton}>
						{kind === "email" ? "Get address" : "Get number"}
					</button>
				</DialogButtons>
			</Form>
		</Modal>
	);
}
