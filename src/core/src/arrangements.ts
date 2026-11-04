/** Where an arrangement belongs. Workspace ids in existing keys must match the request. */
export function arrangementScope(key: string): "account" | "personal" | "shared" | undefined {
	if (key === "rail.order") return "account";
	if (["rail.tabs", "sidebar.sections", "sidebar.folded"].includes(key) || /^(rail\.(pins|recent|pins\.order)|sidebar\.(dms|channels\.folded|dms\.folded)|pages-expanded):[^:]+$/.test(key)) return "personal";
	if (/^sidebar\.(channels|databases):[^:]+$/.test(key) || /^sidebar\.pages:[^:]+:[^:]+$/.test(key) || /^views\.order:[^:]+$/.test(key) || /^records\.(columns|layout)\.[^:]+$/.test(key)) return "shared";
}
