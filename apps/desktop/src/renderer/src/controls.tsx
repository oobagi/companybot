import { currencyCodes } from "@companybot/core/records";
import { Fragment, useLayoutEffect, useRef, useState } from "react";
import { CaretUpDownIcon, CheckIcon } from "./icons";
import { compactControlClass, disabledButtonClass } from "./ui";
import { Popover } from "./views/chat/common";

// The app's pickers. One look everywhere: a control with the pick and a caret, opening a
// list in a Popover (the same panel as every menu), a segmented control for a few
// choices side by side, and a checkbox. No native <select>: its menu looks like the OS, not like the app.

export type Option<T extends string = string> = {
	value: T;
	label: string;
	/** A second line under the label. */
	hint?: string;
	disabled?: boolean;
	/** Options with the same group sit under one heading; keep a group's options together. */
	group?: string;
};

/** Long lists get a search box. */
const SEARCH_FROM = 12;

/**
 * Pick one of `options`. `className` styles the button: compact by default; `inputClass` in
 * forms, so it matches the inputs beside it. With `value` matching no option (an "Add…"
 * picker), the button shows `placeholder`.
 */
export function Select<T extends string>({
	value,
	options,
	onChange,
	placeholder = "Pick…",
	label,
	disabled,
	caret = true,
	className = compactControlClass,
}: {
	value: T | undefined;
	options: readonly Option<T>[];
	onChange: (value: T) => void;
	placeholder?: string;
	/** Accessible name and tooltip, when nothing nearby labels it. */
	label?: string;
	disabled?: boolean;
	/** The up-down arrows. Off where a hover border says it's editable (a record's fields). */
	caret?: boolean;
	className?: string;
}) {
	const current = options.find((o) => o.value === value);
	return (
		<Popover
			label={label}
			disabled={disabled}
			matchWidth
			trigger={
				<>
					<span className={`min-w-0 flex-1 truncate ${current ? "" : "text-neutral-400"}`}>{current?.label ?? placeholder}</span>
					{caret && <CaretUpDownIcon className="shrink-0 text-neutral-400" />}
				</>
			}
			className={`inline-flex items-center gap-1.5 text-left ${className}`}
			panelClassName="flex max-w-80 flex-col p-1"
		>
			{(close) => <OptionList options={options} value={value} onPick={(v) => (close(), v !== value && onChange(v))} />}
		</Popover>
	);
}

/** The open list: arrow keys move, Enter picks, and long lists filter as you type. */
function OptionList<T extends string>({ options, value, onPick }: { options: readonly Option<T>[]; value: T | undefined; onPick: (value: T) => void }) {
	const [query, setQuery] = useState("");
	const list = useRef<HTMLDivElement>(null);
	const searchable = options.length >= SEARCH_FROM;
	const words = query.trim().toLowerCase();
	const shown = words ? options.filter((o) => o.label.toLowerCase().includes(words)) : options;
	const items = () => [...(list.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
	// Open on the current pick: scrolled to, and focused unless there's a search box to type in.
	useLayoutEffect(() => {
		const picked = list.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]');
		picked?.scrollIntoView({ block: "nearest" });
		if (!searchable) (picked && !picked.disabled ? picked : items()[0])?.focus();
	}, [searchable]);
	const onKeyDown = (e: React.KeyboardEvent) => {
		if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
		e.preventDefault();
		const all = items();
		const at = all.indexOf(document.activeElement as HTMLButtonElement);
		all[at === -1 ? 0 : Math.min(all.length - 1, Math.max(0, at + (e.key === "ArrowDown" ? 1 : -1)))]?.focus();
	};
	return (
		<div onKeyDown={onKeyDown} className="flex flex-col">
			{searchable && (
				<input
					autoFocus
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), items()[0]?.click())}
					placeholder="Search"
					aria-label="Search options"
					className={`${compactControlClass} sticky top-0 z-10 mb-1 bg-white`}
				/>
			)}
			<div ref={list} role="listbox" className="flex flex-col gap-px">
				{shown.map((o, i) => (
					<Fragment key={o.value}>
						{o.group && o.group !== shown[i - 1]?.group && <p className="px-2 pt-2 pb-1 text-xs font-medium text-neutral-400">{o.group}</p>}
						<button
							type="button"
							role="option"
							aria-selected={o.value === value}
							disabled={o.disabled}
							// Inside a <label> (a form Field), the click would otherwise also "click" the label's
							// first button, the picker itself, and Safari reopens the list.
							onClick={(e) => (e.preventDefault(), onPick(o.value))}
							className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-left outline-none hover:bg-neutral-100 focus-visible:bg-neutral-100 disabled:text-neutral-300 disabled:hover:bg-transparent"
						>
							<span className="min-w-0 flex-1">
								<span className="block truncate">{o.label}</span>
								{o.hint && <span className="block text-xs text-neutral-500">{o.hint}</span>}
							</span>
							{o.value === value && <CheckIcon className="shrink-0 text-neutral-500" />}
						</button>
					</Fragment>
				))}
				{shown.length === 0 && <p className="px-2 py-1.5 text-neutral-400">No matches</p>}
			</div>
		</div>
	);
}

/** A few choices side by side, one on: Table / Board. Same height as the compact controls. */
export function Segmented<T extends string>({
	options,
	value,
	onChange,
	label,
}: {
	options: readonly { value: T; label: string }[];
	value: T;
	/** Called on every click, the current choice included. */
	onChange: (value: T) => void;
	label?: string;
}) {
	return (
		<div role="group" aria-label={label} className="inline-flex max-w-full shrink-0 flex-wrap rounded-lg border border-neutral-200 p-0.5 text-sm">
			{options.map((o) => (
				<button
					key={o.value}
					type="button"
					aria-pressed={o.value === value}
					onClick={() => onChange(o.value)}
					className={`rounded-md px-2.5 py-0.5 ${o.value === value ? "bg-neutral-100 font-medium text-neutral-900" : "text-neutral-500 hover:text-neutral-900"}`}
				>
					{o.label}
				</button>
			))}
		</div>
	);
}

const currencyNames = new Intl.DisplayNames(undefined, { type: "currency" });
/** "EUR — Euro", or just the code where the system has no name for it. */
const currencyLabel = (code: string) => {
	const name = currencyNames.of(code);
	return name && name !== code ? `${code} — ${name}` : code;
};
const currencyOptions = currencyCodes.map((code) => ({ value: code, label: currencyLabel(code) }));

/** Every ISO 4217 code, named: a workspace's default currency (Settings, onboarding). */
export function CurrencySelect({ value, onChange, disabled, className }: { value: string; onChange: (code: string) => void; disabled?: boolean; className?: string }) {
	return <Select className={className} disabled={disabled} value={value} options={currencyOptions} onChange={onChange} />;
}

/**
 * On or off, in the app's look: a rounded box, dark with a check when on. A real checkbox
 * underneath, so the <label> around it (with its text) toggles it and it takes focus.
 */
export function Checkbox({ checked, disabled, onChange, label, className = "" }: { checked: boolean; disabled?: boolean; onChange: (checked: boolean) => void; label?: string; className?: string }) {
	return (
		<span className={`relative inline-flex size-4 shrink-0 ${className}`}>
			<input
				type="checkbox"
				aria-label={label}
				checked={checked}
				disabled={disabled}
				onChange={(e) => onChange(e.target.checked)}
				className={`peer size-4 appearance-none rounded border border-neutral-300 bg-white checked:border-neutral-900 checked:bg-neutral-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-500 ${disabledButtonClass}`}
			/>
			<CheckIcon weight="bold" className="pointer-events-none absolute inset-0 m-auto size-3 text-white opacity-0 peer-checked:opacity-100" />
		</span>
	);
}
