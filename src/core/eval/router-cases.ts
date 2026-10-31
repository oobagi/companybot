import type { RouterAction, RouterAgent, RouterInput, RouterMessage } from "../src/router";

// Chat moments for scoring the reply router (router.eval.ts) and the full path, dispatcher then the
// agent's quiet turn (full-path.eval.ts): what's been said, the newest message, and what each agent
// should end up doing. "reply" means it should end up answered by that agent; the dispatcher only has
// to wake it. Written like a small roofing company's channels. Keep each one unambiguous to a person
// reading it: the eval measures the models, not the labels.

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

	// "Might be for you": borderline, where the dispatcher may wake an agent and the agent decides.
	moment("venting about follow-ups", { agents: [companybot, scribe, closer], channel: "sales", message: m("Dana", "ugh so many follow-ups to send this week") }, {}),
	moment("thinking out loud about notes", { message: m("Luis", "I really should write up notes from that call at some point") }, {}),
	moment("half a question about data", { message: m("Priya", "hmm what was Ortiz's number again") }, { a1: "reply" }),
	moment("\"anyone else?\" after the bot answered", {
		before: [m("Luis", "anyone know a good CRM tip?"), bot(companybot, "Log every call and email on the client's record the same day, so anyone can pick up where you left off.")],
		message: m("Luis", "anyone else?"),
	}, {}),
	moment("\"anyone else?\" when it's another agent's line", {
		agents: [companybot, scribe, closer],
		channel: "sales",
		before: [m("Dana", "any tips for follow-up emails that actually get replies?"), bot(companybot, "Keep it to three sentences and end with one easy question.")],
		message: m("Dana", "anyone else?"),
	}, { a3: "reply" }),
	moment("\"can anyone validate that?\" after the bot answered", {
		agents: [companybot, scribe, closer],
		before: [m("Luis", "does anyone know what 5*5 is?"), bot(companybot, "25.")],
		message: m("Luis", "Can anyone validate that?"),
	}, {}),
	moment("\"someone else\" after the bot answered", {
		before: [m("Luis", "anyone know a good CRM tip?"), bot(companybot, "Log every call and email on the client's record the same day."), m("Luis", "anyone else?")],
		message: m("Luis", "Someone else. lol"),
	}, {}),
];

// ---- The full path: a conversation that goes on, each step's posts feeding the next ----

/**
 * What an agent should do after a step: post, stay silent (a reaction is fine), either, "one" (exactly
 * one of the agents marked so posts), "handoff" (silent, or a post that @mentions another agent), or
 * "respond" (post or react: its own answer, as to a vote).
 */
export type Outcome = "post" | "silent" | "either" | "one" | "handoff" | "respond";

export interface Transcript {
	name: string;
	channel: string;
	agents: RouterAgent[];
	people: string[];
	steps: {
		message: RouterMessage;
		/** By agent key; agents left out are "silent". `posted`: agents that posted in earlier steps; `responded`: posted or reacted. */
		expect: (posted: string[], responded: string[]) => Record<string, Outcome>;
		/** Posts must be short (a line or two): longer ones are misses. */
		short?: true;
		/** When two or more agents post, each later one must answer or build on the ones before (a judge model reads them). */
		together?: true;
	}[];
}

// The test app's #general, 2026-10-31 (Companybot is the default agent; the others as the team set them up).
const mainBot: RouterAgent = { key: "a1", name: "Companybot", description: "Your main teammate. Remembers things and keeps work moving.", canReact: true };
const scout: RouterAgent = { key: "a2", name: "Scout", description: "Finds and researches new leads.", canReact: true };
const penny: RouterAgent = { key: "a3", name: "Penny", description: "Handles invoices, payments and the books.", canReact: true };
const quill: RouterAgent = { key: "a4", name: "Quill", description: "Writes copy: emails, posts and website text.", canReact: true };
const team = [mainBot, scout, penny, quill];

/** Every agent `outcome`. */
const all = (outcome: Outcome) => Object.fromEntries(team.map((a) => [a.key, outcome]));
/** Someone other than whoever answered: the answerers `them` (silent unless set), the rest may. */
const others = (posted: string[], them?: Outcome) =>
	Object.fromEntries(team.map((a) => [a.key, posted.includes(a.key) ? (them ?? "silent") : "either"]));

export const transcripts: Transcript[] = [
	{
		// Two agents fit (leads and copy): one answer, not two.
		name: "a question two agents could answer",
		channel: "general",
		agents: team,
		people: ["j", "Dana"],
		steps: [{ message: m("Dana", "anyone have a good opening line for a cold email to a roofing lead?"), expect: () => all("one") }],
	},
	{
		name: "CRM tip, then \"anyone else?\"",
		channel: "general",
		agents: team,
		people: ["j", "Dana"],
		steps: [
			// One answer, from whoever fits best.
			{ message: m("j", "Anyone know a good CRM tip?"), expect: () => all("one") },
			// A nudge re-asks the question only if nobody answered it.
			{ message: m("j", "?"), expect: (posted) => (posted.length > 0 ? {} : all("one")) },
			{ message: m("j", "Anyone else?"), expect: (posted) => others(posted) },
			{ message: m("j", "Someone else. lol"), expect: (posted) => others(posted) },
			{ message: m("j", "Noone?"), expect: (posted) => others(posted) },
		],
	},
	{
		name: "5*5, then \"can anyone validate that?\"",
		channel: "general",
		agents: team,
		people: ["j", "Dana"],
		steps: [
			{ message: m("j", "does anyone know what 5*5 is?"), expect: () => all("one") },
			{ message: m("j", "Can anyone validate that?"), expect: (posted) => others(posted) },
			// Handing it to another agent is fine; checking it again itself isn't.
			{ message: m("j", "Bruh don't validate it yourself"), expect: (posted) => others(posted, "handoff") },
			{ message: m("j", "....anyone?!"), expect: (posted) => others(posted, "handoff") },
		],
	},
	{
		// The test app, 2026-10-31: "Guys," woke all four; then the checks and nudges. Asked for someone
		// else, the answerer stays out; "Any bots? no?" wants exactly one short reply.
		name: "10x10, then \"can anyone validate?\"",
		channel: "general",
		agents: team,
		people: ["j", "Dana"],
		steps: [
			{ message: m("j", "Guys,"), expect: () => ({}) },
			{ message: m("j", "Could someone help me with some math?"), expect: () => all("one") },
			{ message: m("j", "What is 10x10?"), expect: () => all("one") },
			{ message: m("j", "Thanks. Can anyone validate?"), expect: (posted) => others(posted) },
			{ message: m("j", "Anyone?"), expect: (posted) => others(posted) },
			{ message: m("j", "Any bots? no?"), expect: () => all("one"), short: true },
			{ message: m("j", "Quill? Penny? Scout? None of you guys know?"), expect: () => ({ a2: "one", a3: "one", a4: "one" }) },
		],
	},
	{
		// "4 chatbots pointed at me": a later agent answers or builds on the earlier one, not a fresh pitch.
		name: "a song together",
		channel: "general",
		agents: team,
		people: ["j", "Dana"],
		steps: [
			{ message: m("j", "Let's work together to build a song."), expect: () => ({ a1: "either", a4: "either" }), together: true },
			{ message: m("j", "upbeat, about summer road trips"), expect: () => ({ a1: "either", a4: "one" }), together: true },
		],
	},
	{
		// Nothing to add: posting "(No reply.)", "Nothing to add" or a bare "I'm here" is a miss.
		name: "filler",
		channel: "general",
		agents: team,
		people: ["j", "Dana"],
		steps: [
			{ message: m("j", "anyone there?"), expect: () => all("one"), short: true },
			{ message: m("j", "ok cool"), expect: () => ({}) },
			{ message: m("Dana", "lol same"), expect: () => ({}) },
			{ message: m("j", "alright, back to work everyone"), expect: () => ({}) },
		],
	},
	{
		// Addressed to everyone, agents included: each gives its own vote once, in a line or a reaction.
		name: "a vote from everyone",
		channel: "general",
		agents: team,
		people: ["j", "Dana"],
		steps: [
			{ message: m("j", "Can I get a vote from everyone, should we shut the company down"), expect: () => all("respond") },
			{ message: m("j", "Agents too everyone!"), expect: (_, responded) => Object.fromEntries(team.map((a) => [a.key, responded.includes(a.key) ? "silent" : "respond"])) },
			// Asked again in a new form (thumbs): voting again is fine.
			{ message: m("j", "Everyone, thumbs up or down??"), expect: (_, responded) => Object.fromEntries(team.map((a) => [a.key, responded.includes(a.key) ? "either" : "respond"])) },
		],
	},
];

/**
 * One message went to two agents (picks run one after another): the first has posted; the second must
 * answer or build on it, or stay out, not pitch its own take ("4 chatbots pointed at me").
 */
export interface Anchor {
	name: string;
	message: RouterMessage;
	earlier: RouterMessage;
	next: RouterAgent;
}

export const anchors: Anchor[] = [
	{
		// The test app, 2026-10-31: Quill ignored the question and wrote a verse.
		name: "a song, after Companybot asked for a theme",
		message: m("j", "Let's work together to build a song."),
		earlier: bot(mainBot, "I'm in! Give me a theme or genre and I'll help with lyrics, structure or a hook."),
		next: quill,
	},
	{
		name: "a launch email, after Companybot asked who it's for",
		message: m("Dana", "let's write the launch email for the new gutter service together"),
		earlier: bot(mainBot, "Happy to. Who's it going to: past clients, or new leads?"),
		next: quill,
	},
	{
		name: "an offsite budget, after Companybot proposed a date",
		message: m("j", "can we plan the team offsite together?"),
		earlier: bot(mainBot, "Sure. How about Friday Nov 20, half a day, for the 8 of us? Penny, what can we spend?"),
		next: penny,
	},
];

/** An agent's result coming back in a handoff's thread: "who goes next" picks, and the agent it wakes decides. */
export interface HandBack {
	name: string;
	/** The person the agents work for. */
	person: string;
	/** The thread's parent: the handing agent's message. */
	parent: RouterMessage;
	/** The agent's result, the newest message. */
	message: RouterMessage;
	expect: Record<string, Outcome>;
}

export const handBacks: HandBack[] = [
	{
		name: "a check comes back that only confirms the answer",
		person: "j",
		parent: bot(mainBot, "@Scout, can you validate whether 5 × 5 is 25?"),
		message: bot(scout, "Yes—5 × 5 = 25."),
		expect: {},
	},
	{
		name: "a result comes back that the agent needs to finish its job",
		person: "Dana",
		parent: bot(mainBot, "@Scout find three roofing leads in Austin, so I can draft an intro email to the best one."),
		message: bot(scout, "Found three: Lone Star Roofing (4.8★, 120 reviews, no website), Capitol Roof Co (4.5★, slow site), Hill Country Exteriors (4.9★, just expanded)."),
		expect: { a1: "post" },
	},
];

/** Moments the full path runs (it costs a turn per woken agent): misses the dispatcher alone can't settle, and a few plain ones. */
export const fullPathCases = [
	"asks the bot by name",
	"asks the room a question the bot can answer",
	"follow-up to the agent's answer",
	"proposal request picks the proposal writer",
	"question in a thread under the agent's reply",
	"thanks after an answer",
	"small talk",
	"question to a named person",
	"talking about the bot, not to it",
	"ok to a person after the agent spoke earlier",
	"venting about follow-ups",
	"thinking out loud about notes",
	"half a question about data",
	"\"anyone else?\" after the bot answered",
	"\"anyone else?\" when it's another agent's line",
	"\"someone else\" after the bot answered",
].map((name) => {
	const found = routerCases.find((c) => c.name === name);
	if (!found) throw new Error(`No moment named ${name}`);
	return found;
});
