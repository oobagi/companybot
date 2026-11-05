import { deniedMessage } from "@companybot/core/permissions";
import { Fragment, useState } from "react";
import { api } from "../../api";
import { useQuery } from "../../convex";
import { navigate } from "../../router";
import { AgentIcon, AutomationIcon, ConnectorIcon, SkillIcon, ArchiveIcon } from "../../icons";
import { ConflictNotice, type Crumb, EmptyState, NotFound, Notice, Page, SaveBar, barButton, cardClass, compactButton, compactPrimaryButton, descriptionClass, disabledButtonClass, metadataClass, timeAgo, useDraft, useRun } from "../../ui";
import { TrashNotice } from "../Trash";
import { Confirm, archiveQuestion, useConfirm } from "../chat/common";

/** Each tab's description shows in the top bar. */
export const customizeTabs = [
	{ id: "agents", label: "Agents", one: "Agent", icon: AgentIcon, description: "What each agent knows and can do" },
	{ id: "connectors", label: "Connectors", one: "Connector", icon: ConnectorIcon, description: "Outside apps your agents can use" },
	{ id: "skills", label: "Skills", one: "Skill", icon: SkillIcon, description: "Instructions agents load when needed" },
	{ id: "automations", label: "Automations", one: "Automation", icon: AutomationIcon, description: "Jobs agents run on their own" },
] as const;
export type CustomizeTab = (typeof customizeTabs)[number]["id"];

/** Tabs whose items your team can make. */
type MadeTab = "skills" | "automations";

const tabLabel = (tab: CustomizeTab) => customizeTabs.find((t) => t.id === tab)!.label;

/** The top bar's trail for an item's own screen: Skills. */
export const customizeCrumbs = (tab: CustomizeTab): Crumb[] => [
	{ label: tabLabel(tab), to: ["settings", tab] },
];

/** Agents, skills and automations share one list of workspace items. */
export function ItemList<T extends { trash?: unknown; archived?: boolean }>({
	items, title, icon, empty, error, card,
}: {
	items: T[];
	title: string;
	icon: React.ReactNode;
	empty: string;
	error?: string;
	card: (item: T) => React.ReactNode;
}) {
	items = items.filter((item) => !item.trash && !item.archived);
	return (
		<>
			<Notice>{error}</Notice>
			{items.length ? <div className="flex flex-col gap-3">{items.map(card)}</div> : <EmptyState icon={icon} title={title}>{empty}</EmptyState>}
		</>
	);
}

/** A library item. Click to open its detail page; the button, if any, installs or removes it. */
export function Card(props: {
	title: string;
	meta: string;
	description: string;
	status?: string;
	/** Its install button. Without it there's none (things your team made are deleted from their page). */
	install?: { installed: boolean; canManage: boolean; onToggle: () => void };
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
				<p className="font-medium">
					{props.title} <span className="text-xs font-normal text-neutral-400">{props.meta}</span>
				</p>
				<p className={`line-clamp-2 ${descriptionClass}`}>{props.description}</p>
				{props.status && <p className={`mt-1 ${metadataClass}`}>{props.status}</p>}
			</div>
			{props.action}
			{props.install && (
				<InstallButton
					{...props.install}
					onToggle={(e) => {
						e.stopPropagation();
						props.install?.onToggle();
					}}
				/>
			)}
		</div>
	);
}

function InstallButton({
	installed,
	canManage,
	busy,
	onToggle,
}: {
	installed: boolean;
	canManage: boolean;
	busy?: boolean;
	onToggle: (e: React.MouseEvent) => void;
}) {
	return (
		<button
			type="button"
			disabled={!canManage || busy}
			title={canManage ? (installed ? "Remove" : undefined) : "None of your roles can install this"}
			onClick={onToggle}
			className={`shrink-0 ${installed ? compactButton : compactPrimaryButton}`}
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
	trash?: React.ComponentProps<typeof TrashNotice>["trash"] | null;
	confirmation?: string;
	busy?: boolean;
	canManage: boolean;
	onToggle: () => void;
	/** In place of the install button: a custom connector's Edit and Remove. */
	actions?: React.ReactNode;
	children: React.ReactNode;
}) {
	const [confirming, setConfirming] = useState(false);
	return (
		<Page
			title={props.title}
			description={`${props.description} · ${props.meta}`}
			crumbs={customizeCrumbs(props.tab)}
			actions={props.actions ?? (!props.trash && (props.confirmation && props.installed ? <button type="button" className={barButton} disabled={!props.canManage || props.busy} onClick={() => setConfirming(true)}><ArchiveIcon /> Archive</button> : <InstallButton installed={props.installed} canManage={props.canManage} busy={props.busy} onToggle={props.onToggle} />))}
		>
			{confirming && <Confirm title={`Archive “${props.title}”?`} action="Archive" onClose={() => setConfirming(false)} onConfirm={() => { setConfirming(false); props.onToggle(); }}>{props.confirmation}</Confirm>}
			{props.trash && <TrashNotice trash={props.trash} />}
			{props.children}
		</Page>
	);
}

/** The page for making a new one: its fields, with Discard and Create in the top bar. */
export function NewItem({
	tab,
	noun,
	error,
	onCreate,
	onDiscard,
	children,
}: {
	tab: MadeTab;
	/** "skill", "automation". */
	noun: string;
	error?: string;
	onCreate: () => void;
	onDiscard?: () => void;
	children: React.ReactNode;
}) {
	return (
		<Page
			title={`New ${noun}`}
			crumbs={customizeCrumbs(tab)}
			actions={
				<>
					{onDiscard && <button type="button" className={compactButton} onClick={onDiscard}>Discard</button>}
					<button type="button" className={compactPrimaryButton} onClick={onCreate}>Create</button>
				</>
			}
		>
			<Notice>{error}</Notice>
			<div className="flex flex-col gap-5">{children}</div>
		</Page>
	);
}

/**
 * The page for one your team made: who made it, its fields as an edit form (read-only for
 * people who can't change it, or while it's in Trash), Delete (to Trash), and Save. `children` go below the fields.
 */
export function MadeItemDetail<T>({
	id,
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
	id: string;
	tab: MadeTab;
	name: string;
	createdByName: string | null | undefined;
	/** From the server: whether one of your roles can change it (personal automations: only their maker). */
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
	const draft = useDraft(`${tab}:${id}`, saved, custom.version);
	const { error, run } = useRun();
	const editable = canEdit && !trash;
	const { confirm, dialog } = useConfirm();

	return (
		<Page
			title={name}
			description={`Made by ${createdByName ?? "your team"} · v${custom.version} · edited by ${custom.updatedByName} ${timeAgo(custom.updatedAt)}`}
			crumbs={customizeCrumbs(tab)}
			actions={
				editable && (
					<button
						type="button"
						className={barButton}
						onClick={() => confirm(archiveQuestion(name, () => onDelete().then(() => navigate("settings", tab)), tab === "automations" ? "This automation will stop running." : "Agents will stop seeing this skill."))}
					>
						<ArchiveIcon /> Archive
					</button>
				)
			}
		>
			{dialog}
			{trash && <TrashNotice trash={trash} />}
			{editable && <ConflictNotice draft={draft} who={custom.updatedByName} />}
			<Notice>{error}</Notice>
			{!canEdit && <CantEdit tab={tab} />}
			<fieldset disabled={!editable} className="flex flex-col gap-5">
				{fields(editable ? draft.value : saved, draft.set)}
			</fieldset>
			{children}
			{editable && <SaveBar dirty={draft.dirty} onDiscard={draft.discard} onSave={() => run(onSave(draft.value, draft.base), draft.discard)} />}
		</Page>
	);
}

/** Loading while `loaded` is false; after that, the item is gone (deleted, or a stale link). */
export function Missing({ tab, loaded }: { tab: CustomizeTab; loaded: boolean }) {
	const { one, icon: Icon } = customizeTabs.find((t) => t.id === tab)!;
	// Connectors are never in Trash: removing one (custom or from the app) deletes it.
	return (
		<NotFound crumbs={customizeCrumbs(tab)} loaded={loaded} icon={<Icon />} title={`${one} not found`}>
			{tab === "connectors" ? "It may have been removed." : undefined}
		</NotFound>
	);
}

export function Facts({ rows }: { rows: [string, string][] }) {
	return (
		<dl className={`grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-sm ${cardClass}`}>
			{rows.map(([label, value]) => (
				<Fragment key={label}>
					<dt className="text-neutral-500">{label}</dt>
					<dd className="break-words">{value}</dd>
				</Fragment>
			))}
		</dl>
	);
}

/** Why you can't change a skill or team automation, naming the roles that can (personal automations never show here: only their maker sees them). */
function CantEdit({ tab }: { tab: MadeTab }) {
	const roles = useQuery(api.roles.list);
	if (!roles) return null;
	const message = deniedMessage(tab === "skills" ? "skills.edit" : "automations.edit", roles.map((r) => ({ name: r.name, owner: r.builtIn === "owner", permissions: r.permissions })));
	return <p className={descriptionClass}>{message}</p>;
}
