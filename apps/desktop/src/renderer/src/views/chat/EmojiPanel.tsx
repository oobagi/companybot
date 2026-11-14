import { useEffect, useRef, useState } from "react";
import { HistoryIcon } from "../../icons";
import { compactControlClass, emojiTabButton, hintClass, metadataClass, skinToneButton, tileButton } from "../../ui";
import { type Emoji, type EmojiIndex, groupIcons, groups, loadEmoji, loadedEmoji, recentEmoji, rememberEmoji, saveTone, savedTone, searchEmoji, withTone } from "./emoji";

const tones = ["✋", "✋🏻", "✋🏼", "✋🏽", "✋🏾", "✋🏿"];

/**
 * The emoji picker, the one everywhere: search, categories, recents and a skin tone, all on this computer.
 * It fills whatever panel holds it (a `Popover`); `onPick` gets the emoji to put in. With `search`, it's
 * driven by text typed elsewhere (`:smi` in a message or a page; `menuEmoji` lists what it shows), so it has
 * no box, and `selected` is the emoji the arrow keys are on, lit and named in the footer, which Enter takes.
 */
export function EmojiPanel({ onPick, search, selected }: { onPick: (emoji: string) => void; search?: string; selected?: string }) {
	const [index, setIndex] = useState<EmojiIndex | undefined>(loadedEmoji);
	const [failed, setFailed] = useState(false);
	const [typed, setTyped] = useState("");
	const query = search ?? typed;
	const [tone, setTone] = useState(() => savedTone(localStorage));
	const [recent, setRecent] = useState(() => recentEmoji(localStorage));
	const [hover, setHover] = useState<Emoji>();
	const scroller = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!index) loadEmoji().then(setIndex, () => setFailed(true));
	}, [index]);

	const pick = (char: string) => {
		setRecent(rememberEmoji(localStorage, char));
		onPick(char);
	};
	const results = index ? searchEmoji(index, query) : [];
	const jump = (id: string) => scroller.current?.querySelector(`[data-section="${id}"]`)?.scrollIntoView({ block: "start" });
	useEffect(() => {
		scroller.current?.querySelector("[aria-selected=true]")?.scrollIntoView({ block: "nearest" });
	}, [selected]);
	const lit = selected ? index?.emoji.find((e) => e.char === selected || e.tones.includes(selected)) : undefined;
	const tile = (char: string, e: Emoji | undefined, onPickChar: () => void) => (
		<button type="button" key={char} title={e?.name} aria-selected={char === selected || undefined} onClick={onPickChar} onMouseEnter={() => setHover(e)} className={`${tileButton} text-xl aria-selected:bg-neutral-100`}>
			{char}
		</button>
	);
	const button = (e: Emoji) => tile(withTone(e, tone), e, () => pick(withTone(e, tone)));

	return (
		<div className="flex w-80 flex-col gap-2 p-2">
			{search === undefined && <input
				autoFocus
				value={query}
				onChange={(e) => setTyped(e.target.value)}
				onKeyDown={(e) => {
					if (e.key !== "Enter") return;
					e.preventDefault();
					if (results[0]) pick(withTone(results[0], tone));
				}}
				placeholder="Search emoji"
				aria-label="Search emoji"
				className={`w-full ${compactControlClass}`}
			/>}
			{!query && (
				<div className="flex justify-between">
					{recent.length > 0 && (
						<button type="button" title="Recent" aria-label="Recent" onClick={() => jump("recent")} className={`${emojiTabButton} text-neutral-500`}>
							<HistoryIcon />
						</button>
					)}
					{groupIcons.map((icon, i) => (
						<button type="button" key={icon} title={groups[i]} aria-label={groups[i]} onClick={() => jump(String(i))} className={emojiTabButton}>
							{icon}
						</button>
					))}
				</div>
			)}
			<div ref={scroller} className="max-h-64 overflow-y-auto">
				{failed ? (
					<p className={`p-2 ${hintClass}`}>Couldn't load emoji.</p>
				) : !index ? null : query ? (
					results.length > 0 ? (
						<div className="grid grid-cols-9">{results.map(button)}</div>
					) : (
						<p className={`p-2 ${hintClass}`}>No emoji found.</p>
					)
				) : (
					<>
						{recent.length > 0 && (
							<section data-section="recent">
								<p className={`px-1 py-1 ${metadataClass}`}>Recent</p>
								<div className="grid grid-cols-9">{recent.map((char) => tile(char, index.emoji.find((e) => e.char === char || e.tones.includes(char)), () => pick(char)))}</div>
							</section>
						)}
						{groups.map((name, i) => (
							<section key={name} data-section={i}>
								<p className={`px-1 py-1 ${metadataClass}`}>{name}</p>
								<div className="grid grid-cols-9">{index.emoji.filter((e) => e.group === i).map(button)}</div>
							</section>
						))}
					</>
				)}
			</div>
			<div className="flex h-8 items-center justify-between gap-2 border-t border-neutral-100 pt-2">
				<span className={`min-w-0 truncate ${metadataClass}`}>{(() => { const e = hover ?? lit; return e ? `${e.char} ${e.shortcodes[0] ? `:${e.shortcodes[0]}:` : e.name}` : "Skin tone"; })()}</span>
				<span className="flex shrink-0">
					{tones.map((char, i) => (
						<button
							type="button"
							key={char}
							title={i === 0 ? "Default" : `Skin tone ${i}`}
							aria-label={i === 0 ? "Default skin tone" : `Skin tone ${i}`}
							aria-pressed={i === tone}
							onClick={() => (setTone(i), saveTone(localStorage, i))}
							className={skinToneButton}
						>
							{char}
						</button>
					))}
				</span>
			</div>
		</div>
	);
}
