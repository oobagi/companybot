import type { RouterAction, RouterAgent, RouterInput, RouterMessage } from "../src/router";

// Chat moments for scoring the reply router (router.eval.ts): what's been said, the newest message,
// and what each agent should do. Written like a small roofing company's channels. Keep each one
// unambiguous to a person reading it: the eval measures the model, not the labels.

const companybot: RouterAgent = {
	key: "a1",
	name: "Companybot",
	description: "Your company's assistant. Answers questions about clients, deals, tasks and the team's data, and does things in the app.",
	canReact: true,
};
const scribe: RouterAgent = { key: "a2", name: "Scribe", description: "Takes meeting notes and writes summaries and recaps.", canReact: true };
const closer: RouterAgent = { key: "a3", name: "Closer", description: "Writes proposals, quotes and follow-up emails for deals.", canReact: true };

export interface RouterCase {
	name: string;
	input: RouterInput;
	/** By agent key. */
	expect: Record<string, RouterAction>;
}

const m = (author: string, text: string): RouterMessage => ({ author, text });
const bot = (agent: RouterAgent, text: string): RouterMessage => ({ author: agent.name, agent: agent.key, text });

function moment(
	name: string,
	{ agents = [companybot, scribe], people = ["Dana", "Luis", "Priya"], channel = "general", topic = null, parent = null, before = [], message }: {
		agents?: RouterAgent[];
		people?: string[];
		channel?: string;
		topic?: string | null;
		parent?: RouterMessage | null;
		before?: RouterMessage[];
		message: RouterMessage;
	},
	expect: Record<string, RouterAction>,
): RouterCase {
	const all = Object.fromEntries(agents.map((a) => [a.key, "quiet" as RouterAction]));
	return { name, input: { place: { name: channel, topic }, agents, people: people.filter((p) => p !== message.author), parent, before, message }, expect: { ...all, ...expect } };
}

export const routerCases: RouterCase[] = [
	// Questions meant for an agent, no @mention.
	moment("asks the bot by name", { message: m("Dana", "Companybot what's the status on the Hendricks deal?") }, { a1: "reply" }),
	moment("data question no person was asked", { message: m("Luis", "how many open leads do we have right now?") }, { a1: "reply" }),
	moment("asks 'the bot' generically", { message: m("Priya", "can the bot pull up last month's revenue?") }, { a1: "reply" }),
	moment("follow-up to the agent's answer", {
		before: [m("Dana", "@Companybot how many jobs did we close in September?"), bot(companybot, "You closed 14 jobs in September, $186k total.")],
		message: m("Dana", "and how about August?"),
	}, { a1: "reply" }),
	moment("asks the room a question the bot can answer", { message: m("Luis", "anyone know a good CRM tip?") }, { a1: "reply" }),
	moment("nudges an unanswered question", { before: [m("Luis", "anyone know a good CRM tip?")], message: m("Luis", "?") }, { a1: "reply" }),
	moment("nudges a question meant for a person", { before: [m("Luis", "Priya did the permit come back?")], message: m("Luis", "?") }, {}),
	moment("asks the room for something only a person knows", { message: m("Priya", "anyone seen my charger?") }, {}),
	moment("notes request goes to the note taker", { message: m("Luis", "Scribe can you write up the notes from this morning's standup?") }, { a2: "reply" }),
	moment("recap request without a name", {
		before: [m("Dana", "ok so we agreed: Luis takes the Oak St job, Priya handles the permit, kickoff Monday"), m("Priya", "👍")],
		message: m("Luis", "can someone summarize what we just decided for the folks who missed it?"),
	}, { a2: "reply" }),
	moment("proposal request picks the proposal writer", {
		agents: [companybot, scribe, closer],
		channel: "sales",
		message: m("Dana", "need a quote drafted for the Martinez re-roof, 2,400 sq ft, architectural shingles"),
	}, { a3: "reply" }),
	moment("do-a-task request", { message: m("Priya", "remind everyone the safety training is Thursday at 8, and add it as a task for me") }, { a1: "reply" }),
	moment("question in a thread under the agent's reply", {
		parent: bot(companybot, "Here are this week's 3 new leads: Ortiz, Chen, Walker."),
		message: m("Luis", "which of these came from the website form?"),
	}, { a1: "reply" }),
	moment("asks where a file or record is", { message: m("Dana", "where's the signed contract for the Baker job?") }, { a1: "reply" }),

	// Thanks and acknowledgements: a reaction.
	moment("thanks after an answer", {
		before: [m("Dana", "@Companybot what's Ortiz's phone number?"), bot(companybot, "Maria Ortiz: (555) 201-3344.")],
		message: m("Dana", "thanks!"),
	}, { a1: "react" }),
	moment("perfect, after notes", {
		before: [m("Luis", "@Scribe recap the client call"), bot(scribe, "Recap: client wants a start date before Nov 15, budget confirmed at $22k, needs gutter quote too.")],
		message: m("Luis", "perfect, exactly what I needed"),
	}, { a2: "react" }),
	moment("got it in a thread", {
		parent: m("Priya", "@Companybot when is the Walker inspection?"),
		before: [bot(companybot, "Thursday Oct 30, 10am, with the county inspector.")],
		message: m("Priya", "got it"),
	}, { a1: "react" }),
	moment("thanks to the proposal writer", {
		agents: [companybot, scribe, closer],
		channel: "sales",
		before: [m("Dana", "@Closer draft the follow-up to Hendricks"), bot(closer, "Draft: Hi Tom, following up on the estimate we sent Monday…")],
		message: m("Dana", "nice, sending it now. thank you"),
	}, { a3: "react" }),
	moment("ok answering the agent's question", {
		before: [m("Luis", "@Companybot add a task to call Chen"), bot(companybot, "Added \"Call Chen\" for you. Want a due date on it?")],
		message: m("Luis", "nah no due date is fine"),
	}, { a1: "react" }),

	// People talking to each other: nothing.
	moment("small talk", { message: m("Luis", "anyone else freezing in the office today?") }, {}),
	moment("lunch plans", { before: [m("Dana", "lunch at noon?")], message: m("Priya", "yes! tacos?") }, {}),
	moment("question to a named person", { message: m("Dana", "Luis did you get the shingles delivered to Oak St?") }, {}),
	moment("person answers person", { before: [m("Dana", "Luis did you get the shingles delivered to Oak St?")], message: m("Luis", "yep, dropped off at 9") }, {}),
	moment("thanks to a person, not the agent", {
		before: [bot(companybot, "Reminder: Walker inspection is tomorrow at 10."), m("Dana", "Priya can you cover the Walker inspection tomorrow?"), m("Priya", "sure, I'll be there")],
		message: m("Dana", "thanks Priya!"),
	}, {}),
	moment("team news", { message: m("Dana", "we just signed the Hendricks job!! 🎉") }, {}),
	moment("a joke", { before: [m("Luis", "ladder fell over again lol")], message: m("Priya", "that ladder has a personality") }, {}),
	moment("scheduling between people", { message: m("Priya", "can we move our 1:1 to 3pm Dana?") }, {}),
	moment("running late", { message: m("Luis", "running 10 min late to the site, traffic on 5") }, {}),
	moment("rhetorical complaint", { message: m("Dana", "why does it always rain on install days") }, {}),
	moment("talking about the bot, not to it", {
		before: [m("Luis", "the bot set up my tasks this morning")],
		message: m("Priya", "yeah it's been handy for me too"),
	}, {}),
	moment("message for one agent, not the other", {
		agents: [companybot, scribe, closer],
		channel: "sales",
		message: m("Luis", "Closer, write a short follow-up email to Chen about the gutter quote"),
	}, { a3: "reply" }),
	moment("ok to a person after the agent spoke earlier", {
		before: [bot(companybot, "There are 4 open tasks due today."), m("Dana", "Luis can you grab the permit packet from the county office?")],
		message: m("Luis", "ok will do"),
	}, {}),
	moment("thread among people under a person's message", {
		parent: m("Dana", "Thinking about switching shingle suppliers next year"),
		before: [m("Luis", "ABC has been late twice this month")],
		message: m("Priya", "agreed, their rep never calls back either"),
	}, {}),
	moment("greeting the team", { message: m("Priya", "good morning everyone ☀️") }, {}),
];
