import { Art } from "./Art";

/** The first screen when nobody's signed in: what Companybot is, in a line, and one way forward. */
export function Landing({ onStart }: { onStart: () => void }) {
	return (
		<Split>
			<Mark />
			<div className="flex flex-col gap-3">
				<h1 className="text-3xl font-semibold tracking-tight text-neutral-900">Companybot</h1>
				<p className="text-base text-neutral-500">Chat, CRM and AI agents for your company, in one place.</p>
			</div>
			<button type="button" onClick={onStart} className="rounded-xl bg-neutral-900 px-6 py-2.5 text-base text-white hover:bg-neutral-800">
				Get started
			</button>
		</Split>
	);
}

/** Landing and sign-in share this frame: whatever's inside sits centered on the left, the picture takes the right. */
export function Split({ children }: { children: React.ReactNode }) {
	return (
		<div className="drag flex h-screen bg-neutral-50">
			<div className="flex w-full flex-col items-center justify-center px-8 lg:w-1/2">
				<div className="no-drag flex w-[360px] flex-col items-center gap-8 text-center">{children}</div>
			</div>
			<div className="hidden p-3 pl-0 lg:block lg:w-1/2">
				<Art className="size-full rounded-2xl" />
			</div>
		</div>
	);
}

/** The app's mark: its initial on the same tile the workspace rail uses. */
export function Mark({ className = "size-16 rounded-2xl text-2xl" }: { className?: string }) {
	return <span className={`flex items-center justify-center bg-neutral-900 font-semibold text-white select-none ${className}`}>C</span>;
}
