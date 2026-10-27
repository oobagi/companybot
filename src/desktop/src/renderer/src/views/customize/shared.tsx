import { Fragment } from "react";
import { navigate } from "../../router";
import { TrashIcon } from "../../icons";
import { type Crumb, ConflictNotice, NotFound, Notice, Page, SaveBar, barDangerButton, descriptionClass, disabledButtonClass, metadataClass, primaryButton, timeAgo, useDraft, useRun } from "../../ui";
import { TrashNotice } from "../Trash";

export const customizeTabs = [
	{ id: "agents", label: "Agents" },
	{ id: "connectors", label: "Connectors" },
	{ id: "skills", label: "Skills" },
	{ id: "automations", label: "Automations" },
] as const;
export type CustomizeTab = (typeof customizeTabs)[number]["id"];

/** Tabs whose items your team can make. */
type MadeTab = "skills" | "automations";

const tabLabel = (tab: CustomizeTab) => customizeTabs.find((t) => t.id === tab)!.label;

/** The top bar's trail for an item's own screen: Customize › Skills. */
export const customizeCrumbs = (tab: CustomizeTab): Crumb[] => [
	{ label: "Customize", to: ["customize"] },
	{ label: tabLabel(tab), to: ["customize", tab] },
];

/** Skills and automations share one list of workspace items. */
export function ItemList<T extends { trash: unknown }>({
	items, description, action, empty, error, card,
}: {
	items: T[];
	description: string;
	empty: string;
	action: React.ReactNode;
	error?: string;
	card: (item: T) => React.ReactNode;
}) {
	items = items.filter((item) => !item.trash);
	return (
		<>
			<div className="flex items-start justify-between gap-4">
				<p className={descriptionClass}>{description}</p>
				{action}
			</div>
			{error && <Notice>{error}</Notice>}
			{items.length ? <div className="flex flex-col gap-3">{items.map(card)}</div> : <p className="rounded-xl border border-dashed border-neutral-200 p-6 text-sm text-neutral-500">{empty}</p>}
		</>
	);
}

/** A library item. Click to open its detail page; the button, if any, installs or removes it. */
export function Card(props: {
	title: string;
	meta: string;
	description: string;
	status?: string;
	installed: boolean;
	canManage: boolean;
	/** Without it there's no install button (things your team made are deleted from their page). */
	onToggle?: () => void;
	/** Shown in place of the install button. */
	action?: React.ReactNode;
	onOpen: () => void;
}) {
	return (
		// A div, not a button: it holds the install button.
		<div
			role="button"
			tabIndex={0}
			onClick={props.onOpen}
			onKeyDown={(e) => e.key === "Enter" && e.target === e.currentTarget && props.onOpen()}
			className="flex items-start justify-between gap-4 rounded-xl border border-neutral-200 p-4 text-left hover:bg-neutral-50"
		>
			<div className="min-w-0">
				<h3 className="font-medium">
					{props.title} <span className="text-xs font-normal text-neutral-400">{props.meta}</span>
				</h3>
				<p className={`line-clamp-2 ${descriptionClass}`}>{props.description}</p>
				{props.status && <p className={`mt-1 ${metadataClass}`}>{props.status}</p>}
			</div>
			{props.action}
			{props.onToggle && (
				<InstallButton
					installed={props.installed}
					canManage={props.canManage}
					onToggle={(e) => {
						e.stopPropagation();
						props.onToggle?.();
					}}
				/>
			)}
		</div>
	);
}

function InstallButton({
	installed,
	canManage,
	onToggle,
}: {
	installed: boolean;
	canManage: boolean;
	onToggle: (e: React.MouseEvent) => void;
}) {
	return (
		<button
			type="button"
			disabled={!canManage}
			title={canManage ? (installed ? "Remove" : undefined) : "Only owners can install"}
			onClick={onToggle}
			className={`shrink-0 rounded-full px-3 py-1 text-sm ${disabledButtonClass} ${
				installed ? "border border-neutral-200 text-neutral-600" : "bg-neutral-900 text-white"
			}`}
		>
			{installed ? "Installed" : "Install"}
		</button>
	);
}

/** An item's own screen, pushed over its tab's list. */
export function Detail(props: {
	tab: Exclude<CustomizeTab, "agents">;
	title: string;
	meta: string;
	description: string;
	installed: boolean;
	canManage: boolean;
	onToggle: () => void;
	children: React.ReactNode;
}) {
	return (
		<Page
			title={props.title}
			subtitle={props.meta}
			crumbs={customizeCrumbs(props.tab)}
			actions={<InstallButton installed={props.installed} canManage={props.canManage} onToggle={props.onToggle} />}
		>
			<p className="text-neutral-600">{props.description}</p>
			{props.children}
		</Page>
	);
}

/** The page for making a new one: its fields, then Create. */
export function NewItem({
	tab,
	noun,
	error,
	onCreate,
	children,
}: {
	tab: MadeTab;
	/** "skill", "automation". */
	noun: string;
	error?: string;
	onCreate: () => void;
	children: React.ReactNode;
}) {
	return (
		<Page title={`New ${noun}`} crumbs={customizeCrumbs(tab)}>
			{error && <Notice>{error}</Notice>}
			<div className="flex flex-col gap-5">
				{children}
				<button type="button" className={`${primaryButton} self-start`} onClick={onCreate}>
					Create
				</button>
			</div>
		</Page>
	);
}

/**
 * The page for one your team made: who made it, its fields as an edit form (read-only for
 * people who can't change it, or while it's in Trash), Delete (to Trash), and Save. `children` go below the fields.
 */
export function MadeItemDetail<T>({
	tab,
	name,
	createdByName,
	canEdit,
	custom,
	trash,
	saved,
	onDelete,
	onSave,
	fields,
	children,
}: {
	tab: MadeTab;
	name: string;
	createdByName: string | null | undefined;
	/** From the server: the maker or an owner. */
	canEdit: boolean;
	custom: { version: number; updatedByName: string; updatedAt: number };
	/** Set while it's in Trash. */
	trash: React.ComponentProps<typeof TrashNotice>["trash"] | null;
	/** The saved fields; the form edits a draft of them. */
	saved: T;
	onDelete: () => Promise<unknown>;
	onSave: (value: T, expectedVersion: number) => Promise<unknown>;
	fields: (value: T, onChange: (value: T) => void) => React.ReactNode;
	children?: React.ReactNode;
}) {
	const draft = useDraft(saved, custom.version);
	const { error, run } = useRun();
	const editable = canEdit && !trash;

	return (
		<Page
			title={name}
			subtitle={`Made by ${createdByName ?? "your team"} · v${custom.version} · edited by ${custom.updatedByName} ${timeAgo(custom.updatedAt)}`}
			crumbs={customizeCrumbs(tab)}
			actions={
				editable && (
					<button
						type="button"
						className={barDangerButton}
						onClick={() => run(onDelete(), () => navigate("customize", tab))}
					>
						<TrashIcon /> Delete
					</button>
				)
			}
		>
			{trash && <TrashNotice trash={trash} />}
			{draft.stale && <ConflictNotice who={custom.updatedByName} onDiscard={draft.discard} onKeep={draft.keepMine} />}
			{error && <Notice>{error}</Notice>}
			{!canEdit && <p className={descriptionClass}>Only the person who made it or an owner can change it.</p>}
			<fieldset disabled={!editable} className="flex flex-col gap-5">
				{fields(draft.value, draft.set)}
			</fieldset>
			{children}
			{editable && draft.dirty && <SaveBar onDiscard={draft.discard} onSave={() => run(onSave(draft.value, draft.base), draft.discard)} />}
		</Page>
	);
}

/** Loading while `loaded` is false; after that, the item is gone (deleted, or a stale link). */
export function Missing({ tab, loaded }: { tab: CustomizeTab; loaded: boolean }) {
	return <NotFound crumbs={customizeCrumbs(tab)} loaded={loaded}>It may have been deleted.</NotFound>;
}

export function Facts({ rows }: { rows: [string, string][] }) {
	return (
		<dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 rounded-xl border border-neutral-200 px-4 py-3 text-sm">
			{rows.map(([label, value]) => (
				<Fragment key={label}>
					<dt className="text-neutral-500">{label}</dt>
					<dd className="break-words">{value}</dd>
				</Fragment>
			))}
		</dl>
	);
}
