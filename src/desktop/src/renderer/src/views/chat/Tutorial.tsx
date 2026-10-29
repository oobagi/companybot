import type { TutorialStep } from "@companybot/core/onboarding";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { api } from "../../api";
import { useQuery } from "../../convex";
import { CaretRightIcon, CheckIcon } from "../../icons";

/** What each step asks, and how to do it. `agent` is the main agent's name. */
const copy = (agent: string): Record<TutorialStep, { title: string; how: string }> => ({
	mention: {
		title: `@mention ${agent} to ask it something`,
		how: `Type @ and pick ${agent}. Outside DMs, agents only answer when you mention them.`,
	},
	dm: { title: "DM an agent for anything private", how: `Open ${agent} under Direct messages. Personal memories are only read there.` },
	thread: { title: "Reply in a thread", how: "Hover a message and click Reply in thread, to keep side talk out of the channel." },
	invite: { title: "Invite a teammate", how: `Settings → Members. ${agent} will welcome them in a DM.` },
});

/** Posting in #general without an agent: the card pulses while that's the step. Fired from the chat, heard by the sidebar. */
let nudges = 0;
const listeners = new Set<() => void>();
export function nudgeTutorial() {
	nudges++;
	for (const l of listeners) l();
}
const subscribe = (l: () => void) => (listeners.add(l), () => void listeners.delete(l));

/**
 * Getting started, at the bottom of the sidebar so it follows you to DMs and Settings (two
 * steps take you there). Every step, ticked off on the server as you do it (backend onboarding.ts);
 * the current one says how. `agent` is the main agent's name.
 */
export function GettingStarted({ agent }: { agent: string }) {
	const steps = useQuery(api.onboarding.tutorial);
	const nudge = useSyncExternalStore(subscribe, () => nudges);
	const [pulsing, setPulsing] = useState(false);
	// X folds it to its title line (kept per computer); it unfolds on click, or when nudged.
	const [folded, setFolded] = useState(() => localStorage.getItem("tutorial.folded") === "true");
	const fold = (next: boolean) => (setFolded(next), localStorage.setItem("tutorial.folded", String(next)));
	const current = steps?.findIndex((s) => !s.done) ?? -1;
	const onMention = steps?.[current]?.id === "mention";
	// Only a nudge after mounting pulses; the count is module-wide, so a remount must not replay the last one.
	const seen = useRef(nudge);
	useEffect(() => {
		if (nudge === seen.current) return;
		seen.current = nudge;
		setPulsing(true);
		setFolded(false);
		const timer = setTimeout(() => setPulsing(false), 1600);
		return () => clearTimeout(timer);
	}, [nudge]);

	if (!steps || current < 0) return null;
	const text = copy(agent);
	const title = `Getting started · ${steps.filter((s) => s.done).length} of ${steps.length}`;
	return (
		<section
			aria-label="Getting started"
			className={`mx-3 mb-3 flex flex-col gap-2 rounded-xl border p-3 text-sm transition-colors ${pulsing && onMention ? "animate-pulse border-amber-200 bg-amber-50" : "border-neutral-200 bg-white"}`}
		>
			{/* One control, one place: the caret on the right turns; the whole header is the button. */}
			<button type="button" onClick={() => fold(!folded)} aria-expanded={!folded} className="group/fold -m-1 flex items-center justify-between rounded-lg p-1 text-left">
				<h2 className="min-w-0 truncate text-xs font-medium text-neutral-500 group-hover/fold:text-neutral-900">{title}</h2>
				<CaretRightIcon className={`shrink-0 text-neutral-400 transition-transform group-hover/fold:text-neutral-700 ${folded ? "" : "rotate-90"}`} />
			</button>
			{!folded && (
			<ol className="flex flex-col gap-1.5">
				{steps.map((step, i) => (
					<li key={step.id} className={`flex gap-2 ${i === current ? "text-neutral-900" : "text-neutral-400"}`}>
						<span className={`mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border text-[10px] ${step.done ? "border-neutral-900 bg-neutral-900 text-white" : i === current ? "border-neutral-900" : "border-neutral-300"}`}>
							{step.done && <CheckIcon weight="bold" />}
						</span>
						<span className="flex min-w-0 flex-col gap-0.5">
							<span className={step.done ? "line-through" : i === current ? "font-medium" : ""}>{text[step.id].title}</span>
							{i === current && <span className="text-xs text-neutral-500">{text[step.id].how}</span>}
						</span>
					</li>
				))}
			</ol>
			)}
		</section>
	);
}
