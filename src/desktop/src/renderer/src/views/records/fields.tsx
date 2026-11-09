import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import { Checkbox, Select, currencyPickerClass, fieldCellClass, fieldEditClass, fieldPickerClass } from "../../controls";
import { type FieldIconId, type FieldKind, type FieldValue, type Money, type OptionColor, TEXT_MAX, currencyCodes, formatMoney, minorDigits } from "@companybot/core/records";
import { useState } from "react";
import { api } from "../../api";
import { useQuery } from "../../convex";
import { navigate } from "../../router";
import { bareIconButton, compactControlClass, hintClass, linkButton, useDebounced, useSynced } from "../../ui";
import { MenuItem, Popover } from "../chat/common";
import { useCurrency, useTypes } from "./data";
import { type Refs, type TypeField, moneyInput, recordPath, valueText } from "./logic";
import { AmountIcon, CalendarIcon, CaretUpDownIcon, CheckboxIcon, ChoiceIcon, CloseIcon, EmailIcon, LinkFieldIcon, NumberIcon, PhoneIcon, PrivateIcon, TextIcon, UserIcon, WebsiteIcon, fieldIconSet } from "../../icons";

// Showing and editing one field's value, for every kind. Edits save as you leave the
// input (Enter, or clicking away); Escape puts it back.

const empty = "text-neutral-400";

/** A value, read-only. Links open their record; ones to a deleted record say so and don't open. */
export function ValueView({ field, value, refs }: { field: TypeField; value: FieldValue | undefined; refs: Refs }) {
	if (value === undefined) return <span className={empty}>—</span>;
	if (field.kind === "choice") return <ChoiceChips field={field} ids={[value].flat().map(String)} />;
	if (field.kind === "link") return <LinkChips field={field} ids={[value].flat().map(String)} refs={refs} />;
	if (field.kind === "url") {
		return (
			<a href={String(value)} target="_blank" rel="noreferrer" className="break-all hover:underline">
				{String(value).replace(/^https?:\/\//, "")}
			</a>
		);
	}
	return <span className="break-words whitespace-pre-wrap">{valueText(field, value, refs)}</span>;
}

function LinkChips({ field, ids, refs, onRemove }: { field: TypeField; ids: string[]; refs: Refs; onRemove?: (id: string) => void }) {
	const types = useTypes();
	const key = types?.find((t) => t._id === field.linkType)?.key;
	return (
		<span className="flex flex-wrap gap-1.5">
			{ids.map((id) => (
				<Chip key={id} onRemove={onRemove && (() => onRemove(id))}>
					{refs[id]?.locked ? (
						// In a database you can't see: no name, nothing to open.
						<span className="flex items-center gap-1 text-neutral-400" title="Only some roles can see this record">
							<PrivateIcon /> Locked
						</span>
					) : refs[id]?.archived ? (
						<span className="text-neutral-400">{valueText(field, id, refs)}</span>
					) : (
						<button type="button" onClick={() => key && navigate(...recordPath(key, id))} className={linkButton}>
							{valueText(field, id, refs)}
						</button>
					)}
				</Chip>
			))}
		</span>
	);
}

/**
 * Choice option tints, Notion's: a soft background with dark text in its hue, so a colored chip
 * reads as calmly as a gray one. Tokens in styles.css (`--color-option-*`).
 */
const optionTints: Record<OptionColor, string> = {
	default: "bg-neutral-100 text-neutral-800",
	gray: "bg-neutral-200/80 text-neutral-700",
	brown: "bg-option-brown text-option-brown-ink",
	orange: "bg-option-orange text-option-orange-ink",
	yellow: "bg-option-yellow text-option-yellow-ink",
	green: "bg-option-green text-option-green-ink",
	blue: "bg-option-blue text-option-blue-ink",
	purple: "bg-option-purple text-option-purple-ink",
	pink: "bg-option-pink text-option-pink-ink",
	red: "bg-option-red text-option-red-ink",
};

/** An option's tint; options from before colors, and unknown colors, are `default`. */
export const tintOf = (color?: string) => optionTints[color as OptionColor] ?? optionTints.default;

/** A choice field's values as chips in their options' colors. */
export function ChoiceChips({ field, ids }: { field: TypeField; ids: string[] }) {
	return (
		<span className="flex flex-wrap gap-1.5">
			{ids.map((id) => (
				<Chip key={id} color={field.options?.find((o) => o.id === id)?.color}>
					<span className="truncate">{valueText(field, id)}</span>
				</Chip>
			))}
		</span>
	);
}

/** A value as a chip: a pick, a person, a linked record. `color`: a choice option's (`optionColors`). */
export function Chip({ children, color, onRemove }: { children: React.ReactNode; color?: string; onRemove?: () => void }) {
	return (
		<span className={`flex max-w-full items-center gap-1 rounded-md px-1.5 text-sm leading-5 ${tintOf(color)}`}>
			{children}
			{onRemove && (
				<button type="button" onClick={onRemove} className={bareIconButton} title="Remove" aria-label="Remove">
					<CloseIcon />
				</button>
			)}
		</span>
	);
}

/**
 * An inline editor for one field. `onSave` gets what to send `records.update` for it:
 * the typed text (the server checks and normalizes it), ids, `{ amount, currency }`, or null to clear.
 * `oneLine` (a table cell) keeps it to one line: long text scrolls instead of wrapping, and an
 * amount leaves its currency to the record page. `autoFocus`: a text value's box starts focused.
 */
export function ValueEditor({
	field,
	value,
	refs,
	onSave,
	oneLine = false,
	autoFocus = false,
}: {
	field: TypeField;
	value: FieldValue | undefined;
	refs: Refs;
	onSave: (value: unknown) => void;
	oneLine?: boolean;
	autoFocus?: boolean;
}) {
	switch (field.kind) {
		case "checkbox":
			return (
				<label className={fieldCellClass}>
					<Checkbox label={field.label} checked={value === true} onChange={onSave} />
				</label>
			);
		case "date":
			return (
				<input
					type="date"
					value={typeof value === "string" ? value : ""}
					onChange={(e) => onSave(e.target.value || null)}
					className={fieldEditClass}
				/>
			);
		case "currency":
			return <MoneyEditor value={value as Money | undefined} onSave={onSave} oneLine={oneLine} />;
		case "choice":
		case "user":
		case "link":
			return <PickEditor field={field} ids={value === undefined ? [] : [value].flat().map(String)} refs={refs} onSave={onSave} />;
		default:
			return <TextEditor field={field} value={value === undefined ? "" : String(value)} onSave={onSave} oneLine={oneLine} autoFocus={autoFocus} />;
	}
}

/** Text, number, email, phone and web address. Long text wraps onto more lines, unless `oneLine`. */
function TextEditor({ field, value, onSave, oneLine, autoFocus }: { field: TypeField; value: string; onSave: (value: unknown) => void; oneLine: boolean; autoFocus: boolean }) {
	const [draft, setDraft] = useSynced(value);
	const commit = () => draft.trim() !== value && onSave(draft.trim() || null);
	const keys = (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
		if (e.key === "Escape") setDraft(value);
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			e.currentTarget.blur();
		}
	};
	const common = {
		value: draft,
		onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setDraft(e.target.value),
		onBlur: commit,
		onKeyDown: keys,
		maxLength: TEXT_MAX,
		placeholder: "—",
		autoFocus,
		className: `${fieldEditClass} placeholder:text-neutral-400 ${oneLine ? "truncate" : ""}`,
	};
	if (field.kind === "text" && field.key !== "name" && !oneLine) {
		return <textarea {...common} rows={Math.min(8, Math.max(1, draft.split("\n").length, Math.ceil(draft.length / 60)))} className={`${common.className} resize-none`} />;
	}
	const type = { email: "email", phone: "tel", url: "url", number: "text" }[field.kind as string] ?? "text";
	return <input type={type} inputMode={field.kind === "number" ? "decimal" : undefined} {...common} />;
}

/** An amount and its currency. New amounts start in the workspace's currency. */
function MoneyEditor({ value, onSave, oneLine }: { value: Money | undefined; onSave: (value: unknown) => void; oneLine: boolean }) {
	const workspaceCurrency = useCurrency();
	const currency = value?.currency ?? workspaceCurrency;
	const saved = moneyInput(value, minorDigits(currency));
	const [amount, setAmount] = useSynced(saved);
	// Shown formatted ("$14,500.00") until you click in to change it.
	const [focused, setFocused] = useState(false);
	const save = (text: string, code: string) => onSave(text.trim() ? { amount: text.trim(), currency: code } : null);
	return (
		<span className="flex items-center gap-1">
			<input
				inputMode="decimal"
				value={focused || !value ? amount : formatMoney(value)}
				placeholder="—"
				onChange={(e) => setAmount(e.target.value)}
				onFocus={() => setFocused(true)}
				onBlur={() => {
					setFocused(false);
					if (amount.trim() !== saved) save(amount, currency);
				}}
				onKeyDown={(e) => {
					if (e.key === "Escape") setAmount(saved);
					if (e.key === "Enter") e.currentTarget.blur();
				}}
				className={`${fieldEditClass} placeholder:text-neutral-400`}
			/>
			{!oneLine && <Select
				label="Currency"
				value={currency}
				disabled={!amount.trim()}
				options={currencyCodes.map((c) => ({ value: c, label: c }))}
				onChange={(c) => save(amount, c)}
				caret={false}
				className={currencyPickerClass}
			/>}
		</span>
	);
}

/**
 * A choice, person or record field, one or several, Notion's way: the whole cell is the button,
 * showing the picks as chips (or — when empty). It opens a panel to remove picks and add others.
 * One pick replaces the last and closes; several stay open to keep adding.
 */
function PickEditor({ field, ids, refs, onSave }: { field: TypeField; ids: string[]; refs: Refs; onSave: (value: unknown) => void }) {
	const options = useOptions(field);
	const save = (next: string[]) => onSave(field.multiple ? next : (next[0] ?? null));
	const label = (id: string) => (refs[id]?.locked ? "Locked" : valueText(field, id, refs));
	const color = (id: string) => field.options?.find((o) => o.id === id)?.color;
	return (
		<Popover
			trigger={
				ids.length ? (
					ids.map((id) => <Chip key={id} color={color(id)}><span className="truncate">{label(id)}</span></Chip>)
				) : (
					<span className="text-neutral-400">—</span>
				)
			}
			className={`${fieldEditClass} flex-wrap gap-1.5 text-left`}
			panelClassName="flex w-64 flex-col gap-1 p-2"
		>
			{(close) => {
				const pick = (id: string) => (field.multiple ? save([...ids, id]) : (save([id]), close()));
				return (
					<>
						{ids.length > 0 && (
							<span className="flex flex-wrap gap-1.5 px-1 pb-1">
								{field.kind === "link" ? (
									<LinkChips field={field} ids={ids} refs={refs} onRemove={(id) => save(ids.filter((i) => i !== id))} />
								) : (
									ids.map((id) => <Chip key={id} color={color(id)} onRemove={() => save(ids.filter((i) => i !== id))}>{label(id)}</Chip>)
								)}
							</span>
						)}
						{field.kind === "link" ? (
							// No database to pick from when it links to one you can't see (linksHidden).
							field.linkType && <RecordSearch typeId={field.linkType} exclude={ids} onPick={pick} />
						) : (
							options
								.filter((o) => !ids.includes(o.id))
								.map((o) => (
									<MenuItem key={o.id} onClick={() => pick(o.id)}>
										{field.kind === "choice" ? <Chip color={o.color}><span className="truncate">{o.label}</span></Chip> : <span className="min-w-0 truncate">{o.label}</span>}
									</MenuItem>
								))
						)}
						{field.kind !== "link" && options.every((o) => ids.includes(o.id)) && <span className={`px-2 py-1 ${hintClass}`}>{options.length ? "All picked." : "No options yet."}</span>}
					</>
				);
			}}
		</Popover>
	);
}

/** What a choice or person field can be set to: live options, or the workspace's people. */
export function useOptions(field: TypeField): { id: string; label: string; color?: string }[] {
	const team = useQuery(api.workspace.team, field.kind === "user" ? {} : "skip");
	if (field.kind === "user") return team?.members.map((m) => ({ id: m.userId, label: m.name || m.email })) ?? [];
	return field.options?.filter((o) => !o.retired) ?? [];
}

/** Find a live record of one type by name and pick it. */
export function RecordPicker({
	typeId,
	exclude = [],
	label,
	caret = true,
	className = `inline-flex items-center gap-1.5 text-left ${compactControlClass}`,
	onPick,
}: {
	typeId: string;
	exclude?: string[];
	label: string;
	/** Off in a record's fields, where a hover border says it's editable (as their Selects). */
	caret?: boolean;
	className?: string;
	onPick: (id: string, title: string) => void;
}) {
	return (
		<Popover
			trigger={
				<>
					<span className="min-w-0 flex-1 truncate text-neutral-400">{label}…</span>
					{caret && <CaretUpDownIcon className="shrink-0 text-neutral-400" />}
				</>
			}
			className={className}
			panelClassName="flex w-64 flex-col gap-1 p-2"
		>
			{(close) => <RecordSearch typeId={typeId} exclude={exclude} onPick={(id, title) => (close(), onPick(id, title))} />}
		</Popover>
	);
}

function RecordSearch({ typeId, exclude, onPick }: { typeId: string; exclude: string[]; onPick: (id: string, title: string) => void }) {
	const [query, setQuery] = useState("");
	const settled = useDebounced(query);
	const results = useQuery(api.records.search, settled.trim() ? { query: settled, typeId: typeId as Id<"recordTypes"> } : "skip");
	return (
		<>
			<input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by name" className={compactControlClass} />
			{results
				?.filter((r) => !exclude.includes(r._id))
				.map((r) => (
					<MenuItem key={r._id} onClick={() => onPick(r._id, r.title)}>
						<span className="min-w-0 truncate text-sm">{r.title}</span>
					</MenuItem>
				))}
			{results?.length === 0 && <span className={`px-2 py-1 ${hintClass}`}>No matches.</span>}
		</>
	);
}

const kindIcons: Record<FieldKind, typeof TextIcon> = {
	text: TextIcon,
	number: NumberIcon,
	currency: AmountIcon,
	date: CalendarIcon,
	checkbox: CheckboxIcon,
	choice: ChoiceIcon,
	email: EmailIcon,
	phone: PhoneIcon,
	url: WebsiteIcon,
	user: UserIcon,
	link: LinkFieldIcon,
};

/** A field's icon beside its name, like Notion's properties: the one picked for it, else its kind's. */
export function FieldIcon({ field, large, className = "" }: { field: { kind: FieldKind; icon?: string }; large?: boolean; className?: string }) {
	const Icon = fieldIconSet[field.icon as FieldIconId] ?? kindIcons[field.kind];
	// `large` beside body-sized text (a record's properties): a touch bigger than the text and darker, so it doesn't look faint.
	return <Icon className={`shrink-0 ${large ? "size-[1.125em] text-neutral-500" : "text-neutral-400"} ${className}`} />;
}
