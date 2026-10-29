import { type UsageKind, formatUsd, monthLabel, recentMonths, usageKindLabels } from "@companybot/core/usage";
import { useState } from "react";
import { api } from "../api";
import { useQuery } from "../convex";
import { Select } from "../controls";
import { UsageIcon } from "../icons";
import { EmptyState, Loading, Setting, Settings } from "../ui";

/** Settings → Usage: what AI cost in a month. Owners see the workspace; everyone else only their own share. */
export function UsageTab() {
	const months = recentMonths(Date.now());
	const [month, setMonth] = useState(months[0]!);
	const report = useQuery(api.usage.report, { month });
	if (!report) return <Loading />;
	const mine = report.scope === "mine";
	return (
		<>
			<Settings>
				<Setting label={mine ? "Your usage" : "This workspace"} hint={mine ? "Your replies, chat summaries, pictures and dictation." : "Replies, summaries and everything else AI was used for."}>
					<span className="text-base font-medium tabular-nums">{formatUsd(report.total)}</span>
					<Select value={month} options={months.map((m) => ({ value: m, label: monthLabel(m) }))} onChange={setMonth} />
				</Setting>
			</Settings>
			{report.total === 0 ? (
				<EmptyState icon={<UsageIcon />} title="No usage yet">Nothing has been spent in {monthLabel(month)}.</EmptyState>
			) : (
				<>
					<Breakdown title="By agent" lines={report.byAgent.map((l) => [l.name, l.costUsd])} />
					{!mine && <Breakdown title="By person" lines={report.byPerson.map((l) => [l.name, l.costUsd])} />}
					<Breakdown title="By kind" lines={report.byKind.map((l) => [usageKindLabels[l.kind as UsageKind] ?? l.kind, l.costUsd])} />
					<Breakdown title="By model" lines={report.byModel.map((l) => [l.model, l.costUsd])} />
				</>
			)}
		</>
	);
}

function Breakdown({ title, lines }: { title: string; lines: [string, number][] }) {
	if (lines.length === 0) return null;
	return (
		<Settings title={title}>
			{lines.map(([name, cost], i) => (
				<Setting key={i} label={name}>
					<span className="tabular-nums">{formatUsd(cost)}</span>
				</Setting>
			))}
		</Settings>
	);
}
