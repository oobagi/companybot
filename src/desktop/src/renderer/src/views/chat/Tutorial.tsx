import type { TutorialStep } from "@companybot/core/onboarding";
import { useEffect, useState } from "react";
import { api } from "../../api";
import { useMutation, useQuery } from "../../convex";
import { CloseIcon } from "../../icons";

/** What each step asks, and how to do it. `agent` is the main agent's name. */
const copy = (agent: string): Record<TutorialStep, { title: string; how: string }> => ({
	mention: {
		title: `@mention ${agent} to ask it something`,
		how: `Type @ and pick ${agent}. Outside DMs, agents only answer when you mention them.`,
	},
	dm: { title: "DM an agent for anything private", how: `Open ${agent} under Direct messages. Personal memories are only read there.` },
	thread: { title: "Reply in a thread", how: "Hover a message and click Reply in thread, to keep side talk out of the channel." },
	invite: { title: "Invite a teammate", how: `Settings → Members. ${agent} will welcome them in #general.` },
});

/**
 * The tutorial for new people, tucked on top of the composer. One step at a time, ticked off
 * on the server as they do it (backend onboarding.ts). `nudge` goes up when they post in #general
 * without mentioning an agent; while that's the step they're on, the tray pulses.
 */
export function TutorialTray({ agent, nudge }: { agent: string; nudge: number }) {
	const steps = useQuery(api.onboarding.tutorial);
	const dismiss = useMutation(api.onboarding.dismissTutorial);
	const [pulsing, setPulsing] = useState(false);
	const current = steps?.findIndex((s) => !s.done) ?? -1;
	const onMention = steps?.[current]?.id === "mention";
	useEffect(() => {
		if (nudge === 0 || !onMention) return;
		setPulsing(true);
		const timer = setTimeout(() => setPulsing(false), 1600);
		return () => clearTimeout(timer);
	}, [nudge, onMention]);

	if (!steps || current < 0) return null;
	const step = copy(agent)[steps[current]!.id];
	return (
		<div
			className={`mx-4 flex items-start gap-3 rounded-t-xl border border-b-0 px-3 pt-2 pb-2.5 text-sm transition-colors ${
				pulsing ? "animate-pulse border-amber-200 bg-amber-50" : "border-neutral-200 bg-neutral-50"
			}`}
		>
			<div className="flex min-w-0 flex-1 flex-col gap-0.5">
				<p className="flex items-center gap-2">
					<span className="shrink-0 text-xs text-neutral-400">
						Step {current + 1} of {steps.length}
					</span>
					<span className="truncate font-medium text-neutral-800">{step.title}</span>
				</p>
				<p className="text-xs text-neutral-500">{step.how}</p>
			</div>
			<div className="flex shrink-0 items-center gap-1 pt-1.5" aria-label={`${steps.filter((s) => s.done).length} of ${steps.length} done`}>
				{steps.map((s, i) => (
					<span key={s.id} className={`size-1.5 rounded-full ${s.done ? "bg-neutral-800" : i === current ? "bg-neutral-400" : "bg-neutral-200"}`} />
				))}
			</div>
			<button
				type="button"
				onClick={() => dismiss().catch(() => {})}
				title="Hide the tutorial"
				aria-label="Hide the tutorial"
				className="mt-0.5 shrink-0 rounded p-0.5 text-neutral-400 hover:bg-neutral-200 hover:text-neutral-700"
			>
				<CloseIcon />
			</button>
		</div>
	);
}
