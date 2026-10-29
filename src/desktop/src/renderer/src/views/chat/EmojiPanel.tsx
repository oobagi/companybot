import { useEffect, useRef, useState } from "react";
import { HistoryIcon } from "../../icons";
import { compactControlClass, hintClass, metadataClass } from "../../ui";
import { type Emoji, type EmojiIndex, groupIcons, groups, loadEmoji, loadedEmoji, recentEmoji, rememberEmoji, saveTone, savedTone, searchEmoji, withTone } from "./emoji";

const tones = ["✋", "✋🏻", "✋🏼", "✋🏽", "✋🏾", "✋🏿"];
const cell = "flex size-8 items-center justify-center rounded-lg text-xl hover:bg-neutral-100";
const tab = "flex size-7 items-center justify-center rounded-lg text-base hover:bg-neutral-100";

/**
 * The full emoji picker: search, categories, recents and a skin tone, all on this computer.
 * It fills whatever panel holds it (a `Popover`); `onPick` gets the emoji to put in.
 */
export function EmojiPanel({ onPick }: { onPick: (emoji: string) => void }) {
	const [index, setIndex] = useState<EmojiIndex | undefined>(loadedEmoji);
	const [failed, setFailed] = useState(false);
	const [query, setQuery] = useState("");
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
	const button = (e: Emoji) => (
		<button type="button" key={e.char} title={e.name} onClick={() => pick(withTone(e, tone))} onMouseEnter={() => setHover(e)} className={cell}>
			{withTone(e, tone)}
		</button>
	);

	return (
		<div className="flex w-80 flex-col gap-2 p-2">
			<input
				autoFocus
				value={query}
				onChange={(e) => setQuery(e.target.value)}
				onKeyDown={(e) => {
					if (e.key !== "Enter") return;
					e.preventDefault();
					if (results[0]) pick(withTone(results[0], tone));
				}}
				placeholder="Search emoji"
				aria-label="Search emoji"
				className={`w-full ${compactControlClass}`}
			/>
			{!query && (
				<div className="flex justify-between">
					{recent.length > 0 && (
						<button type="button" title="Recent" aria-label="Recent" onClick={() => jump("recent")} className={`${tab} text-neutral-500`}>
							<HistoryIcon />
						</button>
					)}
					{groupIcons.map((icon, i) => (
						<button type="button" key={icon} title={groups[i]} aria-label={groups[i]} onClick={() => jump(String(i))} className={tab}>
							{icon}
						</button>
					))}
				</div>
			)}
			<div ref={scroller} className="h-64 overflow-y-auto">
				{failed ? (
					<p className={`p-2 ${hintClass}`}>Couldn't load emoji.</p>
				) : !index ? null : query ? (
					results.length > 0 ? (
						<div className="flex flex-wrap">{results.map(button)}</div>
					) : (
						<p className={`p-2 ${hintClass}`}>No emoji found.</p>
					)
				) : (
					<>
						{recent.length > 0 && (
							<section data-section="recent">
								<h3 className={`px-1 py-1 ${metadataClass}`}>Recent</h3>
								<div className="flex flex-wrap">
									{recent.map((char) => (
										<button type="button" key={char} onClick={() => pick(char)} onMouseEnter={() => setHover(index.emoji.find((e) => e.char === char || e.tones.includes(char)))} className={cell}>
											{char}
										</button>
									))}
								</div>
							</section>
						)}
						{groups.map((name, i) => (
							<section key={name} data-section={i}>
								<h3 className={`px-1 py-1 ${metadataClass}`}>{name}</h3>
								<div className="flex flex-wrap">{index.emoji.filter((e) => e.group === i).map(button)}</div>
							</section>
						))}
					</>
				)}
			</div>
			<div className="flex h-8 items-center justify-between gap-2 border-t border-neutral-100 pt-2">
				<span className={`min-w-0 truncate ${metadataClass}`}>{hover ? `${hover.char} ${hover.shortcodes[0] ? `:${hover.shortcodes[0]}:` : hover.name}` : "Skin tone"}</span>
				<span className="flex shrink-0">
					{tones.map((char, i) => (
						<button
							type="button"
							key={char}
							title={i === 0 ? "Default" : `Skin tone ${i}`}
							aria-label={i === 0 ? "Default skin tone" : `Skin tone ${i}`}
							aria-pressed={i === tone}
							onClick={() => (setTone(i), saveTone(localStorage, i))}
							className={`flex size-6 items-center justify-center rounded-md text-sm ${i === tone ? "bg-neutral-200" : "hover:bg-neutral-100"}`}
						>
							{char}
						</button>
					))}
				</span>
			</div>
		</div>
	);
}
