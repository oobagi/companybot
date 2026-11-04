import type { Option } from "./controls";

export const agentLabel = (agent: { name: string; archived?: boolean }) => `${agent.name}${agent.archived ? " (deleted)" : ""}`;

/** Options only: each screen decides which agents and placeholder to offer. */
export const agentOptions = (agents: { _id: string; name: string; archived?: boolean }[]): Option[] => agents.map((a) => ({ value: a._id, label: agentLabel(a) }));
