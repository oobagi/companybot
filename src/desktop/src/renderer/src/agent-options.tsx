export const agentLabel = (agent: { name: string; archived?: boolean }) => `${agent.name}${agent.archived ? " (archived)" : ""}`;

/** Options only: each screen decides which agents and placeholder to offer. */
export function AgentOptions({ agents }: { agents: { _id: string; name: string; archived?: boolean }[] }) {
	return agents.map((a) => (
		<option key={a._id} value={a._id}>
			{agentLabel(a)}
		</option>
	));
}
