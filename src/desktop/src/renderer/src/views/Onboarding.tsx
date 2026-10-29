import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import { welcomeText } from "@companybot/core/onboarding";
import { DEFAULT_CURRENCY } from "@companybot/core/records";
import { useAuthActions } from "@convex-dev/auth/react";
import { useRef, useState } from "react";
import { api } from "../api";
import { CurrencySelect } from "../controls";
import { useMutation, useQuery } from "../convex";
import { CaretDownIcon, ChannelIcon, CheckIcon, CloseIcon, PlusIcon } from "../icons";
import { Field, Form, Notice, inputClass, primaryButton, secondaryButton, useRun } from "../ui";
import { AgentBadge, Avatar, AvatarStack } from "./chat/common";
import { Group, Item } from "./chat/Sidebar";
import { type OnboardingStep, onboardingSteps, parseInvites } from "./onboarding/logic";

/**
 * Shown signed in with no workspace: a first sign-in with no invites, or after deleting or leaving
 * your last one. Three short steps on the left; on the right, the workspace takes shape as you
 * type (the real sidebar, #general, and Companybot's actual welcome), so the app you land in is
 * the one you watched being made. Everything goes in one call (`workspace.setUp`), so nothing is
 * half set up if it fails. Your name comes first because the welcome uses it.
 */
export function Onboarding({ onDone }: { onDone: (id: Id<"workspaces">) => void }) {
	const me = useQuery(api.workspace.me);
	const prefs = useQuery(api.preferences.get);
	const setUp = useMutation(api.workspace.setUp);
	const { signOut } = useAuthActions();
	const [step, setStep] = useState<OnboardingStep>("you");
	// Someone back here after deleting their last workspace already has a name.
	const [typedName, setTypedName] = useState<string>();
	const name = typedName ?? prefs?.displayName ?? "";
	const [company, setCompany] = useState("");
	const [currency, setCurrency] = useState(DEFAULT_CURRENCY);
	const [invites, setInvites] = useState<string[]>([]);
	// What's typed in the invite box and not yet a chip.
	const [draft, setDraft] = useState("");
	const { error, busy, run, fail } = useRun();
	// A second Enter before the first answer would start a second workspace; `busy` only stops it once React has re-rendered.
	const sending = useRef(false);

	const at = onboardingSteps.indexOf(step);
	const go = (to: OnboardingStep) => (fail(), setStep(to));

	/** Turns the typed text into chips: every invite so far, and what wasn't an email (left in the box). */
	const addInvites = (text: string) => {
		const parsed = parseInvites(text, me?.email);
		const all = [...new Set([...invites, ...parsed.emails])];
		if (all.length > invites.length) setInvites(all);
		setDraft(parsed.invalid.join(" "));
		return { all, invalid: parsed.invalid };
	};

	const submit = () => {
		if (step === "you") return name.trim() ? go("company") : fail("Enter your name.");
		if (step === "company") return company.trim() ? go("team") : fail("Enter your company's name.");
		const { all, invalid } = addInvites(draft);
		if (invalid.length > 0) return fail(`Not an email: ${invalid.join(", ")}`);
		if (sending.current) return;
		sending.current = true;
		void run(setUp({ displayName: name, name: company, currency, invites: all }).then(onDone)).finally(() => (sending.current = false));
	};

	return (
		<div className="drag relative flex h-screen overflow-hidden bg-neutral-50">
			{/* The form: its own column, left-aligned, centered in the window's height. */}
			<div className="no-drag relative z-10 flex w-full shrink-0 flex-col justify-center px-10 py-8 lg:w-[460px] lg:px-16">
				<Form className="flex flex-col gap-6" onSubmit={submit}>
					<Steps at={at} />
					{step === "you" && (
						<Intro title="First, your name" body="Companybot and your teammates call you by it." />
					)}
					{step === "company" && (
						<Intro title="Name your company" body="It becomes your workspace, with you as its owner." />
					)}
					{step === "team" && (
						<Intro title="Bring your team" body="Each person gets an email with the app and joins as a member. You can also do this later, from Members." />
					)}

					{step === "you" && (
						<Field label="Your name">
							<input autoFocus value={name} onChange={(e) => setTypedName(e.target.value)} placeholder="e.g. Jaden" maxLength={60} className={`${inputClass} bg-white`} />
						</Field>
					)}
					{step === "company" && (
						<>
							<Field label="Company">
								<input autoFocus value={company} onChange={(e) => setCompany(e.target.value)} placeholder="e.g. Acme" className={`${inputClass} bg-white`} />
							</Field>
							<Field label="Currency" hint="For amounts on deals and invoices. Changeable later in Settings.">
								<CurrencySelect className={`${inputClass} w-full bg-white`} value={currency} onChange={setCurrency} />
							</Field>
						</>
					)}
					{step === "team" && (
						<InviteBox
							invites={invites}
							draft={draft}
							onDraft={(text) => (/[\s,;]/.test(text) ? addInvites(text) : setDraft(text), fail())}
							onCommit={() => addInvites(draft)}
							onRemove={(email) => setInvites(invites.filter((e) => e !== email))}
						/>
					)}

					<Notice>{error}</Notice>
					<div className="flex items-center gap-2">
						<button type="submit" disabled={busy} className={primaryButton}>
							{step !== "team" ? "Continue" : busy ? "Creating…" : "Create workspace"}
						</button>
						{at > 0 && (
							<button type="button" onClick={() => go(onboardingSteps[at - 1]!)} disabled={busy} className={secondaryButton}>
								Back
							</button>
						)}
					</div>
				</Form>
				{me?.email && (
					<p className="absolute bottom-8 left-10 text-xs text-neutral-400 lg:left-16">
						Signed in as {me.email}. Not you?{" "}
						<button type="button" onClick={() => void signOut()} className="underline hover:text-neutral-700">
							Sign out
						</button>
					</p>
				)}
			</div>

			{/* The workspace, as it'll open: a window peeking in from the right, filling in as they type. */}
			<div className="relative hidden flex-1 lg:block">
				<div className="absolute inset-y-10 right-0 left-0 overflow-hidden rounded-l-2xl border border-r-0 border-neutral-200/80 bg-neutral-100 shadow-[0_1px_2px_rgba(0,0,0,0.04),0_24px_48px_-24px_rgba(0,0,0,0.18)]">
					<Preview name={name} company={company} invites={invites} />
				</div>
			</div>
		</div>
	);
}

function Intro({ title, body }: { title: string; body: string }) {
	return (
		<div className="flex flex-col gap-2">
			<h1 className="text-2xl font-semibold tracking-tight text-neutral-900">{title}</h1>
			<p className="max-w-xs text-sm text-neutral-500">{body}</p>
		</div>
	);
}

const stepLabels: Record<OnboardingStep, string> = { you: "You", company: "Company", team: "Team" };

/** Where they are in the three steps: done ones checked, the current one dark. */
function Steps({ at }: { at: number }) {
	return (
		<ol className="flex items-center gap-3 text-xs font-medium" aria-label={`Step ${at + 1} of ${onboardingSteps.length}`}>
			{onboardingSteps.map((id, i) => (
				<li key={id} className={`flex items-center gap-1.5 ${i === at ? "text-neutral-900" : i < at ? "text-neutral-500" : "text-neutral-400"}`}>
					{i < at ? <CheckIcon weight="bold" /> : <span className={`size-1.5 rounded-full ${i === at ? "bg-neutral-900" : "bg-neutral-300"}`} />}
					{stepLabels[id]}
				</li>
			))}
		</ol>
	);
}

/** Emails become chips as you type them (Enter, comma or space), each with the initials they'll have. */
function InviteBox({
	invites,
	draft,
	onDraft,
	onCommit,
	onRemove,
}: {
	invites: string[];
	draft: string;
	onDraft: (text: string) => void;
	onCommit: () => void;
	onRemove: (email: string) => void;
}) {
	const input = useRef<HTMLInputElement>(null);
	return (
		<Field label="Emails" hint="Type one and press Enter, or paste a list.">
			<div onClick={() => input.current?.focus()} className={`${inputClass} flex min-h-24 cursor-text flex-wrap content-start gap-1.5 bg-white`}>
				{invites.map((email) => (
					<span key={email} className="flex items-center gap-1.5 rounded-full bg-neutral-100 py-0.5 pr-1 pl-0.5 text-sm text-neutral-700">
						<Avatar name={email} size="xs" />
						{email}
						<button type="button" onClick={() => onRemove(email)} aria-label={`Remove ${email}`} className="rounded-full p-0.5 text-neutral-400 hover:bg-neutral-200 hover:text-neutral-700">
							<CloseIcon size={12} weight="bold" />
						</button>
					</span>
				))}
				<input
					ref={input}
					autoFocus
					value={draft}
					onChange={(e) => onDraft(e.target.value)}
					onBlur={onCommit}
					onKeyDown={(e) => {
						if (e.key === "Enter" && draft.trim()) (e.preventDefault(), onCommit());
						if (e.key === "Backspace" && !draft && invites.length > 0) onRemove(invites[invites.length - 1]!);
					}}
					placeholder={invites.length ? "" : "sam@acme.com"}
					className="min-w-32 flex-1 bg-transparent py-0.5 outline-none placeholder:text-neutral-400"
				/>
			</div>
		</Field>
	);
}

const noop = () => {};

/**
 * The app's shell with what they've typed in it: the rail's tile, the sidebar, #general with
 * everyone who'll be in it, and Companybot's welcome (its real text, `welcomeText`). Rendered at
 * full size and scaled down, so it's exactly what opens next. Not interactive.
 */
function Preview({ name, company, invites }: { name: string; company: string; invites: string[] }) {
	const workspace = company.trim() || "Your company";
	const you = name.trim() || "You";
	const members = [{ name: you, type: "user" }, { name: "Companybot", type: "agent" }, ...invites.map((email) => ({ name: email, type: "user" }))];
	const welcome = welcomeText("new_workspace", { agent: "Companybot", name: name.trim() || null, memory: true });
	return (
		// Laid out at 100/78 % of the frame and scaled by 0.78, so it fills the frame exactly at app size.
		<div aria-hidden className="pointer-events-none absolute top-0 left-0 h-[128.2%] w-[128.2%] origin-top-left scale-[0.78] select-none">
			<div className="flex h-full flex-col bg-neutral-100 text-[15px] text-neutral-900">
				<div className="h-10 shrink-0" />
				<div className="flex min-h-0 flex-1">
					{/* The rail: this workspace, open. */}
					<nav className="flex w-[60px] shrink-0 flex-col items-center gap-2 pt-3">
						<span className="size-9 overflow-hidden rounded-xl">
							<Avatar name={workspace} agent />
						</span>
						<span className="flex size-9 items-center justify-center rounded-[18px] border border-neutral-300 bg-white text-neutral-700">
							<PlusIcon size={18} />
						</span>
						<span className="mt-auto pb-3">
							<Avatar name={you} />
						</span>
					</nav>
					<div className="flex min-w-0 flex-1 overflow-hidden rounded-tl-xl border-t border-l border-neutral-200 bg-white">
						<aside className="flex w-60 shrink-0 flex-col gap-4 border-r border-neutral-200 bg-neutral-50 px-3 pt-3">
							<div className="flex items-center gap-2 px-2 py-1 pb-3 text-sm font-semibold">
								<span className={`truncate ${company.trim() ? "" : "text-neutral-400"}`}>{workspace}</span>
								<CaretDownIcon className="shrink-0 text-neutral-400" />
							</div>
							<Group title="Channels">
								<Item icon={<ChannelIcon />} active onClick={noop}>
									general
								</Item>
							</Group>
							<Group title="Direct messages">
								<Item icon={<Avatar name="Companybot" agent size="row" />} onClick={noop}>
									<span className="truncate">Companybot</span>
									<AgentBadge />
								</Item>
							</Group>
						</aside>
						<main className="flex min-w-0 flex-1 flex-col">
							<header className="flex h-12 shrink-0 items-center gap-3 px-5">
								<div className="flex min-w-0 items-baseline gap-2 px-1 text-sm font-semibold">
									<h1>#general</h1>
									<p className="truncate font-normal text-neutral-500">Everyone in the workspace.</p>
								</div>
								<span className="ml-auto flex items-center gap-1.5 px-1.5 text-sm text-neutral-500">
									<AvatarStack people={members} />
									{members.length}
								</span>
							</header>
							<div className="flex flex-1 flex-col justify-end px-5 pb-6">
								<h2 className="text-lg font-semibold">#general</h2>
								<p className="text-sm text-neutral-500">This is the very beginning of #general.</p>
								<div className="my-5 flex items-center gap-3 text-xs text-neutral-400">
									<span className="h-px flex-1 bg-neutral-200" />
									Today
									<span className="h-px flex-1 bg-neutral-200" />
								</div>
								<div className="flex gap-3">
									<Avatar name="Companybot" agent />
									<div className="flex min-w-0 flex-col gap-1">
										<p className="flex items-center gap-2">
											<span className="font-semibold">Companybot</span>
											<AgentBadge />
										</p>
										{welcome.split("\n\n").map((paragraph, i) => (
											<p key={i} className="leading-relaxed">
												{paragraph}
											</p>
										))}
									</div>
								</div>
								<div className="mt-6 rounded-2xl border border-neutral-200 px-4 py-3 text-neutral-400">Message #general</div>
							</div>
						</main>
					</div>
				</div>
			</div>
		</div>
	);
}
