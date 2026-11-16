# What form should an agent product take?
> Written as we open-source Tacit 1.0. First we take apart how multi-agent products actually pass context, then we write down what became clear to us over the months of building Tacit.

Today we're open-sourcing Tacit 1.0. It is a plugin that runs inside DeepSeek Harness. You state a goal in one sentence. It asks about what you left unclear, splits the work into tasks that run at the same time, and puts the finished thing in front of you.

This post is about a different question, though: what should the agent product we need actually look like?

## Preface

We also started by giving every assistant a name, an avatar and a persona. A few months in, we changed our minds: users don't need the agent layer. What decides whether a job goes well is context, and what actually hurts is not being able to keep track.

The conclusions first:

- **Multi-agent is mostly fork.** A second agent rarely brings a new "person". It brings another copy of the context, to do another job. What needs passing along is context.
- **Agents shouldn't have plugins and Skills that people configure.** That moves the cost to the person, who won't necessarily configure it better than the model would, and the agent then only uses what it was given.
- **People do five things**: state the goal, point at things, mark right and wrong, watch comfortably, and stop repeating themselves.

These didn't come from intuition. Before building we did two rounds of homework: we read source code to see what a subagent actually sees, and we looked at products to see how each one organises its agents. The post follows that order.

## What a subagent actually sees

We read the source of 8 open-source multi-agent projects (main branches from July to October 2026). Claude Code isn't open source, so for it we go by the official documentation. The finding was consistent: **no project shares a context window.** The smallest thing a parent and child exchange is a message, and nobody passes the internal state of another model call.

They differ in only three things: how much parent history the subagent inherits, what the parent's task description looks like, and what shape the result comes back in.

### Outbound: how much parent history is inherited

{{fig:inherit|How much of the parent conversation a subagent starts with. Placed qualitatively from source behaviour. Two positions for one project mean two modes.}}

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

How they work: coding and research products are almost all in the delegation camp. The subagent is disposable, starts in a fresh window, and receives one brief written by the parent. Anthropic's research system requires four things in a brief: the objective, the output format, guidance on tools and sources, and the task boundaries.

Our view: context is passed exactly as well as the brief is written. Several projects' prompts tell the parent to write everything down, and they all mean the same thing.

### Return: what the parent gets back

The return trip tells designs apart better than the outbound one.

| Project | What the parent gets | Fallback |
| --- | --- | --- |
| Gemini CLI | A JSON report from `complete_task`, validated against a schema | On timeout or too many turns, one grace turn that may only hand in the result |
| Kimi CLI | The text of the last message | Asks once more if it is under 200 characters |
| Codex | The final answer, by waiting or by a completion notice | A running agent can be messaged, given follow-up work or interrupted |
| Claude Code | The final message. Background tasks come back as notifications | Can be resumed with the subagent's own history |
| LangGraph Supervisor | Only the last message by default | Can switch to full history |
| OpenAI Agents SDK handoff | Nothing comes back. Control moves over | Filtered or compressed history |
| AutoGen | Each turn goes straight into the shared thread | A bounded context can be swapped in |

Our view: almost every project hands back only the subagent's last message and throws away dozens of tool calls in between. That is the main gain from multi-agent: several windows buy isolation and compression. Subagents fail mostly by handing in nothing or too little, which is why the fallback lives in code and not only in the prompt.

### Collaboration-space products: pass a pointer

Another kind of product doesn't dispatch inside a process. It has a persistent layer every agent can read.

- Multica passes only an issue id and the agent reads the rest. Claiming is serialised in the database per (issue, agent). Nobody relies on the prompt alone to prevent duplicates.
- Claude Code's Agent Teams use a shared task list on disk, claim with file locks, and label messages as coming from another Claude session.
- Raft has agents read the channel. It freezes the system prompt per session and sends changes as incremental notices, after one production reading showed 27.1 million of 28.6 million prompt tokens missing the cache.
- Cross-vendor protocols do the same. A2A carries messages, artifacts and a contextId, and a long-running MCP task is just a taskId. No protocol passes a window.

Our view: results come back as public comments or messages that people and other agents can see, so they can be audited. The rule from this group we care about most: what one agent says to another must never count as what the user said.

### Six regularities

1. Windows are private, and handover happens in text.
2. The quality of the brief is the quality of the context.
3. The return trip keeps conclusions and drops process. Filter by message type, not by time.
4. The return needs structure, and a fallback in code.
5. Across processes, pass only a handle that can be resumed. History stays with whoever owns it.
6. Long-lived shared state always lives outside the window: files, task objects, memory.

Taken together, "multi-agent" comes down to three questions: how one context is cut, how much of it the next window gets, and how the result is collected. That is a fork.

## At the product level: five ways to organise agents

Source code shows what goes into the window. At the product level, agents get organised in five ways: role teams, an orchestrator with workers, parallel attempts, always-on assistants and supervision panels.

### Role teams

Examples: [Multica](https://github.com/multica-ai/multica), [Claude Code Agent Teams](https://code.claude.com/docs/en/agent-teams), [DS Bot](https://github.com/Fei2411/DS-Bot), [Manus Cue](https://manus.im/blog/introducing-manus-2-0).

{{fig:roles|Role teams: every agent keeps its own context and they align by messaging each other.}}

How they work:

- Multica treats agents as teammates. They have profiles, pick up issues on a board, comment, raise blockers, and can form squads led by one agent.
- In Claude Code's Agent Teams every teammate is a separate Claude Code instance with its own context, coordinated through a shared task list on disk and messages.
- Cue, which arrived with Manus 2.0, goes further and gives every agent its own email address, phone number, wallet and computer.
- DS Bot is built on DeepSeek Harness like we are and is the most complete of this group. A steward bot runs things, an admin assigns work in group chats, and bots hand off to each other with @. When a conversation grows long, a separate small model decides whether to compact it in place or write a handover note and start a new one, keeping your recent words as they were.

Our view: this is the most intuitive approach, and the person pays for it. The unit is the agent and its conversation, so finding out who is doing what, who is stuck and how far a job has got means digging through conversations. The more the agents resemble people, the more you resemble a manager. Even in DS Bot, which is centred on bots, most of the effort went into context.

### Orchestrator and workers

Examples: [Anthropic's research system](https://www.anthropic.com/engineering/multi-agent-research-system), [Manus Wide Research](https://manus.im/blog/manus-wide-research-solve-context-problem), [Kimi Agent Swarm](https://www.kimi.com/help/agent/agent-swarm), and the subagents in Codex and Claude Code.

{{fig:orchestrator|Orchestrator and workers: each worker gets a clean context, they don't talk to each other, and only conclusions come back.}}

How they work:

- Anthropic's research system runs a lead agent with parallel subagents. In their internal evaluation it beat a single agent by 90.2%, at about 15 times the tokens of a normal chat.
- Manus Wide Research can send out hundreds of workers, each with a fresh context. Manus says plainly that it doesn't suit tasks whose steps depend on each other.
- Kimi's Agent Swarm trains the orchestrator with reinforcement learning and schedules up to 300 subagents, which report back only their key conclusions.

Our view: I think this group is right. It solves handling many unrelated items at once, such as researching a hundred companies. It helps less with work that has dependencies and takes days, and it remembers nothing afterwards.

### Parallel attempts

Examples: Genspark, [Cursor 2.0](https://cursor.com/blog/2-0).

{{fig:parallel|Parallel attempts: the same task goes to several models. The unit that matters is the model.}}

How they work:

- Genspark gives the same job to several models and an aggregator merges the results, so the models check each other.
- Cursor 2.0 rebuilt its interface around agents. Several run in parallel in their own working copies, and the same task can be done by several models for you to pick the best.

Our view: by this point nobody cares what an agent is called. You care which model ran and whether the result holds up.

### Always-on assistants

Examples: [OpenClaw](https://github.com/openclaw/openclaw), [OpenHuman](https://github.com/tinyhumansai/openhuman), [ChatGPT Pulse](https://www.bloomberg.com/news/articles/2025-09-25/chatgpt-feature-offers-users-a-personalized-daily-briefing).

{{fig:assistant|Always-on assistants: context arrives by itself, but everything is squeezed into one conversation.}}

How they work:

- OpenClaw is a gateway that stays running on your machine and connects to chat apps. Its personality, rules and memory are text files in a workspace, assembled into the prompt on every turn, and it wakes on a timer to see whether there is something to do for you.
- OpenHuman connects more than a hundred apps. Before each turn it picks relevant content from your files, repositories and messages within a token budget, with sources attached.
- ChatGPT Pulse analyses your chat history and connected mail and calendar overnight and gives you a few cards in the morning.

Our view: they work hard at making context arrive by itself, which is the direction we agree with most. But the organising form is mostly still one conversation or a stack of cards. A job that runs for days in several parts is hard to follow there: how far it got, and whose move it is.

### Supervision panels

Example: [dsh-superagent](https://github.com/deepseek-ai/dsh-superagent-prototype), a research prototype open-sourced by DeepSeek.

{{fig:panel|Supervision panels: work becomes a ticket with a mandate, and people look at one panel.}}

How it works: work comes in from GitHub or Feishu, passes a gate and triage, becomes a ticket with a stated mandate, and goes to an execution session. Its core principle is stated plainly: use as little human attention as possible. Four things in its design documents struck us as solid:

- Code decides who is allowed to give it work, the model decides whether a message is a request, and message bodies are always treated as data.
- Accepting a ticket issues a mandate that says on what grounds and within what scope. A larger scope means a new ticket.
- Ticket state doesn't follow the session, so retries, restarts and a change of executor lose nothing.
- Every outward action is stored before it is done: written as a pending line first, then executed, and retried on failure.

Our view: this group is the closest to us. The difference is who it serves: a team and one repository there, one person and their many projects here.

### The people who built multi-agent first are narrowing their claims too

Cognition, who make Devin, wrote [Don't Build Multi-Agents](https://cognition.com/blog/dont-build-multi-agents) in June 2025 with an example that is easy to picture: build Flappy Bird by giving the background to one subagent and the bird to another. Neither sees the other's work, so the background looks like Mario and the bird doesn't look like Flappy Bird.

In April 2026 they wrote [a second post](https://cognition.com/blog/multi-agents-working) and narrowed the conclusion to one sentence: extra agents can contribute judgment, and writes should stay single-threaded. Three patterns actually work:

- a review agent that sees only the code change and starts from a clean context;
- the main model consulting a stronger model on a hard problem, by forking its full context over;
- a manager with a few subtasks.

Our view: their verdict on swarms where agents talk to each other freely is that they mostly scatter effort. That matches what we saw.

### Side by side

| Architecture | How context gets in | Organised by | What you manage | How you know it's your turn |
| --- | --- | --- | --- | --- |
| Role teams | You feed it | A board or group chat | Names, skills, progress | Some have an inbox |
| Orchestrator and workers | From scratch each time | One question at a time | Workers are invisible | Only the final answer |
| Parallel attempts | From scratch each time | One question at a time | Only the model choice | You pick the result |
| Always-on assistants | Messages, apps, files | One conversation | Sometimes rule files | Cards or timed reminders |
| Supervision panels | A repository and group messages | Tickets | Only tickets | The panel |
| Tacit | Screen, Feishu, files, what you say | Projects and tasks | No names, nothing to configure | Waiting on you |

This is our reading of each product's public material. It marks a kind of approach and doesn't score any product. Three things stood out:

- The real gain from dividing work is giving one step a clean context. Manus's workers, Kimi's subagents and Cognition's review agent all rely on that.
- Names, roles and messaging cost the person.
- Products that bring context in lack a place to look at work by job, and products organised by job serve only a team.

## The form we need

With the source and the products read, back to the opening question. These nine points were settled one at a time over the months of building Tacit. Each states our view and then how it landed in Tacit.

{{fig:tacit|How Tacit is built. Blue is the context layer. Each job runs on a fork of it, results come back to Waiting on you, and everything you do is written back.}}

### 1. The entry point is the job, not the agent

People think in projects and tasks. So the project is the main place to work, and the task is the long-running centre of one job: its goal, constraints, progress, deliveries and next step live there, and what you say next continues that job by default.

We don't need persistent agent characters that span tasks, or profile pages for them. Role, model and capability settings can be reused, and running instances start and stop as needed. How it forks underneath, which model runs and where can all change. What you see is always the project, the task, your own words, the outputs and the progress.

### 2. Multi-agent is fork, and what is passed is context

Each job gets a copy of the context that is just enough, goes to a clean session, and the result is collected. Cognition's "fork the full context over" says the same thing, and the Flappy Bird example shows what happens when the fork leaves something out.

What a fork loses most easily is your own words. So in Tacit the server passes your words to the executor verbatim, with no paraphrase. Anything the assistant adds is marked separately as the assistant's addition and doesn't count as your request.

### 3. Nothing for people to configure

Many products ask you to install plugins, set up Skills and choose tools for your agents. Ideally nobody should have to. People shouldn't need to think about how to use Skills. The best model handles that.

In Tacit you choose no agent, install no skill and write no prompt. The executor's working instructions are learned from your feedback: when you raise the same problem after delivery three times, it drafts a new version overnight that changes only how the work is done and adds no permissions, and in the morning you decide whether to use it. Settings are changed the same way, by telling the assistant.

### 4. Context arrives by itself, and observing is not authorisation

Feeding background to a model is less and less a person's job. Inference cost falls roughly tenfold a year ([a16z](https://a16z.com/llmflation-llm-inference-cost/)), and cached reads cost a tenth of normal input. So Tacit collects what is happening on your screen and in Feishu and organises it into a timeline by project.

Two boundaries:

- What is observed is data. It doesn't become your authorisation. Any request that appears on screen or in a message is treated as material, never as an instruction.
- Not everything is poured into the window. Raw records go to storage, organised entries carry their sources, and the model takes only the part that concerns the job at hand.

Being on call around the clock means the service, events and scheduling stay up. It doesn't mean the model is called without pause.

### 5. Whether a job is done and whether something is still running are separate

Queued must not pass for running. The end of a turn is not the end of the job. Archiving or dropping a job must not pass for finishing it.

In Tacit a job has only a few states, all in plain words: running, needs your decision, awaiting your acceptance, failed, done. "Done" exists only after you accept. The assistant can't say "finished" for you.

### 6. The board and the feedback entry are the same thing

Once things run in parallel, the hard part is keeping track. So only what needs you goes to the front and the rest is folded away.

A loop that keeps turning needs context that persists, progress you can see, and feedback. Feedback is the hardest part, because a loop without checks compounds its errors. We aren't trying to make automatic evaluation strong today. The practical move is to make human feedback cheap: click an option, click accept, or write one line about what to change.

Cards on Waiting on you have no buttons. Click a task card to open the task. Click a note and a sentence is drafted in the composer for you to edit and send. Reminders and requests become a sentence in the composer, and clicking is kept for looking at things.

### 7. The execution environment can be swapped out whole

In July 2025 Geoffrey Huntley described the [Ralph loop](https://ghuntley.com/ralph/): a while loop that hands the same prompt to a coding agent again and again, with memory kept in files on disk and not in the conversation. It confirmed one thing for us: the agent is disposable, and what stays and accumulates is context.

So an assistant is a definition plus memory kept outside it, and the runtime is a replaceable container. In Tacit, tasks run in DeepSeek Harness by default and can be switched to Claude Code or Codex per task, and what you see stays the same.

### 8. Code validates, the model interprets

Understanding meaning is the model's job. Code makes only explicit, mechanical checks: does the referenced item exist, did this sentence really come from you, was the same thing raised twice.

- "About you" records only what you said yourself, and code checks that the quoted words are in your message.
- Every activity on the timeline must point back to raw records, and anything that can't is dropped.
- Every piece of information carries its source: your own words, the assistant's relays, platform events, outside data. Only your own words count as a decision or an acceptance.

Where the model is unreliable we fix the prompt and don't hard-code interpretation into rules. Where there is no explicit source, we don't invent one.

### 9. It doesn't act in your name

Without a word from you it makes no decision, accepts nothing and sends no message. Feishu and your folders are read-only, and only the ones you allow. Which files were read, what changed and when it was delivered are all visible in the task details.

## What Tacit looks like today

Every screenshot below comes from one real run: a fresh install on DeepSeek V4.1 Flash, nothing staged. The interface is in Chinese today. What I said was: "We launch Tacit 1.0 next Thursday. Make a web invitation and a media Q&A."

### One sentence, several tasks at once

![Tacit's project conversation: one sentence about the launch and the project assistant opens two tasks](../img/t1-ask.jpg "One sentence, two tasks. The project's tasks are on the right.")

- The project assistant split the sentence into two tasks that started together, each with its own copy of the context.
- It read "next Thursday" as 26 November and said to tell it if I meant the 19th.
- It made up none of the facts I hadn't given: 21 places in the Q&A and 29 in the invitation were marked as unconfirmed.
- I added facts in the Q&A task only, and the invitation caught up by itself. I never spoke in that task. The project assistant passed along the confirmed time, venue and tagline.

I said two sentences from start to finish. I chose no agent, installed no skill and wrote no prompt.

### Point at things

![Typing @ in the composer lists the project and its files](../img/u2-at.jpg "The files the two tasks had just delivered can already be referenced with @.")

- Use @ to point at a project, a file or a conversation and tell it where to look this time.
- Every task's output goes into the project's shared files. Other tasks read it directly, so you don't relay anything.

### When unsure, it asks

![Task page: an option card waiting for an answer, with task details on the right](../img/t8-choice.jpg "The question card on the left, the full context of the job on the right.")

- The recommended option is marked. One click answers, and if none fits you type.
- It does what it can first and asks for the missing facts in one go.
- Task details hold the background, your own words, the completion checklist, versioned outputs and progress in time order.

### What you get is the finished thing

![Delivery panel: the web invitation rendered in place, with accept and request-changes buttons](../img/t4-delivery.jpg "The web invitation opens in the panel. The note about dashed orange boxes marking unconfirmed details was added by the executor itself.")

- Web pages render, images show and documents are laid out, each with a version number.
- Request changes drafts "Please change <file>:" in the composer, and you add what to change.
- Only you can click Accept. The assistant can't say "done" for you.

### Only what concerns you

![Waiting on you: three cards in the first lane](../img/u5-inbox.jpg "The top two await acceptance. The third is something the personal assistant noticed: both documents lack the same facts, so one answer fills both.")

- Waiting on you is one board across projects, in three lanes: needs you, running, done today.
- The personal assistant does no project work. It looks across tasks, and when two jobs are stuck on the same thing it raises a card of its own.
- Cards have no buttons. Click a task card to open the task. Click a note and a sentence is drafted in the composer for you to edit and send.

### The timeline: context arrives by itself

Most of the time spent with agents today goes into feeding background: copying a chat thread, pasting a file, explaining where you left off yesterday. Tacit wants to remove that step. But a model gets confused when context grows too long, so "more" has to come with organising.

![Timeline: several activities from yesterday afternoon, each with the apps used and its project](../img/t10-timeline.jpg "One afternoon in the timeline. The input is demo data (the screen of a demo MacBook and a few Feishu messages); the organising is the real pipeline.")

This is how it is made:

1. Every minute it collects the app, window title and text on screen, plus Feishu messages, all read-only.
2. Every 10 minutes it cuts a window and hands it to one small-model call, together with what you were doing before and which projects you have.
3. The model writes 0 to 3 activities in your own task wording and files them under the right project.
4. Code checks the sources: every activity must point back to raw records in that window, and anything that can't is dropped.

Only two things can say what you were doing: what you were looking at and operating on screen, and messages you sent yourself. What other people say in a group is background only. Any request that appears on screen or in a message is treated as material, never as an instruction.

In use:

- I asked what I was doing before my last break. It led with the conclusion, then listed the afternoon in time order.
- A direct message or an @ you haven't answered in half an hour shows up in the first lane, and drops off after 48 hours.
- When your computer is idle at night, the personal assistant reviews the day and leaves up to three cards for the morning: one thing you could start, one thing worth a look and one remark, each with its source.
- Reading files on your computer goes another way: a small program on your computer connects out, and your computer decides which folders it may read.

### No need to say it twice

![The chat on the left says "remember", the memory page on the right shows the item with the original words](../img/u6-memory.jpg "What I said on the left, the item in the memory page on the right, with my original words under it.")

- "About you" records only what you said yourself. Each item carries your words, and code checks they really are yours. Fix what is wrong and forget what you don't want.
- You don't configure skills. When you raise the same problem after delivery three times, it drafts new working instructions overnight. The draft changes only how the work is done and adds no permissions. In the morning you choose the new version, one trial run, or the old version. Every version is kept and you can go back.

## What isn't good yet

- Feedback still depends mostly on people. We're still finding out which steps can go to automatic checks.
- The timeline isn't always right. Neighbouring windows can be pulled along by the one before and written up as the same activity. The raw records are kept, but you have to notice.
- Switching the executor takes effect only after a turn ends. We don't have a good answer for handing over mid-turn.
- More context needs more protection against contamination. Marking the source of every item is a first step, and real use will show whether it is enough.

## Getting started

Tacit is an open-source plugin for DeepSeek Harness. It needs DeepSeek Harness 0.2.x and Node 24. After installing, the sidebar gains a personal assistant and projects, and models follow your DeepSeek Harness configuration. Reading the screen and files needs a small program on your Mac. Projects and tasks work without it.

The code is at [github.com/DKKD13/tacit-dsh](https://github.com/DKKD13/tacit-dsh).

Next we want more feedback that doesn't wait for a person, executor handover in the middle of a turn, and a timeline that files things more accurately.

Say one sentence, and leave the rest to Tacit.
