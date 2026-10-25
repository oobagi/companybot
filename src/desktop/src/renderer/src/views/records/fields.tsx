import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import { type FieldValue, type Money, TEXT_MAX, currencyCodes, formatMoney, minorDigits } from "@companybot/core/records";
import { useQuery } from "convex-helpers/react/cache";
import { useEffect, useState } from "react";
import { api } from "../../api";
import { navigate } from "../../router";
import { useDismiss } from "../chat/common";
import { useCurrency, useTypes } from "./data";
import { type Refs, type TypeField, moneyInput, recordPath, valueText } from "./logic";

// Showing and editing one field's value, for every kind. Edits save as you leave the
// input (Enter, or clicking away); Escape puts it back.

const editable = "w-full rounded-lg border border-transparent px-2 py-1 outline-none hover:border-neutral-200 focus:border-neutral-400";

/** A value, read-only. Links open their record; archived ones say so. */
export function ValueView({ field, value, refs }: { field: TypeField; value: FieldValue | undefined; refs: Refs }) {
	if (value === undefined) return <span className="text-neutral-300">—</span>;
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
					<button
						type="button"
						onClick={() => key && navigate(...recordPath(key, id))}
						className={`hover:underline ${refs[id]?.archived ? "text-neutral-400" : ""}`}
					>
						{valueText(field, id, refs)}
					</button>
				</Chip>
			))}
		</span>
	);
}

function Chip({ children, onRemove }: { children: React.ReactNode; onRemove?: () => void }) {
	return (
		<span className="flex items-center gap-1 rounded-md bg-neutral-100 px-2 py-0.5 text-sm">
			{children}
			{onRemove && (
				<button type="button" onClick={onRemove} className="text-neutral-400 hover:text-neutral-700" aria-label="Remove">
					×
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
				<label className="flex items-center px-2 py-1">
					<input type="checkbox" checked={value === true} onChange={(e) => onSave(e.target.checked)} />
				</label>
			);
		case "date":
			return (
				<input
					type="date"
					value={typeof value === "string" ? value : ""}
					onChange={(e) => onSave(e.target.value || null)}
					className={editable}
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
	const [draft, setDraft] = useState(value);
	useEffect(() => setDraft(value), [value]);
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
		className: `${editable} placeholder:text-neutral-300`,
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
	const [amount, setAmount] = useState(saved);
	// Shown formatted ("$14,500.00") until you click in to change it.
	const [focused, setFocused] = useState(false);
	useEffect(() => setAmount(saved), [saved]);
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
				className={`${editable} placeholder:text-neutral-300`}
			/>
			<select
				value={currency}
				disabled={!amount.trim()}
				onChange={(e) => save(amount, e.target.value)}
				title="Currency"
				className="rounded-lg border border-transparent py-1 text-sm text-neutral-500 hover:border-neutral-200"
			>
				{currencyCodes.map((c) => (
					<option key={c}>{c}</option>
				))}
			</select>
		</span>
	);
}

/** One choice, person or record. A removed option stays shown until it's changed. */
function OneEditor({ field, id, refs, onSave }: { field: TypeField; id: string | undefined; refs: Refs; onSave: (value: unknown) => void }) {
	const options = useOptions(field);
	if (field.kind === "link") {
		return (
			<span className="flex items-center gap-2 px-2 py-1">
				{id && <LinkChips field={field} ids={[id]} refs={refs} onRemove={() => onSave(null)} />}
				<RecordPicker typeId={field.linkType!} exclude={id ? [id] : []} label={id ? "Change" : "Pick"} onPick={(picked) => onSave(picked)} />
			</span>
		);
	}
	const current = id && !options.some((o) => o.id === id) ? { id, label: valueText(field, id, refs) } : null;
	return (
		<select value={id ?? ""} onChange={(e) => onSave(e.target.value || null)} className={editable}>
			<option value="">—</option>
			{current && (
				<option value={current.id} disabled>
					{current.label}
				</option>
			)}
			{options.map((o) => (
				<option key={o.id} value={o.id}>
					{o.label}
				</option>
			))}
		</select>
	);
}

/** Several choices, people or records: chips, each removable, and a way to add one. */
function MultiEditor({ field, ids, refs, onSave }: { field: TypeField; ids: string[]; refs: Refs; onSave: (value: unknown) => void }) {
	const options = useOptions(field).filter((o) => !ids.includes(o.id));
	const remove = (id: string) => onSave(ids.filter((i) => i !== id));
	const add = (id: string) => onSave([...ids, id]);
	return (
		<span className="flex flex-wrap items-center gap-1.5 px-2 py-1">
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
				<RecordPicker typeId={field.linkType!} exclude={ids} label="Add" onPick={(picked) => add(picked)} />
			) : (
				options.length > 0 && (
					<select value="" onChange={(e) => e.target.value && add(e.target.value)} className="rounded-md text-sm text-neutral-500">
						<option value="">Add…</option>
						{options.map((o) => (
							<option key={o.id} value={o.id}>
								{o.label}
							</option>
						))}
					</select>
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
	onPick,
}: {
	typeId: string;
	exclude?: string[];
	label: string;
	onPick: (id: string, title: string) => void;
}) {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const ref = useDismiss<HTMLSpanElement>(() => setOpen(false), open);
	const results = useQuery(api.records.search, open && query.trim() ? { query, typeId: typeId as Id<"recordTypes"> } : "skip");
	const pick = (id: string, title: string) => {
		onPick(id, title);
		setOpen(false);
		setQuery("");
	};
	return (
		<span ref={ref} className="relative">
			<button type="button" onClick={() => setOpen(!open)} className="text-sm text-neutral-400 hover:text-neutral-700">
				{label}…
			</button>
			{open && (
				<span className="absolute top-full left-0 z-20 mt-1 flex w-64 flex-col gap-1 rounded-xl border border-neutral-200 bg-white p-2 shadow-lg">
					<input
						autoFocus
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						placeholder="Search by name"
						className="rounded-lg border border-neutral-200 px-2 py-1 text-sm outline-none focus:border-neutral-400"
					/>
					{results
						?.filter((r) => !exclude.includes(r._id))
						.map((r) => (
							<button key={r._id} type="button" onClick={() => pick(r._id, r.title)} className="truncate rounded-md px-2 py-1 text-left text-sm hover:bg-neutral-100">
								{r.title}
							</button>
						))}
					{results?.length === 0 && <span className="px-2 py-1 text-sm text-neutral-400">No matches.</span>}
				</span>
			)}
		</span>
	);
}
