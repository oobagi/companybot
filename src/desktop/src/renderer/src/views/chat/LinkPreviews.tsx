import { api } from "../../api";
import { useMutation } from "../../convex";
import { CloseIcon } from "../../icons";
import type { Message } from "./data";

// Cards under a message for its first links (backend linkPreviews.ts): site, title, a bit of the
// page's text, and our own copy of its picture. Clicking one opens the page in the browser, as
// links in text do (main/index.ts sends web links out, only http and https). The sender can hide it.

export function LinkPreviews({ message, onError }: { message: Message; onError: (e: unknown) => void }) {
	const hide = useMutation(api.messages.hidePreview);
	return (
		<div className="flex flex-col gap-1.5 pt-0.5">
			{message.linkPreviews.map((card) => (
				<div key={card.url} className="group/card relative max-w-md">
					<a
						href={card.url}
						target="_blank"
						rel="noreferrer noopener"
						className="flex gap-3 rounded-lg border border-neutral-200 bg-white p-2.5 hover:border-neutral-300"
					>
						<span className="flex min-w-0 flex-1 flex-col gap-0.5">
							{card.siteName && <span className="truncate text-xs text-neutral-500">{card.siteName}</span>}
							{card.title && <span className="line-clamp-2 font-semibold text-primary">{card.title}</span>}
							{card.description && <span className="line-clamp-2 text-sm text-neutral-600">{card.description}</span>}
						</span>
						{card.imageUrl && <img src={card.imageUrl} alt="" loading="lazy" className="size-16 shrink-0 rounded-md bg-neutral-100 object-cover" />}
					</a>
					{message.mine && (
						<button
							type="button"
							title="Hide preview"
							aria-label={`Hide the preview of ${card.title ?? card.url}`}
							onClick={() => hide({ messageId: message._id, url: card.url }).catch(onError)}
							className="absolute top-1 right-1 hidden size-5 items-center justify-center rounded-full bg-white text-xs text-neutral-400 hover:bg-neutral-100 hover:text-neutral-900 group-hover/card:flex focus-visible:flex"
						>
							<CloseIcon />
						</button>
					)}
				</div>
			))}
		</div>
	);
}
