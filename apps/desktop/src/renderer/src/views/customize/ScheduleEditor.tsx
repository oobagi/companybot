import {
	type MonthDay,
	type ScheduleForm,
	allDays,
	dayNames,
	describeCron,
	formCron,
	nextRuns,
	nthNames,
	scheduleError,
	scheduleForm,
} from "@companybot/core/schedules";
import { useRef, useState } from "react";
import { Select } from "../../controls";
import { CloseIcon, PlusIcon } from "../../icons";
import { compactButton, compactControlClass, descriptionClass, hintClass } from "../../ui";

// A schedule is a cron expression, always shown and editable. The form above it is a friendlier
// way to write the same cron: each control rewrites it, and typing a cron refills the controls.
// A cron the form can't show still runs; the form says so and stays out of the way.

type Repeats = ScheduleForm["repeats"];

const repeatOptions: { value: Repeats; label: string }[] = [
	{ value: "hours", label: "Every few hours" },
	{ value: "daily", label: "Daily" },
	{ value: "weekly", label: "Weekly" },
	{ value: "monthly", label: "Monthly" },
];

const dayLetters = ["S", "M", "T", "W", "T", "F", "S"];
const pad = (n: number) => String(n).padStart(2, "0");

/** "9:00 AM" or "09:00", as the person's computer writes times. */
const localTime = (time: string) => {
	const [h, m] = time.split(":").map(Number) as [number, number];
	return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", timeZone: "UTC" }).format(Date.UTC(2000, 0, 1, h, m));
};

/** The form when switching to `repeats`, keeping what carries over. */
function switchTo(repeats: Repeats, from: ScheduleForm | null): ScheduleForm {
	const times = !from ? ["09:00"] : from.repeats === "hours" ? [`${pad(from.from)}:${pad(from.minute)}`] : from.times;
	const days = from && from.repeats !== "monthly" ? from.days : [1, 2, 3, 4, 5];
	if (repeats === "hours") {
		const start = Number(times[0]!.slice(0, 2));
		return { repeats, every: 2, from: start, to: Math.min(23, Math.max(start + 2, 17)), minute: 0, days };
	}
	if (repeats === "daily") return { repeats, times, days: allDays };
	if (repeats === "weekly") return { repeats, times, days: days.length === 1 ? days : [1] };
	return { repeats, on: 1, times: times.slice(0, 1) };
}

export function ScheduleEditor({ cron, onChange, timeZone }: { cron: string; onChange: (cron: string) => void; timeZone: string }) {
	// Keeps daily/weekly and the kind picked, so the form doesn't jump as days change.
	const [prefer, setPrefer] = useState<Repeats>();
	// A form edit that can't be one cron (no days, mixed minutes) shows as-is, with why, until fixed.
	const [draft, setDraft] = useState<{ form: ScheduleForm; error: string } | null>(null);
	const error = scheduleError(cron);
	const parsed = error ? null : scheduleForm(cron, prefer);
	// While a typed cron is half-written, the controls keep the last schedule they showed.
	const lastGood = useRef<ScheduleForm | null>(parsed);
	if (!error) lastGood.current = parsed;
	const form = draft?.form ?? (error ? lastGood.current : parsed);

	const edit = (next: ScheduleForm) => {
		setPrefer(next.repeats);
		const written = formCron(next);
		if (typeof written === "string") {
			setDraft(null);
			onChange(written);
		} else setDraft({ form: next, error: written.error });
	};

	return (
		<div className="flex flex-col gap-3">
			<div className="flex flex-wrap items-center gap-2 text-sm">
				<span className="text-neutral-500">Repeats</span>
				<Select
					label="Repeats"
					value={form?.repeats}
					placeholder="Pick one…"
					options={repeatOptions}
					onChange={(repeats) => edit(switchTo(repeats, form))}
				/>
				{!form && <span className={hintClass}>This schedule is only editable as cron.</span>}
			</div>
			{form && <FormFields form={form} onChange={edit} />}
			{draft && <p className="text-sm text-red-600">{draft.error}</p>}
			<CronField cron={cron} error={error} timeZone={timeZone} onChange={(text) => (setDraft(null), setPrefer(undefined), onChange(text))} />
		</div>
	);
}

/** The sentence for each kind: "Every [2] hours from [8 AM] to [6 PM]", "At [9:00] [+ Add time]"… */
function FormFields({ form, onChange }: { form: ScheduleForm; onChange: (form: ScheduleForm) => void }) {
	const row = "flex flex-wrap items-center gap-2 text-sm";
	const word = "text-neutral-500";
	if (form.repeats === "hours") {
		const hourOptions = Array.from({ length: 24 }, (_, h) => ({ value: String(h), label: localTime(`${pad(h)}:${pad(form.minute)}`) }));
		const everyOptions = [...new Set([1, 2, 3, 4, 6, 8, 12, form.every])].sort((a, b) => a - b).map((n) => ({ value: String(n), label: String(n) }));
		return (
			<>
				<div className={row}>
					<span className={word}>Every</span>
					<Select label="Hours between runs" value={String(form.every)} options={everyOptions} onChange={(n) => onChange({ ...form, every: Number(n) })} />
					<span className={word}>{form.every === 1 ? "hour from" : "hours from"}</span>
					<Select label="From" value={String(form.from)} options={hourOptions} onChange={(h) => onChange({ ...form, from: Number(h) })} />
					<span className={word}>to</span>
					<Select label="To" value={String(form.to)} options={hourOptions} onChange={(h) => onChange({ ...form, to: Number(h) })} />
				</div>
				<div className={row}>
					<span className={word}>On</span>
					<DayToggles days={form.days} onChange={(days) => onChange({ ...form, days })} />
				</div>
			</>
		);
	}
	const times = <Times times={form.times} onChange={(times) => onChange({ ...form, times })} />;
	if (form.repeats === "monthly")
		return (
			<div className={row}>
				<span className={word}>On the</span>
				<MonthDayPicker on={form.on} onChange={(on) => onChange({ ...form, on })} />
				<span className={word}>at</span>
				{times}
			</div>
		);
	return (
		<>
			<div className={row}>
				<span className={word}>On</span>
				<DayToggles days={form.days} onChange={(days) => onChange({ ...form, days })} />
			</div>
			<div className={row}>
				<span className={word}>At</span>
				{times}
			</div>
		</>
	);
}

function DayToggles({ days, onChange }: { days: number[]; onChange: (days: number[]) => void }) {
	return (
		<div className="flex gap-1">
			{dayLetters.map((d, i) => {
				const on = days.includes(i);
				return (
					<button
						key={dayNames[i]}
						type="button"
						title={dayNames[i]}
						aria-label={dayNames[i]}
						aria-pressed={on}
						className={`size-8 rounded-full text-sm ${on ? "bg-neutral-900 text-white" : "border border-neutral-200 text-neutral-600 hover:bg-neutral-50"}`}
						onClick={() => onChange(on ? days.filter((x) => x !== i) : [...days, i].sort((a, b) => a - b))}
					>
						{d}
					</button>
				);
			})}
		</div>
	);
}

/** One time input per time, each removable while there's another, and "Add time". */
function Times({ times, onChange }: { times: string[]; onChange: (times: string[]) => void }) {
	const set = (i: number, time: string) => time && onChange(times.map((t, j) => (j === i ? time : t)));
	// A new time an hour after the last, at the same minutes, so it fits the same cron.
	const add = () => {
		const last = times.at(-1) ?? "09:00";
		const used = new Set(times.map((t) => t.slice(0, 2)));
		const hour = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23]
			.map((step) => (Number(last.slice(0, 2)) + step) % 24)
			.find((h) => !used.has(pad(h)));
		if (hour !== undefined) onChange([...times, `${pad(hour)}${last.slice(2)}`]);
	};
	return (
		<>
			{times.map((time, i) => (
				<span key={i} className="inline-flex items-center gap-0.5">
					<input type="time" aria-label="Time" className={compactControlClass} value={time} onChange={(e) => set(i, e.target.value)} />
					{times.length > 1 && (
						<button
							type="button"
							title="Remove this time"
							aria-label="Remove this time"
							className="rounded-md p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700"
							onClick={() => onChange(times.filter((_, j) => j !== i))}
						>
							<CloseIcon />
						</button>
					)}
				</span>
			))}
			{times.length < 24 && (
				<button type="button" className={compactButton} onClick={add}>
					<PlusIcon /> Add time
				</button>
			)}
		</>
	);
}

const ordinal = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th"}`;

const monthOptions = [
	...Array.from({ length: 31 }, (_, i) => ({ value: `day:${i + 1}`, label: ordinal(i + 1), group: "Day of the month" })),
	...(["1", "2", "3", "4", "last"] as const).map((n) => ({ value: `nth:${n}`, label: nthNames[n === "last" ? n : (Number(n) as 1 | 2 | 3 | 4)], group: "A weekday" })),
];

/** "1st"… "31st", or "first"… "last" plus a weekday. */
function MonthDayPicker({ on, onChange }: { on: MonthDay; onChange: (on: MonthDay) => void }) {
	const value = typeof on === "number" ? `day:${on}` : `nth:${on.nth}`;
	return (
		<>
			<Select
				label="Day of the month"
				value={value}
				options={monthOptions}
				onChange={(v) => {
					const [kind, n] = v.split(":") as [string, string];
					if (kind === "day") onChange(Number(n));
					else onChange({ nth: n === "last" ? "last" : (Number(n) as 1 | 2 | 3 | 4), weekday: typeof on === "number" ? 1 : on.weekday });
				}}
			/>
			{typeof on !== "number" && (
				<Select
					label="Weekday"
					value={String(on.weekday)}
					options={dayNames.map((name, i) => ({ value: String(i), label: name }))}
					onChange={(d) => onChange({ ...on, weekday: Number(d) })}
				/>
			)}
		</>
	);
}

/** The cron itself, with what it means and when it runs next. */
function CronField({ cron, error, timeZone, onChange }: { cron: string; error: string | null; timeZone: string; onChange: (cron: string) => void }) {
	const runs = error ? [] : nextRuns(cron, timeZone, Date.now(), 3);
	const day = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric", timeZone });
	const time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", timeZone });
	// "Mon, Nov 2, 9:00 AM · 1:00 PM · Tue, Nov 3, 9:00 AM": the day once, then its times.
	const next = runs.map((at, i) => (i > 0 && day.format(at) === day.format(runs[i - 1]!) ? time.format(at) : `${day.format(at)}, ${time.format(at)}`));
	const elsewhere = timeZone !== Intl.DateTimeFormat().resolvedOptions().timeZone;
	return (
		<div className="flex flex-col gap-1.5 rounded-xl bg-neutral-50 px-3 py-2.5">
			<div className="flex items-center gap-2">
				<label htmlFor="schedule-cron" className="text-sm text-neutral-500">
					Cron
				</label>
				<input
					id="schedule-cron"
					className={`${compactControlClass} min-w-0 flex-1 bg-white font-mono`}
					value={cron}
					spellCheck={false}
					autoComplete="off"
					aria-invalid={!!error}
					onChange={(e) => onChange(e.target.value)}
				/>
			</div>
			{error ? (
				<p className="text-sm text-red-600">{error}</p>
			) : (
				<>
					<p className="text-sm font-medium text-neutral-800">{describeCron(cron, localTime)}</p>
					<p className={descriptionClass}>
						Next: {next.join(" · ")}
						{elsewhere && ` (${timeZone})`}
					</p>
				</>
			)}
		</div>
	);
}
