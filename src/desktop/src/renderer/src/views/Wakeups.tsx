import { repeatLabel } from "@companybot/core/wakeups";
import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import type { FunctionReturnType } from "convex/server";
import { api } from "../api";
import { useMutation, useQuery } from "../convex";
import { navigate } from "../router";
import { Section, cardClass, descriptionClass, iconDangerButton, metadataClass } from "../ui";
import { CloseIcon } from "../icons";
import { useConfirm } from "./chat/common";
import { recordPath } from "./records/logic";

// Pending wakeups (backend wakeups.ts): follow-ups agents set, check-ins and job callbacks. Shown
// in Settings → Automations and on the record they're about, each cancellable by its person,
// whoever set it up, or anyone whose roles can change agents, so what's going to run is always visible.

type Wakeup = FunctionReturnType<typeof api.wakeups.list>[number];

const when = (ms: number) =>
	new Date(ms).toLocaleString([], { weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });

/** "every week, 2 more times", "every 6 hours". */
function repeats(w: Wakeup) {
	if (!w.repeat) return null;
	const often = repeatLabel(w.repeat);
	return w.left === null ? often : `${often}, ${w.left} ${w.left === 1 ? "time" : "times"} left`;
}

/** What it'll do, in a line: its note, or what kind of wake it is. */
const what = (w: Wakeup) => w.note ?? (w.place ? (w.job ? "When its job finishes" : "Look around for anything worth doing") : "In a chat you can't see");

/** Pending wakeups, soonest first: all you can see, or one record's. Nothing when there are none. */
export function PendingWakeups({ recordId, title, note }: { recordId?: Id<"records">; title: string; note?: string }) {
	const wakeups = useQuery(api.wakeups.list, { recordId });
	const cancel = useMutation(api.wakeups.cancel);
	const { confirm, dialog } = useConfirm();
	if (!wakeups?.length) return null;
	return (
		<Section title={title} note={note}>
			{dialog}
			<div className="flex flex-col gap-2">
				{wakeups.map((w) => (
					<div key={w._id} className={`flex items-start gap-3 text-sm ${cardClass}`}>
						<div className="flex min-w-0 flex-1 flex-col gap-0.5">
							<span className={w.note ? "break-words" : descriptionClass}>{what(w)}</span>
							<span className={metadataClass}>
								{[
									w.held ? "Waiting: something it needs is in Archive" : w.at ? `Next: ${when(w.at)}` : "When its job finishes",
									repeats(w),
									`for ${w.mine ? "you" : w.actor}`,
									w.agent,
								]
									.filter(Boolean)
									.join(" · ")}
								{w.place && (
									<>
										{" · "}
										<button type="button" className="hover:underline" onClick={() => navigate("chat", w.place!.chatId, ...(w.place!.threadId ? ["thread", w.place!.threadId] : []))}>
											{w.place.label}
										</button>
									</>
								)}
								{w.record && !recordId && (
									<>
										{" · "}
										<button type="button" className="hover:underline" onClick={() => navigate(...recordPath(w.record!.typeKey, w.record!._id))}>
											{w.record.title}
										</button>
									</>
								)}
							</span>
						</div>
						{w.canCancel && (
							<button
								type="button"
								aria-label="Cancel"
								title="Cancel follow-up"
								className={iconDangerButton}
								onClick={() =>
									confirm({
										title: "Cancel this follow-up?",
										action: "Cancel follow-up",
										body: "Nothing runs for it after this. An agent can set a new one if it's needed.",
										onConfirm: () => cancel({ id: w._id }),
									})
								}
							>
								<CloseIcon size={16} />
							</button>
						)}
					</div>
				))}
			</div>
		</Section>
	);
}
