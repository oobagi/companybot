import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import { Checkbox, Select, currencyPickerClass, fieldCellClass, fieldEditClass, fieldPickerClass } from "../../controls";
import { type FieldValue, type Money, TEXT_MAX, currencyCodes, formatMoney, minorDigits } from "@companybot/core/records";
import { useState } from "react";
import { api } from "../../api";
import { useQuery } from "../../convex";
import { navigate } from "../../router";
import { compactControlClass, hintClass, linkButton, trailingAction, useDebounced, useSynced } from "../../ui";
import { MenuItem, Popover } from "../chat/common";
import { useCurrency, useTypes } from "./data";
import { type Refs, type TypeField, moneyInput, recordPath, valueText } from "./logic";
import { CaretUpDownIcon, CloseIcon, PrivateIcon } from "../../icons";

// Showing and editing one field's value, for every kind. Edits save as you leave the
// input (Enter, or clicking away); Escape puts it back.

const empty = "text-neutral-400";

/** A value, read-only. Links open their record; ones to a deleted record say so and don't open. */
export function ValueView({ field, value, refs }: { field: TypeField; value: FieldValue | undefined; refs: Refs }) {
	if (value === undefined) return <span className={empty}>—</span>;
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

export function Chip({ children, onRemove }: { children: React.ReactNode; onRemove?: () => void }) {
	return (
		<span className="flex items-center gap-1 rounded-md bg-neutral-100 px-2 py-0.5 text-sm">
			{children}
			{onRemove && (
				<button type="button" onClick={onRemove} className={`-mr-1 ${trailingAction}`} title="Remove" aria-label="Remove">
					<CloseIcon />
				</button>
			)}
		</span>
	);
}

/**
 * An inline editor for one field. `onSave` gets what to send `records.update` for it:
 * the typed text (the server checks and normalizes it), ids, `{ amount, currency }`, or null to clear.
 */
export function ValueEditor({
	field,
	value,
	refs,
	onSave,
}: {
	field: TypeField;
	value: FieldValue | undefined;
	refs: Refs;
	onSave: (value: unknown) => void;
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
			return <MoneyEditor value={value as Money | undefined} onSave={onSave} />;
		case "choice":
		case "user":
		case "link":
			return field.multiple ? (
				<MultiEditor field={field} ids={(value as string[] | undefined) ?? []} refs={refs} onSave={onSave} />
			) : (
				<OneEditor field={field} id={value as string | undefined} refs={refs} onSave={onSave} />
			);
		default:
			return <TextEditor field={field} value={value === undefined ? "" : String(value)} onSave={onSave} />;
	}
}

/** Text, number, email, phone and web address. Long text wraps onto more lines. */
function TextEditor({ field, value, onSave }: { field: TypeField; value: string; onSave: (value: unknown) => void }) {
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
		className: `${fieldEditClass} placeholder:text-neutral-400`,
	};
	if (field.kind === "text" && field.key !== "name") {
		return <textarea {...common} rows={Math.min(8, Math.max(1, draft.split("\n").length, Math.ceil(draft.length / 60)))} className={`${common.className} resize-none`} />;
	}
	const type = { email: "email", phone: "tel", url: "url", number: "text" }[field.kind as string] ?? "text";
	return <input type={type} inputMode={field.kind === "number" ? "decimal" : undefined} {...common} />;
}

/** An amount and its currency. New amounts start in the workspace's currency. */
function MoneyEditor({ value, onSave }: { value: Money | undefined; onSave: (value: unknown) => void }) {
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
			<Select
				label="Currency"
				value={currency}
				disabled={!amount.trim()}
				options={currencyCodes.map((c) => ({ value: c, label: c }))}
				onChange={(c) => save(amount, c)}
				caret={false}
				className={currencyPickerClass}
			/>
		</span>
	);
}

/** One choice, person or record. A removed option stays shown until it's changed. */
function OneEditor({ field, id, refs, onSave }: { field: TypeField; id: string | undefined; refs: Refs; onSave: (value: unknown) => void }) {
	const options = useOptions(field);
	if (field.kind === "link") {
		return (
			<span className={`${fieldCellClass} gap-2`}>
				{id && <LinkChips field={field} ids={[id]} refs={refs} onRemove={() => onSave(null)} />}
				{/* No database to pick from when it links to one you can't see (linksHidden). */}
				{field.linkType && <RecordPicker typeId={field.linkType} exclude={id ? [id] : []} label={id ? "Change" : "Pick"} caret={false} className={fieldPickerClass} onPick={(picked) => onSave(picked)} />}
			</span>
		);
	}
	const current = id && !options.some((o) => o.id === id) ? { id, label: valueText(field, id, refs) } : null;
	return (
		<Select
			value={id ?? ""}
			placeholder="—"
			caret={false}
			options={[
				...(id ? [{ value: "", label: "Clear" }] : []),
				...(current ? [{ value: current.id, label: current.label, disabled: true }] : []),
				...options.map((o) => ({ value: o.id, label: o.label })),
			]}
			onChange={(v) => onSave(v || null)}
			className={fieldEditClass}
		/>
	);
}

/** Several choices, people or records: chips, each removable, and a way to add one. */
function MultiEditor({ field, ids, refs, onSave }: { field: TypeField; ids: string[]; refs: Refs; onSave: (value: unknown) => void }) {
	const options = useOptions(field).filter((o) => !ids.includes(o.id));
	const remove = (id: string) => onSave(ids.filter((i) => i !== id));
	const add = (id: string) => onSave([...ids, id]);
	return (
		<span className={`${fieldCellClass} flex-wrap gap-1.5`}>
			{field.kind === "link" ? (
				<LinkChips field={field} ids={ids} refs={refs} onRemove={remove} />
			) : (
				ids.map((id) => (
					<Chip key={id} onRemove={() => remove(id)}>
						{valueText(field, id, refs)}
					</Chip>
				))
			)}
			{field.kind === "link" ? (
				field.linkType && <RecordPicker typeId={field.linkType} exclude={ids} label="Add" caret={false} className={fieldPickerClass} onPick={(picked) => add(picked)} />
			) : (
				options.length > 0 && (
					<Select
						value=""
						placeholder="Add…"
						options={options.map((o) => ({ value: o.id, label: o.label }))}
						onChange={add}
						caret={false}
						className={fieldPickerClass}
					/>
				)
			)}
		</span>
	);
}

/** What a choice or person field can be set to: live options, or the workspace's people. */
export function useOptions(field: TypeField): { id: string; label: string }[] {
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
