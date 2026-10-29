import type { Doc, Id } from "@companybot/backend/convex/_generated/dataModel";
import { EditorContent, useEditor } from "@tiptap/react";
import { type ReactNode, useMemo, useRef, useState } from "react";
import { ArrowUpIcon, ChannelIcon, PrivateIcon, SkillIcon } from "../../icons";
import { AttachButton, type Attachments, PendingFiles } from "./Attachments";
import { Avatar } from "./common";
import type { Mentions } from "./data";
import { type Candidate, type Menu, type Sources, SuggestionMenu, composerExtensions, plainText, tokensIn } from "./editor";
import { Form, metadataClass } from "../../ui";

export type SendWith = Doc<"preferences">["sendWith"];

export function Composer({
	onSend,
	sendWith,
	placeholder,
	status,
	tray,
	onType,
	sources,
	attachments,
}: {
	onSend: (text: string, mentions: Mentions, files: Id<"_storage">[]) => void;
	sendWith: SendWith;
	placeholder: string;
	/** The line under the box (who's typing). Its space is kept when empty, so the box doesn't jump. */
	status?: ReactNode;
	/** Sits on top of the box, joined to it (the tutorial). */
	tray?: ReactNode;
	onType?: () => void;
	/** What @, # and / offer. */
	sources: Sources;
	/** Files to send with the message: the paperclip, pasting, and dropping on the chat add them. */
	attachments?: Attachments;
}) {
	const [menu, setMenu] = useState<Menu | null>(null);
	const [empty, setEmpty] = useState(true);
	// The editor is made once; it reads the latest props (and this render's submit) through this ref.
	const latest = useRef({ sources, placeholder, sendWith, onSend, onType, attachments, submit: () => {} });
	latest.current = { ...latest.current, sources, placeholder, sendWith, onSend, onType, attachments };
	const suggestions = useMemo(() => new SuggestionMenu(() => latest.current.sources, setMenu), []);

	const editor = useEditor({
		extensions: composerExtensions({
			menu: suggestions,
			placeholder: () => latest.current.placeholder,
			sendWith: () => latest.current.sendWith,
			send: () => latest.current.submit(),
		}),
		autofocus: "end",
		editorProps: {
			attributes: { class: "max-h-48 overflow-y-auto py-1.5 outline-none break-words", role: "textbox", "aria-multiline": "true" },
			handlePaste: (_view, event) => {
				const files = [...(event.clipboardData?.files ?? [])];
				if (files.length === 0 || !latest.current.attachments) return false;
				latest.current.attachments.add(files);
				return true;
			},
		},
		onUpdate: ({ editor }) => {
			setEmpty(editor.isEmpty);
			if (!editor.isEmpty) latest.current.onType?.();
		},
		onBlur: () => suggestions.hide(),
	});

	const submit = () => {
		if (!editor) return;
		const text = plainText(editor);
		const files = latest.current.attachments;
		if (files?.uploading || (!text && !files?.ids.length)) return;
		const tokens = tokensIn(editor);
		latest.current.onSend(text, { userIds: tokens.user as Id<"users">[], agentIds: tokens.agent as Id<"agents">[], skillIds: tokens.skill }, files?.ids ?? []);
		files?.clear();
		editor.commands.clearContent(true);
		setEmpty(true);
	};
	latest.current.submit = submit;

	return (
		<div className="relative flex w-full flex-col">
			{menu && <Picker menu={menu} onHighlight={(i) => suggestions.highlight(i)} onPick={(i) => suggestions.pick(i)} />}
			<div className="flex flex-col">
				{tray}
				<Form className={`flex w-full flex-wrap items-end gap-2 rounded-2xl border border-neutral-200 bg-white p-2 shadow-sm focus-within:border-neutral-300 ${attachments ? "" : "pl-4"}`} onSubmit={submit}>
					{attachments && <PendingFiles attachments={attachments} />}
					{attachments && <AttachButton attachments={attachments} />}
					<EditorContent editor={editor} className="composer min-w-0 flex-1" />
					<button
						type="submit"
						disabled={attachments?.uploading || (empty && !attachments?.ids.length)}
						className="flex size-8 shrink-0 items-center justify-center rounded-full bg-neutral-900 text-white disabled:bg-neutral-200"
						aria-label="Send"
					>
						<ArrowUpIcon weight="bold" />
					</button>
				</Form>
			</div>
			{/* Hangs in the footer's bottom padding, so the composer doesn't sit higher to make room for it. */}
			<p className="absolute inset-x-0 top-full truncate px-4 pt-1.5 text-xs leading-4 text-neutral-400" aria-live="polite">
				{status}
			</p>
		</div>
	);
}

const hints: Record<Menu["trigger"], string> = { "@": "People and agents", "#": "Channels", "/": "Skills" };

/** The menu over the box. Arrows move, Enter or Tab picks, Escape closes; the mouse works too. */
function Picker({ menu, onHighlight, onPick }: { menu: Menu; onHighlight: (i: number) => void; onPick: (i: number) => void }) {
	return (
		<div className="absolute bottom-full left-0 z-20 mb-2 w-80 overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-lg">
			<p className={`px-3 pt-2 pb-1 ${metadataClass}`}>{hints[menu.trigger]}</p>
			<ul role="listbox" className="pb-1">
				{menu.items.map((c, i) => (
					<li key={`${c.kind}:${c.id}`} role="option" aria-selected={i === menu.index}>
						<button
							type="button"
							// mousedown, not click: the editor must keep focus, or the chip lands nowhere.
							onMouseDown={(e) => (e.preventDefault(), onPick(i))}
							onMouseEnter={() => onHighlight(i)}
							className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm ${i === menu.index ? "bg-neutral-100" : ""}`}
						>
							<Row candidate={c} />
						</button>
					</li>
				))}
			</ul>
		</div>
	);
}

function Row({ candidate: c }: { candidate: Candidate }) {
	if (c.kind === "channel") {
		return (
			<>
				<span className="flex size-6 shrink-0 items-center justify-center text-neutral-500">{c.private ? <PrivateIcon /> : <ChannelIcon />}</span>
				<span className="truncate">{c.label}</span>
				{c.topic && <span className={`min-w-0 flex-1 truncate ${metadataClass}`}>{c.topic}</span>}
				{!c.joined && <span className={`ml-auto shrink-0 ${metadataClass}`}>Not joined</span>}
			</>
		);
	}
	if (c.kind === "skill") {
		return (
			<>
				<span className="flex size-6 shrink-0 items-center justify-center text-neutral-500">
					<SkillIcon />
				</span>
				<span className="truncate">{c.label}</span>
				<span className={`min-w-0 flex-1 truncate ${metadataClass}`}>{c.description}</span>
			</>
		);
	}
	return (
		<>
			<Avatar name={c.label} image={c.image} agent={c.kind === "agent"} size="sm" />
			<span className="flex-1 truncate">{c.label}</span>
			{c.kind === "agent" && <span className={metadataClass}>Agent</span>}
		</>
	);
}
