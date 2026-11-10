import type { FunctionReturnType } from "convex/server";
import { api } from "../../api";
import { useMutation } from "../../convex";
import { SparkleIcon } from "../../icons";
import { linkButton, useRun } from "../../ui";

// A value AI suggested for a field set to "Suggest it" (backend fieldAi.ts): what it would become, with
// Accept and Dismiss for whoever may edit the record. On the record's page and in Inbox's customer card.

export type Suggestion = NonNullable<FunctionReturnType<typeof api.fieldAi.suggestions>>[number];

export function FieldSuggestion({ suggestion, label, editable }: { suggestion: Suggestion; label?: boolean; editable: boolean }) {
	const decide = useMutation(api.fieldAi.decide);
	const { error, run } = useRun();
	return (
		<span className="flex flex-col gap-0.5">
			<span className="flex items-center gap-2 rounded-lg border border-neutral-200 bg-neutral-50 px-2 py-1 text-sm">
				<span className="text-neutral-400">
					<SparkleIcon />
				</span>
				<span className="min-w-0 flex-1 truncate">
					<span className="text-neutral-500">{label ? `AI suggests ${suggestion.label}: ` : "AI suggests "}</span>
					{suggestion.value}
				</span>
				{editable && (
					<>
						<button type="button" onClick={() => run(decide({ id: suggestion.id, accept: false }))} className={linkButton}>
							Dismiss
						</button>
						<button type="button" onClick={() => run(decide({ id: suggestion.id, accept: true }))} className={linkButton}>
							Accept
						</button>
					</>
				)}
			</span>
			{error && <span className="px-2 text-xs text-red-600">{error}</span>}
		</span>
	);
}
