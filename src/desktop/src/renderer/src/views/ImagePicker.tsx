import type { Id } from "@companybot/backend/convex/_generated/dataModel";
import { imageTypes } from "@companybot/core/images";
import { useRef, useState } from "react";
import { api } from "../api";
import { useMutation } from "../convex";
import { Notice, secondaryButton, useRun } from "../ui";
import { useUpload } from "../upload";
import { Avatar, Confirm } from "./chat/common";

/**
 * A picture with Upload (or Replace) and Remove: the workspace's logo, your photo, or an
 * agent's picture (`of`). `disabled` shows just the picture, for who can't change it.
 */
export function ImagePicker({
	of,
	name,
	image,
	agent,
	disabled,
}: {
	of: "workspace" | "me" | Id<"agents">;
	name: string;
	image: string | null;
	agent?: boolean;
	disabled?: boolean;
}) {
	const upload = useUpload();
	const set = useMutation(api.images.set);
	const { error, busy, run } = useRun();
	const input = useRef<HTMLInputElement>(null);
	const [removing, setRemoving] = useState(false);
	const save = (file: Id<"_storage"> | null) => set({ of, file });
	return (
		<div className="flex flex-col gap-2">
			<div className="flex items-center gap-3">
				<Avatar name={name} image={image} agent={agent} size="lg" />
				{!disabled && (
					<>
						<button type="button" disabled={busy} onClick={() => input.current?.click()} className={`${secondaryButton} py-1`}>
							{busy ? "Uploading…" : image ? "Replace" : "Upload"}
						</button>
						{image && (
							<button type="button" disabled={busy} onClick={() => setRemoving(true)} className={`${secondaryButton} py-1`}>
								Remove
							</button>
						)}
						<input
							ref={input}
							type="file"
							accept={imageTypes.join(",")}
							hidden
							onChange={(e) => {
								const file = e.target.files?.[0];
								e.target.value = "";
								if (file) run(upload(file).then(save));
							}}
						/>
					</>
				)}
			</div>
			{error && !removing && <Notice>{error}</Notice>}
			{removing && (
				<Confirm title="Remove picture?" action="Remove" error={error} onConfirm={() => run(save(null), () => setRemoving(false))} onClose={() => setRemoving(false)}>
					{name} will show initials instead.
				</Confirm>
			)}
		</div>
	);
}
