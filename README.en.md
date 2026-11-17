# DS-buddy

**Exploring the best way for people and AI to work together**

[中文](README.md)

Over the past six months I have kept falling into the same kind of tiredness: the models keep getting stronger, yet my own output hasn't kept up. A large share of each day's energy goes into switching back and forth between a few conversation windows: copying what one side produced over to the other, and filling in the background the other side missed. Without noticing, I became the glue between AIs, and had no time left to stop and think the direction through.

The problem probably isn't that AI isn't smart enough, but that the bandwidth between people and AI is too narrow. I wanted to make DS-buddy to try out a new way of interacting that brings this friction down.

**Most of the time, you don't need multiple agents. Managing agents is, at heart, managing context.** Many products now like to put the way human teams are organised straight onto AI: open a pile of agents, assign roles, set up channels, pass tickets along. It looks busy, but at heart it still simulates a human meeting room, using a human division of labour to cover up context that has been split apart. But to a model, a fork shares and multiple agents pass things along. As long as information is being passed along, some of it gets lost. Rather than having several agents message each other, fork the subtasks directly from one complete context; most of the time that is already enough to solve complex problems.

**The key to using AI well is to split the work into a structure that can be verified and has a clear goal: one goal and one loop at a time.** Since there is no need to divide the work through role play, what really needs maintaining is the structure of the tasks themselves. In DS-buddy, I have the assistant maintain a set of task files (goals): what the goal is, what counts as done, and where the context it depends on lives are all written down in plain words. Each core thread has its own stable context; add automations that run on a schedule, and a lot of everyday work naturally becomes a loop that keeps running without someone watching it all the time.

**We don't need the concept of an agent. The runtime details and the dynamic, fragmented state should stay hidden.** Following this line of thought, I even think "agent" itself is a needless middle layer. In products like Multica, users first have to configure Skills and runtimes for their agents, which forces people into tedious setup before any work has started. As I see it, tools and environments are just task context in the broad sense: they should grow as the project needs them, not be fixed in advance. So in DS-buddy I keep the fragmented runtime state underneath and expose only the model itself. One more layer of "agent" usually means one more thing to keep in your head. About the only thing you need to care about is writing, for each project, one sentence on which models it should prefer.

**You can do without the agent abstraction, but every runtime should stay visible.** Hiding complex concepts doesn't mean turning the system into a black box. When tasks run on their own in the background, people need something solid to lean on. So while taking away the agent abstraction, DS-buddy gives every run underneath a clear enough view: when the assistant was woken and by what, which tools it called in order, and how it turned out can all be looked up at any time in the developer view.

**Take in as much context as possible, use the best model to assign the work, then let the AI explore.** Building this product has also been a process of slowly letting go of my need for control. I believe more and more that giving the model enough context and trusting it to explore freely often beats people over-designing clever prompts. DS-buddy organises what you have done on your computer into a timeline and feeds it to the model as background; when the model is unsure about something while exploring, it is gathered on a board called Waiting on you. You only need to make the call at the key points, and let it find the rest of the way itself.

**A small suggestion: give the personal assistant the best model you can.** In this setup, the personal assistant (the coordinator) does the work that takes the most judgement: understanding what you mean, and breaking vague ideas into tasks of a sensible size. If that first split goes wrong, no amount of speed afterwards helps. So my experience is to give the personal assistant the highest-quality model you can use, such as Claude Opus 5.5 or GPT-6 Astra. Put your best tool where it counts, and everything runs much more smoothly.

Install it and try.

## How to use it

The interface is in Chinese for now.

**Install.** You need DeepSeek Harness (tested on 0.2.1) and Node 24 or later. If you do not have DeepSeek Harness yet: `npm install -g @deepseek-ai/dsh`.

```sh
git clone https://github.com/DKKD13/DS-buddy
cd DS-buddy/plugin
dsh plugin --profile web add "$(pwd)"    # add the plugin to DeepSeek Harness
dsh --profile web                        # start it and open the address it prints
```

The sidebar gains a personal assistant and projects. The personal assistant is called Tacit by default, and it watches all your projects. With the Claude Code or Codex command line installed, tasks can be handed to them; with the Feishu command line (lark-cli) installed and authorised, Tacit can read your Feishu messages, read-only.

**Hand over a job.** Create a project; you can give it a folder for the executor to work in. In the project's conversation, say one sentence that covers three things: what to do, where the context is, and what counts as good. The project assistant starts what it can and asks about what you left unclear.

Open a task to see its context: your own words, what counts as done, what it produced, the files it read, and its progress.

**Accept and decide.** Finished tasks, Feishu messages waiting for your reply and Tacit's own suggestions all land in Waiting on you. On a computer with Screenpipe, what you do on screen is organised into a timeline every 10 minutes, filed under a project when it is clear which one.

The cards have no buttons. Click a task card to open the task, where delivered pages, images and documents preview in place; accept it, or say exactly what to change. Click a message card and a whole request is written into the input box for you to edit and send.

**Models and executors.** Give a project a model strategy in one sentence: write it yourself, or just tell Tacit. Each task can switch its executor between DeepSeek Harness, Claude Code and Codex, and its model separately.

Claude Code and Codex run as executors without permission prompts or a sandbox: they can read and write whatever your OS user can.

**Every run is visible.** The developer view lists every time the assistant was woken: what woke it, the steps it took in order, which step failed, and what came of it.

**What you can tell Tacit:**

| You say | What it does |
| --- | --- |
| "Make me a project: hiring a front-end engineer" | Creates a project |
| "Give this to the hiring project: …" | Hands your own words to the project as written, which opens a task |
| "What's waiting for me?" "What happened today?" | Answers from the board and the timeline, each item with its source |
| "Tell the interview-questions task to add a CSS question" | Passes the message to that task |
| "Accept it" | Tells you what changed first, and accepts after you reply "confirm" |
| "Remember: I like to read the conclusion first" | Adds it to About you, with your words |
| "Use a cheaper model for this project from now on" | Records it as the project's model strategy, then switches models accordingly |

It doesn't send messages in your name. Without a word from you it makes no decision and accepts nothing.

**When something goes wrong:**

| What you see | What to do |
| --- | --- |
| The page says it can't reach the service and is reconnecting | The service stopped or is restarting. The page reconnects by itself when it is back. |
| A task stopped at failed | Open the task and read the last progress entry. It is usually a model or network error; tell it to carry on. |
| Nothing happens after switching to Codex | Codex has to be logged in on this machine first. |

## More

- [Introduction, full version](https://dkkd13.github.io/DS-buddy/site/blog/en/): the long version of this introduction
- [Architecture](https://dkkd13.github.io/DS-buddy/site/blog/en/deep/): how it is built
- [Product page](https://dkkd13.github.io/DS-buddy/site/), [film](https://github.com/DKKD13/DS-buddy/releases/latest/download/tacit-film.mp4)
- [Getting started](docs/GETTING-STARTED.md), [features](docs/FEATURES.md) and [test report](docs/TESTING.md) (Chinese)

## Where it stands

Version 1.0. It runs only inside DeepSeek Harness, the interface is in Chinese for now, and Feishu is read-only. Claude Code as an executor has been run for real. Codex can be selected, but a complete task run on it has not been verified yet. Both run without permission prompts or a sandbox: they can read and write whatever your OS user can.

License: [MIT](LICENSE).
