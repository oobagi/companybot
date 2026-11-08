import { NAME_KEY } from "@companybot/core/records";
import { useEffect, useRef, useState } from "react";
import { ArchiveIcon, BoardIcon, CalendarIcon, CaretLeftIcon, CaretRightIcon, CheckIcon, CopyIcon, DatabaseIcon, DragHandleIcon, EditIcon, FormIcon, GalleryIcon, GroupIcon, HideIcon, MoreIcon, PlusIcon, PropertiesIcon, ShowIcon, TrashIcon } from "../../icons";
import { useDragList } from "../../sortable";
import { MenuDivider, compactControlClass, linkButton, smallIconButton, toolButton } from "../../ui";
import { MenuItem, Popover } from "../chat/common";
import { FieldIcon } from "./fields";
import { type TypeField, kindLabels } from "./logic";

// A database view's settings, like Notion's ⋯: its layout, which properties it shows and in what order,
// its grouping, and the view itself (rename, duplicate, delete). Each setting is a page of the one menu.

export type LayoutChoice = "table" | "board" | "calendar" | "form" | "gallery";

/** Every layout: the ones in use, and the coming-soon ones, marked. */
const layoutOptions = [
	{ value: "table", label: "Table", icon: <DatabaseIcon />, soon: false },
	{ value: "board", label: "Board", icon: <BoardIcon />, soon: false },
	{ value: "calendar", label: "Calendar", icon: <CalendarIcon />, soon: true },
	{ value: "form", label: "Form", icon: <FormIcon />, soon: true },
	{ value: "gallery", label: "Gallery", icon: <GalleryIcon />, soon: true },
] as const;

type Page = "main" | "layout" | "properties" | "group" | { field: string };

/** Each part is there only for whoever may change it. */
export type ViewMenuProps = {
	/** A saved view, for whoever may edit it. */
	view?: { name: string; onRename: (name: string) => void; onDuplicate: () => void; onDelete: () => void };
	layout?: { value: LayoutChoice; onChange: (layout: LayoutChoice) => void };
	properties?: {
		fields: TypeField[];
		/** Shown, in order. */
		columns: string[];
		/** Showing or hiding some. */
		onChange: (columns: string[]) => void;
		/** One moved, before another shown one (null: last). */
		onMove: (key: string, before: string | null) => void;
		/** "board" or "table", for "Shown on board". */
		where: string;
	};
	group?: { fields: TypeField[]; value: TypeField; onChange: (key: string) => void };
	onEditDatabase?: () => void;
	onNewField?: () => void;
	/** The field's full settings (its kind, options), in their dialog. */
	onEditField: (field: TypeField) => void;
	/** Renames a field; its errors show on the page, since the menu may be gone by then. */
	onRenameField: (field: TypeField, label: string) => void;
	/** Archives a field (asked first). */
	onArchiveField: (field: TypeField) => void;
};

export function ViewMenu(props: ViewMenuProps) {
	const { view, layout, properties, group, onEditDatabase } = props;
	if (!view && !layout && !properties && !group && !onEditDatabase) return null;
	return (
		<Popover label="View settings" trigger={<MoreIcon />} className={toolButton} panelClassName="flex w-64 flex-col gap-px p-1">
			{(close) => <Pages {...props} close={close} />}
		</Popover>
	);
}

function Pages({ close, ...props }: ViewMenuProps & { close: () => void }) {
	const [page, setPage] = useState<Page>("main");
	const { layout, properties, group } = props;
	if (page === "layout" && layout)
		return (
			<>
				<Back label="Layout" onBack={() => setPage("main")} />
				{layoutOptions.map((o) => (
					<MenuItem key={o.value} onClick={() => (close(), layout.onChange(o.value))}>
						<span className="text-neutral-400">{o.icon}</span>
						<span className="flex-1">{o.label}</span>
						{o.soon ? <span className="text-xs text-neutral-400">Soon</span> : o.value === layout.value && <CheckIcon className="text-neutral-500" />}
					</MenuItem>
				))}
			</>
		);
	if (page === "group" && group)
		return (
			<>
				<Back label="Group by" onBack={() => setPage("main")} />
				{group.fields.map((f) => (
					<MenuItem key={f.key} onClick={() => (close(), group.onChange(f.key))}>
						<FieldIcon field={f} />
						<span className="flex-1 truncate">{f.label}</span>
						{f.key === group.value.key && <CheckIcon className="text-neutral-500" />}
					</MenuItem>
				))}
			</>
		);
	if (page === "properties" && properties) return <PropertiesPage {...props} properties={properties} close={close} onBack={() => setPage("main")} onOpen={(key) => setPage({ field: key })} />;
	if (typeof page === "object" && properties) {
		const field = properties.fields.find((f) => f.key === page.field);
		if (field) return <FieldPage {...props} properties={properties} field={field} close={close} onBack={() => setPage("properties")} />;
	}
	return <MainPage {...props} close={close} onPage={setPage} />;
}

function MainPage({ view, layout, properties, group, onEditDatabase, close, onPage }: ViewMenuProps & { close: () => void; onPage: (page: Page) => void }) {
	const current = layoutOptions.find((o) => o.value === layout?.value);
	const setting = (icon: React.ReactNode, label: string, value: string, page: Page) => (
		<MenuItem onClick={() => onPage(page)}>
			<span className="text-neutral-400">{icon}</span>
			<span className="flex-1">{label}</span>
			<span className="max-w-24 truncate text-xs text-neutral-400">{value}</span>
			<CaretRightIcon className="text-neutral-400" />
		</MenuItem>
	);
	return (
		<>
			{view && <NameInput label="View name" value={view.name} onSave={view.onRename} onEnter={close} />}
			{layout && current && setting(current.icon, "Layout", current.label, "layout")}
			{properties && setting(<PropertiesIcon />, "Properties", `${properties.columns.length} shown`, "properties")}
			{group && setting(<GroupIcon />, "Group by", group.value.label, "group")}
			{(layout || properties || group) && (view || onEditDatabase) && <MenuDivider />}
			{onEditDatabase && (
				<MenuItem onClick={() => (close(), onEditDatabase())}>
					<EditIcon className="text-neutral-400" /> Edit database
				</MenuItem>
			)}
			{view && (
				<>
					<MenuItem onClick={() => (close(), view.onDuplicate())}>
						<CopyIcon className="text-neutral-400" /> Duplicate view
					</MenuItem>
					<MenuItem danger onClick={() => (close(), view.onDelete())}>
						<TrashIcon /> Delete view
					</MenuItem>
				</>
			)}
		</>
	);
}

/**
 * Notion's Properties page: what's shown, in order (drag to reorder), then what's hidden. A property's
 * name opens its own page; the eye shows or hides it. The name is always shown, first.
 */
function PropertiesPage({ properties, onNewField, close, onBack, onOpen }: ViewMenuProps & { properties: NonNullable<ViewMenuProps["properties"]>; close: () => void; onBack: () => void; onOpen: (key: string) => void }) {
	const { fields, columns, onChange, onMove, where } = properties;
	const [search, setSearch] = useState("");
	const q = search.trim().toLowerCase();
	const matches = (f: TypeField) => !q || f.label.toLowerCase().includes(q);
	const name = fields.find((f) => f.key === NAME_KEY);
	const shown = columns.filter((k) => k !== NAME_KEY).map((k) => fields.find((f) => f.key === k)).filter((f) => f !== undefined);
	const hidden = fields.filter((f) => f.key !== NAME_KEY && !columns.includes(f.key));
	// Dragging works on the whole list, not a search's part of it.
	const { item } = useDragList({
		axis: "y",
		enabled: !q,
		onDrop: (from, index) => {
			const order = shown.map((f) => f.key);
			const next = order.filter((k) => k !== from.id);
			const before = next[index] ?? null;
			next.splice(index, 0, from.id);
			if (next.join() !== order.join()) onMove(from.id, before);
		},
	});
	const row = (f: TypeField, on: boolean) => {
		const d = on ? item(f.key) : undefined;
		return (
			<div key={f.key} {...d} className={`flex items-center rounded-lg bg-white ${d?.className ?? ""}`}>
				<MenuItem title={f.canEdit ? "Edit property" : undefined} onClick={() => f.canEdit && onOpen(f.key)}>
					{/* Every row keeps the handle's room, so the names line up. */}
					{on && !q ? <DragHandleIcon className="-mx-1 shrink-0 text-neutral-300" /> : <span className="-mx-1 w-4 shrink-0" />}
					<FieldIcon field={f} />
					<span className={`flex-1 truncate ${on ? "" : "text-neutral-500"}`}>{f.label}</span>
				</MenuItem>
				<button
					type="button"
					onClick={() => onChange(on ? columns.filter((k) => k !== f.key) : [...columns, f.key])}
					className={smallIconButton}
					title={on ? `Hide on ${where}` : `Show on ${where}`}
					aria-label={`${on ? "Hide" : "Show"} ${f.label}`}
				>
					{on ? <ShowIcon /> : <HideIcon />}
				</button>
			</div>
		);
	};
	const heading = (label: string, action?: { label: string; onClick: () => void }) => (
		<p className="flex items-center justify-between px-2 pt-2 pb-0.5 text-xs text-neutral-400">
			<span>{label}</span>
			{action && (
				<button type="button" onClick={action.onClick} className={`${linkButton} text-link`}>
					{action.label}
				</button>
			)}
		</p>
	);
	return (
		<>
			<Back label="Properties" onBack={onBack} />
			<input
				autoFocus
				type="search"
				aria-label="Search for a property"
				placeholder="Search for a property"
				value={search}
				onChange={(e) => setSearch(e.target.value)}
				maxLength={100}
				className={`${compactControlClass} m-1`}
			/>
			{heading(`Shown on ${where}`, shown.length ? { label: "Hide all", onClick: () => onChange(columns.filter((k) => k === NAME_KEY)) } : undefined)}
			{name && matches(name) && (
				// Always shown, first: no eye, no handle.
				<MenuItem title={name.canEdit ? "Edit property" : undefined} onClick={() => name.canEdit && onOpen(name.key)}>
					<span className="-mx-1 w-4 shrink-0" />
					<FieldIcon field={name} />
					<span className="flex-1 truncate">{name.label}</span>
				</MenuItem>
			)}
			{shown.filter(matches).map((f) => row(f, true))}
			{hidden.length > 0 && (
				<>
					{heading("Hidden", { label: "Show all", onClick: () => onChange([...columns, ...hidden.map((f) => f.key)]) })}
					{hidden.filter(matches).map((f) => row(f, false))}
				</>
			)}
			{onNewField && (
				<>
					<MenuDivider />
					<MenuItem onClick={() => (close(), onNewField())}>
						<PlusIcon className="text-neutral-400" /> New property
					</MenuItem>
				</>
			)}
		</>
	);
}

/** One property, Notion's way: its name here; its kind and options in their dialog, which converts values; show or hide it; archive it. */
function FieldPage({ field, properties, onEditField, onRenameField, onArchiveField, close, onBack }: ViewMenuProps & { field: TypeField; properties: NonNullable<ViewMenuProps["properties"]>; close: () => void; onBack: () => void }) {
	const on = properties.columns.includes(field.key);
	const full = () => (close(), onEditField(field));
	return (
		<>
			<Back label="Edit property" onBack={onBack} />
			<NameInput label="Property name" value={field.label} onSave={(label) => onRenameField(field, label)} onEnter={onBack} autoFocus />
			<MenuItem onClick={full}>
				<FieldIcon field={field} />
				<span className="flex-1">Type</span>
				<span className="text-xs text-neutral-400">{kindLabels[field.kind]}</span>
				<CaretRightIcon className="text-neutral-400" />
			</MenuItem>
			{field.kind === "choice" && (
				<MenuItem onClick={full}>
					<span className="w-4 shrink-0" />
					<span className="flex-1">Options</span>
					<span className="text-xs text-neutral-400">{(field.options ?? []).filter((o) => !o.retired).length}</span>
					<CaretRightIcon className="text-neutral-400" />
				</MenuItem>
			)}
			{field.key !== NAME_KEY && (
				<>
					<MenuItem onClick={() => properties.onChange(on ? properties.columns.filter((k) => k !== field.key) : [...properties.columns, field.key])}>
						<span className="text-neutral-400">{on ? <HideIcon /> : <ShowIcon />}</span> {on ? `Hide on ${properties.where}` : `Show on ${properties.where}`}
					</MenuItem>
					<MenuDivider />
					<MenuItem onClick={() => (close(), onArchiveField(field))}>
						<ArchiveIcon className="text-neutral-400" /> Archive property
					</MenuItem>
				</>
			)}
		</>
	);
}

/** A page's title, going back to the one before. */
function Back({ label, onBack }: { label: string; onBack: () => void }) {
	return (
		<MenuItem onClick={onBack}>
			<CaretLeftIcon className="text-neutral-400" />
			<span className="flex-1 truncate font-medium">{label}</span>
		</MenuItem>
	);
}

/** A name, saved as you leave it however you leave (Enter, another page, closing the menu), when it changed. */
function NameInput({ label, value, onSave, onEnter, autoFocus }: { label: string; value: string; onSave: (name: string) => void; onEnter: () => void; autoFocus?: boolean }) {
	const [text, setText] = useState(value);
	const latest = useRef({ text, value, onSave });
	latest.current = { text, value, onSave };
	useEffect(
		() => () => {
			const { text, value, onSave } = latest.current;
			if (text.trim() && text.trim() !== value) onSave(text.trim());
		},
		[],
	);
	return (
		<input
			autoFocus={autoFocus}
			aria-label={label}
			value={text}
			maxLength={120}
			onChange={(e) => setText(e.target.value)}
			onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), onEnter())}
			className={`${compactControlClass} m-1`}
		/>
	);
}
