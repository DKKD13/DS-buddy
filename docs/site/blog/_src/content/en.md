^ Notes on building AI products
# A really good agent product doesn't need the agent abstraction
> DS-buddy is open source today. This post records how my view of multi-agent changed while I built it, including the wrong turns.

Hi everyone.

DS-buddy is a plugin for DeepSeek Harness. You state a goal, it splits the goal into a few tasks, does them, and brings the finished work back to you.

The reason I built it is simple. When I worked with several agents at once, I spent most of my time being glue: briefing this one on the background, carrying that one's conclusion over, watching which one was stuck. The work that was actually mine, thinking the direction through, was what I had no time for.

## At first I gave the AI job titles too

In an early version every project was a group chat. It had a project assistant that created roles as needed. Each role had a name, a persona of a sentence or two, and an avatar of its own. I @-mentioned them in the chat to get work done.

It was the natural thing to do. We are used to organising work through people: who owns what, who to ask.

By the time I went back and counted, 18 roles had been created across 12 projects. But I found I didn't care which role was doing the work. I only cared how far the job had got and which model was on it.

Then I read the code. A role contributed three things: a name, a sentence or two of persona, and a default model. The session that did the work was opened per task, not per role. In other words, what was really doing the work was the context of that job plus a model. The role was a label stuck on top.

I deleted the feature that creates roles. A project now has one executor, and the interface shows the model it runs on.

It changed how I see the whole thing: managing agents is really managing context.

## Messages get distorted when they are passed on

With the roles gone, one relay was left: I tell the personal assistant about a job and it hands the job to a project.

On the morning of the release I went through a fresh install from the start and ran one comparison along the way. The same sentence, said directly to the project, opened two tasks after 16 seconds, and the first result came back at 48 seconds. Said to the personal assistant and handed on, it opened a single combined task that took 11.6 minutes to deliver.

The cause was that the assistant rewrote my words in the handoff and added a few requirements I had never stated. Downstream they were taken as my own words and followed.

Now a handoff may only quote my own words, and code checks that the sentence really is mine. Anything the assistant wants to add is marked separately and doesn't count as my request. When I tested again, two tasks were open within half a minute of the handoff.

Messages get distorted between people, and they do between agents too. That is also why fork works better than multi-agent most of the time: a fork carries the whole context across, with no paraphrase.

## One context per job

A fork has a cost too. It carries everything, so the longer the main conversation, the more it carries. Past a point the conversation has to be compacted, and details are lost.

So what I do now is organise context by task from the start, and not count on it growing by itself inside one conversation.

I say three things only: what to do, where the context is, and what the standard is. The AI splits that into tasks, and each task carries a record of its own: the goal, my own words, what counts as done, and how far it has got. Think of it roughly as a goal file.

That record is what gets maintained over time. The agent that works on it is temporary: by default a session in DeepSeek Harness, and it can be switched to Claude Code per task. After a switch, whoever takes over receives the same record.

How to put the context together at each start, and how to use the cache to save tokens, I haven't thought through yet, and I'm not sure the current way is the best. But these shouldn't be details a user has to worry about.

## Context has to come in by itself

By this point the AI was splitting the tasks, but I was still feeding the background: copying a chat thread, pasting a file, explaining where things stood yesterday.

So I added context collection. What is on screen is read once a minute, and Feishu messages every two minutes. Every 10 minutes this is organised into a timeline, filed under a project when it is clear which one. Files on the computer are read when needed. All of it is read-only and can be turned off at any time.

Collecting context automatically is nothing new. Screenpipe, AirJelly, Littlebird and the Computer History in Codex all do it. DS-buddy reads the screen through Screenpipe. The extra step I want is to connect that context to getting work done. At night it reviews the day and leaves up to three cards for the morning, telling me what could be done and what is worth a look.

## How others do it

Multica and Raft treat agents as teammates and organise the collaboration with tickets and group chat. Their underlying design is good and I borrowed a fair amount, such as a lasting record for each job and results that land where everyone can see them. Claude Projects lets several conversations in a project share one set of material, but only with Claude's models.

I differ from Multica and Raft on one point only: I don't want people to manage agents. How a job is split, who does it and what background it carries should be the AI's business.

## What it looks like now, and what isn't done

Open DS-buddy today and all you face is projects, tasks and one board called Waiting on you. The board has three lanes: waiting on you, in progress, done today. The first holds what needs you: decisions, acceptances and failures. A job is done only after you accept it. I want people to speak only at those points and stop carrying information around.

The assistant that is always there is called Tacit by default, as in tacit understanding. I want it to know the background of a job before you open your mouth.

Plenty isn't done yet:

- Tasks are split by the AI, but a project is still only created when you ask for one.
- The timeline isn't always right. Neighbouring stretches are easily written up as the same activity.
- Switching the executor only takes effect after a turn ends. Codex can be selected, but hasn't been verified through a complete task.

The code is on [GitHub](https://github.com/DKKD13/tacit-dsh). Screenshots and a detailed comparison with other products are in [the long version](deep/). Come and try it, and tell me where it doesn't hold up.
