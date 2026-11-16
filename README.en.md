# DS-buddy

**Exploring the best way for people and AI to work together.**

[中文](README.md)

Agents keep getting more capable, and people keep getting busier.

When you build an AI application today, the first and most central problem is lowering the bandwidth of communication between people and AI. The dilemma we keep facing is that we are run off our feet, playing the role of glue most of the time, and short of real time to think and set the right direction.

Before talking about multi-agent, let's start with one question.

## Fork vs multi-agent: managing agents is, at heart, managing context

When do you need a fork, and when do you need multiple agents? The answer is that most of the time we don't need multiple agents.

A fork shares: the new branch is born with the whole memory of the main conversation. Multi-agent passes things on: compress, retell, understand again, and every extra layer of passing loses a little more. Just as messages passed between people pick up errors, multiple agents pick up errors too, and they add a communication cost we don't need.

Why did everyone's abstraction of their scenarios go to agents first? Because we are used to organising context through people, each with a job of their own. But for an agent, all we need is context and a model (an agent is part context, part model). Agents differ from each other far less than people do; what matters more is the difference between models. The agent is an unnecessary layer of abstraction, and managing agents is, at heart, managing context.

But a fork can't save you from something else: the main conversation keeps swelling. Context that grows by itself in a conversation tends to get worse and worse: small talk, stale conclusions and the noise of work in progress all stay in, and keep using up the model's attention. So the best answer for context has to be designed consciously from the start, rather than refined as the conversation goes on.

## Context organised around the goal (the loop): runtimes and sessions are only temporary tools

For every core thread, the way of working has turned towards the goal, that is, the loop.

For each task, the problem with today's sessions is that most of the valuable context gets buried in the moving conversation. Yet the fixed index of a task is simple. It is usually a clear goal, where the repository is, the acceptance standard, and where the documents are.

So people only need to say three things clearly: what to do, where the context is, and what the standard is. The AI then breaks that down into a context pack for each task (thread). Think of the pack roughly as a goal file. It is what we really maintain over time, injected each time and updated each time.

As for the execution, the temporary agents are really tools. Their state is fragile; each is just a runtime, and the context is injected again each time. They hardly need maintaining.

## Hide the configuration details: trust the model, offer monitoring, leave the rest to the AI

Similar multi-agent products on the market today all expose too much. Multica and Raft offer a good way to organise, through group chats and tickets being passed along, and their underlying abstractions are well made; I borrowed their thinking and the way they are built. But for a person, setting up channels, configuring roles and dividing up the work is hard work in itself.

The details need wrapping. How the context is assembled, at which layer the cache hits, how tokens are saved: all of this is under the hood and shouldn't be put in front of the user. Wrapping it well also pays off: with the stable part at the front, the model can reuse what it read last time, and a cache hit and a cache miss differ in cost by an order of magnitude.

So in DS-buddy there are no agents to name and no skills to configure. But how far each job has got, and which model it went to, is always visible: every task has a page of details, and whatever needs you is on one board called Waiting on you.

## Collecting context fully: freeing people from carrying information around

For an AI to take over this layer, it first needs to take in enough of your context. That brings in our most important design: collecting context. What you do on screen and the messages in Feishu come in continuously and are organised into a timeline every 10 minutes; files on your computer are read when needed. All of it is read-only and can be turned off at any time.

Capturing context automatically isn't new. Screenpipe is the best-known example, along with AirJelly, Littlebird and the Computer History built into Codex, and they have existed for a while. But most of them haven't closed the loop from context to action.

I think this is how we will work in future: people express preferences and values and give the key guidance only at the points where they are really needed, instead of being reduced, as today, to carriers of information whose attention suffers. That lets people focus on what really matters.

The core assistant in DS-buddy is called Tacit by default, meaning tacit understanding. I think a really good buddy should know all the relevant context before you open your mouth.

DS-buddy: your next agent product may not need agents.

Read next: [the architecture](https://dkkd13.github.io/tacit-dsh/site/blog/en/deep/) explains how it is built, and [the guide](https://dkkd13.github.io/tacit-dsh/site/blog/en/guide/) explains how to work with Tacit.

[Architecture](https://dkkd13.github.io/tacit-dsh/site/blog/en/deep/) · [Guide](https://dkkd13.github.io/tacit-dsh/site/blog/en/guide/) · [Product page](https://dkkd13.github.io/tacit-dsh/site/) · [Film](https://github.com/DKKD13/tacit-dsh/releases/latest/download/tacit-film.mp4)

![One request, from the first sentence to finished work](docs/launch/demo.gif)

## Install

You need DeepSeek Harness (tested on 0.2.1) and Node 24 or later. If you do not have DeepSeek Harness yet: `npm install -g @deepseek-ai/dsh`.

```sh
git clone https://github.com/DKKD13/tacit-dsh
cd tacit-dsh/plugin
dsh plugin --profile web add "$(pwd)"    # add the plugin to DeepSeek Harness
dsh --profile web                        # start it and open the address it prints
```

The sidebar gains a personal assistant and projects. Create a project and state your first goal. The model is the one you configured in DeepSeek Harness. Step by step: [the guide](https://dkkd13.github.io/tacit-dsh/site/blog/en/guide/), or [`docs/GETTING-STARTED.md`](docs/GETTING-STARTED.md) (Chinese).

## Docs

- Getting started: [`docs/GETTING-STARTED.md`](docs/GETTING-STARTED.md)
- Features: [`docs/FEATURES.md`](docs/FEATURES.md)
- Test report: [`docs/TESTING.md`](docs/TESTING.md), with every finding and what was not verified

## Where it stands

Version 1.0. It runs only inside DeepSeek Harness, the interface is in Chinese for now, and Feishu is read-only. Claude Code as an executor has been run for real. Codex can be selected, but a complete task run on it has not been verified yet. Both run without permission prompts or a sandbox: they can read and write whatever your OS user can.

License: [MIT](LICENSE).
