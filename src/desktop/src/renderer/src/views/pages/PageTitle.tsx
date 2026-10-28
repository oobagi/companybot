import { useRun, useSynced } from "../../ui";

/** The title, edited in place; saved when you leave it or press Enter. */
export function PageTitle({ title, editable, onSave }: { title: string; editable: boolean; onSave: (title: string) => Promise<unknown> }) {
	const [draft, setDraft] = useSynced(title);
	const { error, run } = useRun();
	if (!editable) return <span className="text-4xl font-bold">{title}</span>;
	const save = () => draft.trim() && draft !== title && run(onSave(draft));
	return (
		<>
			<input
				value={draft}
				onChange={(e) => setDraft(e.target.value)}
				onBlur={save}
				onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
				autoFocus={title === "Untitled"}
				onFocus={(e) => title === "Untitled" && e.currentTarget.select()}
				aria-label="Title"
				className="w-full bg-transparent text-4xl font-bold outline-none"
			/>
			{error && <span className="block text-xs font-normal text-red-600">{error}</span>}
		</>
	);
}
