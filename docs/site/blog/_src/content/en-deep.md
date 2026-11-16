^ Notes on building AI products · Long read
# How DS-buddy thinks: from multi-agent to context
> The short post gave only the conclusions. This one lays out the grounds: which abstraction each product chose, how context actually travels between agents, and how each point landed in DS-buddy.

Hi everyone. This is the long version of [the short post](../). Same line of thought, with comparisons and screenshots added.

## The first question: the bandwidth of talking to it

When you build an AI product, I think one question comes before all the others: how to lower the bandwidth a person has to spend talking to the AI. The less the person has to say the better, and the AI still has to get the job right.

Where does that bandwidth go today? Mostly into feeding background: copying a chat thread, pasting a file, explaining where you left off yesterday. Multi-agent products add more: naming agents, setting up their skills, and watching a room full of conversations to see who is stuck.

I want people to do five things only: state the goal, point at things, mark right and wrong, watch comfortably, and stop repeating themselves. Every design below removes some talking that falls outside those five.

## Why everyone went to agents first

Because we are used to organising context through people, each with a job of their own. So most of what the past year's products put in front of you is "people".

| Product | The abstraction you face | What you manage |
| --- | --- | --- |
| Raft, Multica, Claude Code Agent Teams | Agents are teammates, with names, identities, memory and their own inboxes | Names, skills, who is stuck |
| Manus Cue | Every agent has its own email, phone number and wallet | A team to run |
| Claude Code, Kimi Code, Codex | One main agent plus disposable subagents | Writing the task out in full, waiting for the summary |
| Manus Wide Research, Kimi Agent Swarm | One orchestrator plus hundreds of workers | One question at a time |
| Genspark, Cursor 2.0 | Several models each doing the same job | Picking the model, picking the result |
| OpenClaw, OpenHuman, ChatGPT Pulse | One assistant that is always there | One conversation that keeps growing |
| dsh-superagent | Tickets and one panel, with sessions hidden completely | Only the panel |

But what an AI needs in order to work is only two things: context and a model. Taken apart, an agent is some of the context plus some of the model. My own code is the same: an "assistant" is three things, a name, a persona and a default model, and sessions are opened per task.

Wrapping that in a named character adds a layer nobody needs. Here is how each of five ways of organising agents does it.

### Role teams

Examples: [Multica](https://github.com/multica-ai/multica), [Raft](https://raft.build/resources/blog/introducing-raft-where-humans-and-agents-build-together/), [Claude Code Agent Teams](https://code.claude.com/docs/en/agent-teams), [DS Bot](https://github.com/Fei2411/DS-Bot), [Manus Cue](https://manus.im/blog/introducing-manus-2-0).

{{fig:roles|Role teams: every agent keeps its own context and they align by messaging each other.}}

How they work: Multica treats agents as teammates with profiles that pick up issues on a board, raise blockers and form squads. Raft says it most directly: agents are first-class citizens with memory, identity and their own inbox, and they @ teammates and claim tasks in channels. In Claude Code's Agent Teams every teammate is a separate instance, coordinated through a shared task list on disk and messages. Manus Cue gives every agent its own email, phone number and wallet. DS Bot is built on DeepSeek Harness like DS-buddy, with a steward bot and bots that hand off to each other with @.

My view: this is the most intuitive approach, and the person pays for it. The unit is the agent and its conversation, so finding out who is doing what, who is stuck and how far a job has got means digging through conversations. The more the agents resemble people, the more you resemble a manager.

### Orchestrator and workers

Examples: [Anthropic's research system](https://www.anthropic.com/engineering/multi-agent-research-system), [Manus Wide Research](https://manus.im/blog/manus-wide-research-solve-context-problem), [Kimi Agent Swarm](https://www.kimi.com/help/agent/agent-swarm), and the subagents in Codex and Claude Code.

{{fig:orchestrator|Orchestrator and workers: each worker gets a clean context, they don't talk to each other, and only conclusions come back.}}

How they work: Anthropic's research system runs a lead agent with parallel subagents. In their internal evaluation it beat a single agent by 90.2%, at about 15 times the tokens of a normal chat. Manus Wide Research sends out hundreds of workers, each with a fresh context, and says plainly that it doesn't suit tasks whose steps depend on each other. Kimi's Agent Swarm trains its orchestrator and schedules up to 300 subagents.

My view: I think this group is right. It solves handling many unrelated items at once, such as researching a hundred companies. It helps less with work that has dependencies and takes days, and it remembers nothing afterwards.

### Parallel attempts

Examples: Genspark, [Cursor 2.0](https://cursor.com/blog/2-0).

{{fig:parallel|Parallel attempts: the same task goes to several models. The unit that matters is the model.}}

How they work: Genspark gives the same job to several models and an aggregator merges the results. Cursor 2.0 runs several agents in parallel in their own working copies, and the same task can be done by several models for you to pick the best.

My view: by this point nobody cares what an agent is called. You care which model ran and whether the result holds up. That already shows the role layer can be removed.

### Always-on assistants

Examples: [OpenClaw](https://github.com/openclaw/openclaw), [OpenHuman](https://github.com/tinyhumansai/openhuman), [ChatGPT Pulse](https://www.bloomberg.com/news/articles/2025-09-25/chatgpt-feature-offers-users-a-personalized-daily-briefing).

{{fig:assistant|Always-on assistants: context arrives by itself, but everything is squeezed into one conversation.}}

How they work: OpenClaw stays running on your machine. Its personality, rules and memory are text files in a workspace, and it wakes on a timer. OpenHuman connects more than a hundred apps and, each turn, picks relevant content within a token budget with sources attached. ChatGPT Pulse analyses your chat history and connected mail and calendar overnight and gives you a few cards in the morning.

My view: they work hard at making context arrive by itself, which is the direction I agree with most. But the organising form is mostly still one conversation or a stack of cards. A job that runs for days in several parts is hard to follow there.

### Supervision panels

Example: [dsh-superagent](https://github.com/deepseek-ai/dsh-superagent-prototype), a research prototype open-sourced by DeepSeek.

{{fig:panel|Supervision panels: work becomes a ticket with a mandate, and people look at one panel.}}

How it works: work comes in from GitHub or Feishu, passes a gate and triage, becomes a ticket with a stated mandate, and goes to an execution session. Sessions are hidden completely and people look at one panel. Its principle is stated plainly: use as little human attention as possible.

My view: this is the group closest to how I think. A session should be an implementation detail. The difference is who it serves: a team and one repository there, one person and their many projects in DS-buddy.

### The misunderstandings and failures this layer brings

- **Paraphrase loses things.** In [Don't Build Multi-Agents](https://cognition.com/blog/dont-build-multi-agents) (June 2025) Cognition gives an example: build Flappy Bird by giving the background to one subagent and the bird to another. Neither sees the other's work, so the background looks like Mario and the bird doesn't look like Flappy Bird.
- **What one agent says gets taken for what you said.** The more assistants there are, the easier it is for authorisation to be passed along falsely. So several products label where a message came from: Agent Teams marks messages as coming from another Claude session, and Multica separates "on whose behalf" from "with whose permission".
- **Two agents grab the same job.** Nobody relies on the prompt alone to prevent that: Agent Teams use file locks and Multica serialises claims in the database per (issue, agent).
- **Cost.** The 15 times token figure above is the price of opening more windows.

In April 2026 Cognition wrote [a second post](https://cognition.com/blog/multi-agents-working) and narrowed its conclusion to one sentence: extra agents can contribute judgment, and writes should stay single-threaded. Its verdict on swarms where agents talk to each other freely is that they mostly scatter effort.

## Why fork works better most of the time

A fork is simply shared context: what is already known goes across as it is. Between agents, context travels by paraphrase, and some of it is lost on the way.

The source code shows this. A teardown of the source of 8 open-source multi-agent projects (main branches from July to October 2026; Claude Code isn't open source, so its entry follows the official documentation) reaches a consistent finding: **no project shares a context window.** They differ in only three things: how much parent history the subagent inherits, what the parent's task description looks like, and what shape the result comes back in.

{{fig:inherit|How much of the parent conversation a subagent starts with. Placed qualitatively from source behaviour. Two positions for one project mean two modes.}}

Outbound, what the subagent sees:

| Project | What the subagent sees |
| --- | --- |
| Claude Code subagent (default) | Its own system prompt, environment details, CLAUDE.md, and a delegation message written by the main agent. It doesn't see the parent conversation or the files already read |
| Claude Code fork | The parent's full conversation. Used when the job needs all the background and shouldn't pollute the main window |
| Kimi CLI | Only the prompt, plus its own history. Its system prompt says outright that the main agent can't see its context, only its last message |
| Gemini CLI | A local subagent gets only the task description, which must include the user's original objective. A remote agent gets only a contextId and a taskId |
| Codex | `spawn_agent` passes only the task. A fork keeps user messages and final answers and drops reasoning and tool round-trips |
| OpenAI Agents SDK handoff | The whole conversation by default. It can be filtered, or compressed into a summary first |
| LangGraph, AutoGen | They read and write one shared state, or everyone shares one message thread |
| CrewAI | Only the output of the upstream task. Its prompt says the other side knows nothing about the task |

On the way back, what the parent gets:

| Project | What the parent gets | Fallback |
| --- | --- | --- |
| Gemini CLI | A JSON report from `complete_task`, validated against a schema | On timeout or too many turns, one grace turn that may only hand in the result |
| Kimi CLI | The text of the last message | Asks once more if it is under 200 characters |
| Codex | The final answer, by waiting or by a completion notice | A running agent can be messaged, given follow-up work or interrupted |
| Claude Code | The final message. Background tasks come back as notifications | Can be resumed with the subagent's own history |
| LangGraph Supervisor | Only the last message by default | Can switch to full history |
| OpenAI Agents SDK handoff | Nothing comes back. Control moves over | Filtered or compressed history |
| AutoGen | Each turn goes straight into the shared thread | A bounded context can be swapped in |

My view: the default is to pass one description and collect one last message. Context is passed exactly as well as the task description is written, and several projects' prompts tell the parent to write everything down. Fork is the exception: Claude Code and Codex both keep a fork mode for when all the background is needed. Among the patterns Cognition found to actually work, one is forking the full context over to consult a stronger model.

## But a fork doesn't fix a main conversation that keeps growing

A fork carries all the background across, at the price of a window that starts large and costs more. The main conversation keeps growing too, until it has to be compacted, and compaction is lossy: details go missing. A model also gets confused when context grows too long.

So I think the best answer for context has to be designed on purpose from the start. It doesn't grow out of a conversation that just keeps going. What multi-agent is really for is giving the AI a good environment for managing context, organised around the task itself.

## Designed from the start: the person says three things, the AI splits the work

Which way should that be built? Not, I think, by having people run it: setting up channels, forming groups, deciding who to @. A person only needs to say three things clearly: what to do, where the context is, and what the standard is.

**What to do.** State a goal in the project. This time I said: we launch next Thursday, make an invitation, then write a media Q&A, a slogan and a press release, and ask me before starting whether the slogan is in Chinese or English. It opened two tasks that started together. It didn't open the slogan one and came back to ask first.

![The project conversation: one sentence about the launch opens two tasks and asks about the slogan first](img/film-ask.jpg "One sentence, two tasks, one question. The interface is in Chinese today.")

**Where the context is.** Point at it with @: a project, a file, or another conversation. Every task's output goes into the project's shared files, and other tasks read it directly, so I relay nothing.

![Typing @ in the composer lists the project and its files](img/u2-at.jpg "The files the two tasks had just delivered can already be referenced with @.")

**What the standard is.** Every task has a "what counts as done" list. When it is finished it comes to me, and the job is done only after I accept it. The assistant can't say "finished" for me.

![Delivery panel: the web invitation rendered in place, with Accept at the top right](img/film-accept.jpg "What comes back is the finished thing. The web page opens in place.")

The AI then splits that into tasks (threads), and each task carries a context pack. Think of it roughly as a goal file.

{{fig:pack|One context pack per task. The pack is what gets maintained over time. The runtime that works on it is disposable: the pack is injected when work starts and progress is written back.}}

The task details page is that pack as a person sees it:

![Task details: my own words attached under the background, with the completion list below](img/film-context.jpg "The passage under the background is what I actually said. Below it is what counts as done.")

That pack is the thing to maintain over time. In the product it comes down to these:

- **Your own words go in verbatim.** When the project assistant cites your sentence in opening a task, the server passes it to the executor as written. Anything the assistant adds is marked separately and doesn't count as your request.
- **Progress is written back.** Deliveries, questions and failures are recorded on the task. State follows the job, not the session.
- **Only what is useful goes in.** Large material sits in the project's shared files and only the path is passed. Memory and the timeline contribute only the part that concerns this job, each item with its source.
- **Definite judgments go to code.** Whose words count as authorisation, whether a quote really is in the original message, whether the same thing was raised twice: code checks these and the model only interprets.

## Agents are tools, and a runtime can always be started again

As for the agents that do the work for a while, they are really tools. Their state is fragile and doesn't need much maintaining: each is a runtime, and the context is injected again each time.

{{fig:tacit|How DS-buddy is built. Blue is the context layer. Each job runs on a fork of it, results come back to Waiting on you, and everything you do is written back.}}

In DS-buddy a task runs in a DeepSeek Harness session by default and can be switched to Claude Code or Codex per task. On a switch the new executor receives the record kept on the task, and what you see stays the same. The same job continues the same session, and only a different job starts a new one.

There are plenty of details here: whether each agent starts in a brand-new context, and how to save tokens around the cache. Others have put real work into this. Multica keeps the fixed brief first and appends each run's information at the end. Raft found, in one production reading, that 27.1 million of 28.6 million prompt tokens had missed the cache, and then changed to freezing the system prompt per session and sending changes as incremental notices.

I'm not sure DS-buddy's current design is the best one. But these shouldn't be details a user can feel.

## Today's products expose too much

Multica and Raft both offer a very good layer of abstraction. Multica uses tickets: agents pick up issues on a board and write results as comments. Raft uses group chat: agents sit in channels, read when they are @-mentioned, and claim tasks themselves. These are good ways to organise, and results land on a shared record that people and other agents can see.

It still isn't effortless enough. Someone has to set up the channel, open the issue and decide who to @ for what. For a person, building context and dividing up the work is itself hard work. Ideally the AI does that layer.

| Architecture | How context gets in | Organised by | What you manage | How you know it's your turn |
| --- | --- | --- | --- | --- |
| Role teams | You feed it | A board or group chat | Names, skills, progress | Some have an inbox |
| Orchestrator and workers | From scratch each time | One question at a time | Workers are invisible | Only the final answer |
| Parallel attempts | From scratch each time | One question at a time | Only the model choice | You pick the result |
| Always-on assistants | Messages, apps, files | One conversation | Sometimes rule files | Cards or timed reminders |
| Supervision panels | A repository and group messages | Tickets | Only tickets | The panel |
| DS-buddy | Screen, Feishu, files, what you say | Projects and tasks | No names, nothing to configure | Waiting on you |

This table is my reading of each product's public material. It marks a kind of approach and doesn't score any product.

## The most important design: collecting context

For the AI to do the dividing itself, it first has to have taken in enough of your context. That is what Multica and Raft lack today: the one dividing work into projects and tasks is still the person. So the most important design in DS-buddy is collecting context.

![Every 10 minutes, raw records are organised into what you were doing](img/film-10min.jpg "How the timeline is made: raw records land on a time bar and are organised every 10 minutes. Illustration.")

This is how it is made:

1. The app, window title and text on screen are read once a minute, and Feishu messages every 2 minutes. All of it is read-only, and screenshots stay on your computer.
2. Every 10 minutes it cuts a window and hands it to one small-model call, together with what you were doing before and which projects you have.
3. The model writes 0 to 3 activities in your own task wording and files them under the right project.
4. Code checks the sources: every activity must point back to raw records in that window, and anything that can't is dropped.

![The timeline: a morning's activities, each with the apps used and its project](img/film-timeline.jpg "The organised timeline. Each entry carries the apps used and the project it belongs to.")

Two boundaries:

- What is observed is data. It doesn't become your authorisation. Any request that appears on screen or in a message is treated as material, never as an instruction.
- Not everything is poured into the window. Raw records go to storage, and the model takes only the part that concerns the job at hand.

Files on your computer go another way: a small program on your computer connects out, and your computer decides which folders it may read.

## You only make the calls

Once things run in parallel, the hard part is keeping track. Waiting on you is one board across projects that lists only what needs you: decisions, acceptances, failures, and messages someone is waiting for you to answer.

![Waiting on you: clicking a reminder card drafts the reply in the composer](img/film-board.jpg "Someone in a group is waiting for your reply, and it noted that first. One click and the reply is drafted.")

- Cards have no buttons. Click a task card to open the task. Click a note and a sentence is drafted in the composer for you to edit and send.
- The personal assistant does no project work. It looks across tasks. When your computer is idle at night it reviews the day and leaves up to three cards for the morning: one thing you could start, one thing worth a look and one remark, each with its source.
- Whether a job is done and whether something is still running are separate. Queued must not pass for running, and the end of a turn is not the end of the job. Done exists only after you accept.

## Tacit, as in tacit understanding

The assistant inside is called Tacit by default, as in tacit understanding. I think a really good buddy should already know everything relevant to the job before you open your mouth.

![The chat on the left says "remember", the memory page on the right shows the item with the original words](img/u6-memory.jpg "What I said on the left, the item in the memory page on the right, with my original words under it.")

- "About you" records only what you said yourself. Each item carries your words, and code checks they really are yours. Fix what is wrong and forget what you don't want.
- You don't configure skills. When you raise the same problem after delivery three times, it drafts new working instructions overnight. The draft changes only how the work is done and adds no permissions. In the morning you choose the new version, one trial run, or the old version.
- It doesn't act in your name. Without a word from you it makes no decision, accepts nothing and sends no message. Feishu and your folders are read-only, and only the ones you allow.

## What isn't good yet

- Feedback still depends mostly on people. I'm still finding out which steps can go to automatic checks.
- The timeline isn't always right. Neighbouring windows can be pulled along by the one before and written up as the same activity. The raw records are kept, but you have to notice.
- Switching the executor takes effect only after a turn ends, and there is no good answer yet for handing over mid-turn. Codex as an executor has not yet been verified through a complete task.
- How each agent's context is put together when it starts, and how the cache is used: I'm not sure the current way is the best.
- More context needs more protection against contamination. Marking the source of every item is a first step, and real use will show whether it is enough.

## Getting started

DS-buddy is an open-source plugin for DeepSeek Harness. It needs DeepSeek Harness 0.2.x and Node 24. After installing, the sidebar gains a personal assistant and projects, and models follow your DeepSeek Harness configuration. Create a project and state your first goal. Reading the screen and files needs a small program on your Mac. Projects and tasks work without it.

The code is at [github.com/DKKD13/tacit-dsh](https://github.com/DKKD13/tacit-dsh).

![The agents stay in the back. You only decide.](img/film-closing.jpg "The closing line of the film: the agents stay in the back, you only make the calls.")

About the images: the ones with film captions come from the demo film. The interface is real, the data is demo data, and the one marked as an illustration is drawn. The other screenshots come from a real run on a fresh install.
