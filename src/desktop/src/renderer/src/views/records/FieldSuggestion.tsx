import type { FunctionReturnType } from "convex/server";
import { api } from "../../api";
import { useMutation } from "../../convex";
import { CheckIcon, CloseIcon, SparkleIcon } from "../../icons";
import { actionButton, actionPrimaryButton, useRun } from "../../ui";

// A value AI suggested for a field set to "Suggest it" (backend fieldAi.ts): what it would become, with
// Accept and Dismiss for whoever may edit the record. On the record's page it takes the value's place until
// someone decides; in Inbox's customer card it sits under the record.

export type Suggestion = NonNullable<FunctionReturnType<typeof api.fieldAi.suggestions>>[number];

export function FieldSuggestion({ suggestion, label, current, editable }: { suggestion: Suggestion; label?: boolean; current?: React.ReactNode; editable: boolean }) {
	const decide = useMutation(api.fieldAi.decide);
	const { error, run } = useRun();
	return (
		<span className="flex flex-col gap-0.5">
			<span className="flex items-center gap-2 rounded-lg border border-neutral-200 bg-neutral-50 py-1 pr-1 pl-2">
				<span className="text-neutral-400">
					<SparkleIcon />
				</span>
				<span className="min-w-0 flex-1 truncate">
					<span className="text-neutral-500">{label ? `AI suggests ${suggestion.label}: ` : "AI suggests "}</span>
					{current && <span className="mr-1.5 text-neutral-400 line-through">{current}</span>}
					{suggestion.value}
				</span>
				{editable && (
					<>
						<button type="button" onClick={() => run(decide({ id: suggestion.id, accept: false }))} className={actionButton}>
							<CloseIcon /> Dismiss
						</button>
						<button type="button" onClick={() => run(decide({ id: suggestion.id, accept: true }))} className={actionPrimaryButton}>
							<CheckIcon /> Accept
						</button>
					</>
				)}
			</span>
			{error && <span className="px-2 text-xs text-red-600">{error}</span>}
		</span>
	);
}
