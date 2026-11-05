import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import { welcomeText } from "@companybot/core/onboarding";
import { DEFAULT_CURRENCY } from "@companybot/core/records";
import { useAuthActions } from "@convex-dev/auth/react";
import { useRef, useState } from "react";
import { api } from "../api";
import { CurrencySelect } from "../controls";
import { useMutation, useQuery } from "../convex";
import { ChannelIcon, CloseIcon, SignOutIcon } from "../icons";
import { appTabs } from "./AppRail";
import { Form, Notice, Setting, Settings, compactControlClass, descriptionClass, primaryButton, secondaryButton, useRun, wideControlClass, trailingAction } from "../ui";
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
	const update = useMutation(api.preferences.update);
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

	/** Turns the typed text into chips. Returns what wasn't an email, left in the box. */
	const addInvites = (text: string) => {
		const parsed = parseInvites(text, me?.email);
		const fresh = parsed.emails.filter((e) => !invites.includes(e));
		if (fresh.length > 0) setInvites([...invites, ...fresh]);
		setDraft(parsed.invalid.join(" "));
		return parsed.invalid;
	};

	const submit = () => {
		if (step === "you") {
			if (!name.trim()) return fail("Enter your name.");
			return void run(update({ displayName: name }).then(() => go("company")));
		}
		if (step === "company") return company.trim() ? go("team") : fail("Enter your company's name.");
		const invalid = addInvites(draft);
		if (invalid.length > 0) return fail(`Not an email: ${invalid.join(", ")}`);
		if (sending.current) return;
		sending.current = true;
		const emails = [...new Set([...invites, ...parseInvites(draft, me?.email).emails])];
		void run(setUp({ displayName: name, name: company, currency, invites: emails }).then(onDone)).finally(() => (sending.current = false));
	};

	return (
		<div className="drag relative flex h-screen overflow-hidden bg-neutral-50">
			{/* The form: its own column, centered like sign-in, so the two screens read as one flow. */}
			<div className="no-drag relative z-10 flex w-full shrink-0 flex-col items-center justify-center px-10 py-8 lg:w-[480px]">
				<Form className="flex w-[360px] flex-col gap-6" onSubmit={submit}>
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
						<NameField name={name} onChange={setTypedName} />
					)}
					{step === "company" && (
						<Settings>
							<Setting label="Company">
								<input autoFocus aria-label="Company" value={company} onChange={(e) => setCompany(e.target.value)} placeholder="e.g. Acme" className={wideControlClass} />
							</Setting>
							<Setting label="Currency" hint="For amounts on deals and invoices. Changeable later in Settings.">
								<CurrencySelect className={wideControlClass} value={currency} onChange={setCurrency} />
							</Setting>
						</Settings>
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
					<div className="flex flex-col gap-4">
						<button type="submit" disabled={busy} className={`${primaryButton} py-2.5`}>
							{step !== "team" ? "Continue" : busy ? "Creating…" : "Create workspace"}
						</button>
						{at > 0 && (
							<button type="button" onClick={() => go(onboardingSteps[at - 1]!)} disabled={busy} className={`${secondaryButton} py-2.5`}>
								Back
							</button>
						)}
					</div>
				</Form>
				{me?.email && (
					<p className="absolute inset-x-0 bottom-8 text-center text-xs text-neutral-400">
						Signed in as {me.email}. Not you?{" "}
						<button type="button" onClick={() => void signOut()} className="underline hover:text-neutral-700">
							Sign out
						</button>
					</p>
				)}
			</div>

			{/* The workspace, as it'll open: a window peeking in from the right, filling in as they type. */}
			<div className="relative hidden flex-1 lg:block">
				<div className="absolute inset-y-10 right-0 left-0 overflow-hidden rounded-l-2xl border border-r-0 border-neutral-200/80 bg-neutral-100 shadow-lg">
					<Preview name={name} company={company} invites={invites} />
				</div>
			</div>
		</div>
	);
}

function Intro({ title, body }: { title: string; body: string }) {
	return (
		<div className="flex flex-col items-center gap-2 text-center">
			<h1 className="text-xl font-semibold tracking-tight text-neutral-900">{title}</h1>
			<p className={descriptionClass}>{body}</p>
		</div>
	);
}

/** Where they are in the three steps: one bar each, filled up to the current one. */
function Steps({ at }: { at: number }) {
	return (
		<ol className="flex items-center justify-center gap-1.5" aria-label={`Step ${at + 1} of ${onboardingSteps.length}`}>
			{onboardingSteps.map((id, i) => (
				<li key={id} className={`h-1 w-8 rounded-full ${i <= at ? "bg-neutral-900" : "bg-neutral-200"}`} />
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
		<Settings>
		<Setting wide label="Emails" hint="Type one and press Enter, or paste a list.">
			<div onClick={() => input.current?.focus()} className={`${compactControlClass} flex min-h-24 w-full cursor-text flex-wrap content-start gap-1.5`}>
				{invites.map((email) => (
					<span key={email} className="flex items-center gap-1.5 rounded-full bg-neutral-100 py-0.5 pr-1 pl-0.5 text-sm text-neutral-700">
						<Avatar name={email} size="xs" />
						{email}
						<button type="button" onClick={() => onRemove(email)} aria-label={`Remove ${email}`} title="Remove" className={trailingAction}>
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
		</Setting>
		</Settings>
	);
}

const noop = () => {};

/**
 * The app's shell with what they've typed in it: the app rail under their workspace's logo,
 * Chat's sidebar, #general with everyone who'll be in it, and Companybot's welcome (its real text, `welcomeText`). Rendered at
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
			{/* oxlint-disable-next-line shadcn/no-arbitrary-values -- 15px is the app's body size (App.tsx's root); the preview mirrors it */}
			<div className="flex h-full flex-col bg-neutral-100 text-[15px] text-neutral-900">
				<div className="h-8 shrink-0" />
				<div className="flex min-h-0 flex-1">
					{/* The app rail: this workspace's logo, the app's parts with Chat open, and you. */}
					<nav className="flex w-[60px] shrink-0 flex-col items-center pt-2 pb-3">
						<Avatar name={workspace} agent />
						<div className="my-auto flex flex-col items-center gap-1">
							{appTabs.map((t) => (
								<span key={t.id} className={`flex size-10 items-center justify-center rounded-lg ${t.id === "chat" ? "bg-neutral-200/90 text-neutral-900" : "text-neutral-500"}`}>
									<t.icon size={22} weight={t.id === "chat" ? "fill" : "regular"} />
								</span>
							))}
						</div>
						<Avatar name={you} />
					</nav>
					<div className="flex min-w-0 flex-1 overflow-hidden rounded-tl-xl border-t border-l border-neutral-200 bg-white">
						<aside className="flex w-60 shrink-0 flex-col gap-4 border-r border-neutral-200 bg-neutral-50 px-3 pt-2.5">
							<h1 className="truncate px-2 py-1 pb-3 text-sm font-semibold">Chat</h1>
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

/** Invited members already have a workspace, but still choose their own name. */
export function NameOnboarding() {
	const { signOut } = useAuthActions();
	const prefs = useQuery(api.preferences.get);
	const update = useMutation(api.preferences.update);
	const [typed, setTyped] = useState<string>();
	const name = typed ?? prefs?.displayName ?? "";
	const { error, busy, run, fail } = useRun();
	return (
		<div className="drag flex h-screen items-center justify-center bg-neutral-50">
			<Form className="no-drag flex w-[360px] flex-col gap-6" onSubmit={() => {
				if (!name.trim()) return fail("Enter your name.");
				void run(update({ displayName: name }));
			}}>
				<Intro title="First, your name" body="Companybot and your teammates call you by it." />
				<NameField name={name} onChange={setTyped} />
				<Notice>{error}</Notice>
				<button type="submit" disabled={busy} className={primaryButton}>Continue</button>
				<button type="button" onClick={() => void signOut()} className={`${secondaryButton} inline-flex items-center justify-center gap-1.5`}><SignOutIcon /> Sign out</button>
			</Form>
		</div>
	);
}

function NameField({ name, onChange }: { name: string; onChange: (name: string) => void }) {
	return (
		<Settings>
			<Setting label="Your name">
				<input autoFocus aria-label="Your name" value={name} onChange={(e) => onChange(e.target.value)} placeholder="e.g. Jaden" maxLength={60} className={wideControlClass} />
			</Setting>
		</Settings>
	);
}
