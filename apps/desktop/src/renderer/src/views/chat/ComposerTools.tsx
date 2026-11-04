import type { Editor } from "@tiptap/core";
import { MicrophoneIcon, ReactIcon, StopIcon } from "../../icons";
import { Popover } from "./common";
import { spaced, useDictation } from "./dictation";
import { EmojiPanel } from "./EmojiPanel";

const tool = "flex size-8 shrink-0 items-center justify-center rounded-full text-lg text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 disabled:opacity-50";

/** The composer's emoji picker and microphone, which put their result at the caret. */
export function ComposerTools({ editor }: { editor: Editor | null }) {
	const insert = (text: string) => editor?.chain().focus().insertContent(text).run();
	const charBefore = () => {
		const at = editor?.state.selection.from ?? 0;
		return editor?.state.doc.textBetween(Math.max(0, at - 1), at, "\n", "￼") ?? "";
	};
	const dictation = useDictation((text) => insert(spaced(charBefore(), text)));
	const recording = dictation.state === "recording";

	return (
		<>
			<Popover trigger={<ReactIcon />} label="Add emoji" className={tool} panelClassName="w-auto">
				{(close) => <EmojiPanel onPick={(emoji) => (close(), insert(emoji))} />}
			</Popover>
			<span className="relative flex">
				<button
					type="button"
					title={recording ? "Stop and transcribe" : "Dictate"}
					aria-label={recording ? "Stop dictation" : "Dictate"}
					disabled={dictation.state === "transcribing"}
					onClick={dictation.toggle}
					className={`${tool} ${recording ? "animate-pulse bg-red-50 text-red-600 hover:bg-red-50 hover:text-red-600" : ""} ${dictation.state === "transcribing" ? "animate-pulse" : ""}`}
				>
					{recording ? <StopIcon weight="fill" /> : <MicrophoneIcon />}
				</button>
				{dictation.error && (
					<span role="alert" className="absolute right-0 bottom-full mb-2 w-60 rounded-lg bg-red-50 px-2.5 py-1.5 text-xs text-red-700 shadow-sm">
						{dictation.error}
					</span>
				)}
			</span>
		</>
	);
}
