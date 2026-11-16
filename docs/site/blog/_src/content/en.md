# A really good agent product doesn't need the agent abstraction
> Tacit 1.0 is open source today.

Most agent products start by introducing you to the agents. Give it a name, pick an avatar, set up its skills, add it to a group.

We see it differently.

Tacit starts from something simple: **what you want is the job done.** So in Tacit you never see the agent layer. There is no roster, no roles, no plugins or skills for you to configure. You see three things: projects, tasks, and a board called Waiting on you.

We didn't begin here. We also gave every assistant a name, an avatar and a persona. After a few months we found that the people using it cared about none of that. They asked two things: how far along is that job, and is it my turn yet.

Here is what that means for your day.

**You only state the goal.** I said one sentence: "We launch Tacit 1.0 next Thursday. Make a web invitation and a media Q&A." It split that into two jobs that started together, read "next Thursday" as 26 November and asked me to confirm. It made up none of the facts I hadn't given: 21 places in the Q&A and 29 in the invitation were marked for me to fill in. I didn't choose who would do the work, and I still don't know "who" did.

![Tacit's project conversation: one sentence about the launch opens two tasks](img/t1-ask.jpg)

**The extra agent is really another copy of the context.** We read the source of eight open-source multi-agent projects, and none of them shares a context window. A subagent receives a task description and hands back its last message. Taken apart, multi-agent is a fork: copy what this job needs to know, give it to a clean session, collect the result. So the thing to pass well is context, and who does the work matters much less. In Tacit your own words reach every task verbatim, with no paraphrase. I added the time and venue in the Q&A job only, and the invitation updated itself. Nobody relayed anything for me.

**When it's your turn, it comes to you.** Once things run in parallel, the hard part is keeping track. Waiting on you lists three kinds of things: what needs your decision, what awaits your acceptance, and what failed. The cards have no buttons. Click one and a sentence is drafted in the composer for you to edit and send. A job is done only after you accept it. The assistant can't say "finished" for you.

![Waiting on you: three cards in the first lane](img/u5-inbox.jpg)

**Nothing to configure, and nothing to say twice.** When you raise the same problem after delivery three times, it drafts new working instructions overnight and asks in the morning whether to use them. What happens on your screen and in Feishu is organised into a timeline, and every entry points back to the raw record. So you don't explain the background from scratch each time.

Agents will keep getting stronger and cheaper. What stays and accumulates is context: what you said, what you decided, what you accepted. The execution layer can be swapped out whole. Today it is a session in DeepSeek Harness, and you can switch a task to Claude Code or Codex. What you see stays the same.

If you think using AI means running an AI team, Tacit will surprise you a little. There is no team to run here.

Say one sentence. It gets it.

Tacit is an open-source plugin for DeepSeek Harness. The code is at [github.com/DKKD13/tacit-dsh](https://github.com/DKKD13/tacit-dsh). For how multi-agent products pass context, and the nine positions we settled on, read [the teardown](deep/).
