# Tacit

**Say the goal. Make the calls.**

Tacit is an open-source plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). You state a goal in one sentence. It asks about what you left unclear, splits the work into tasks that run at the same time, and brings finished work back to you. In between, it comes to you only when a decision is yours to make.

[Product page](https://dkkd13.github.io/tacit-dsh/site/) · [Launch post](https://dkkd13.github.io/tacit-dsh/site/blog/en/) · [65-second film](https://github.com/DKKD13/tacit-dsh/releases/latest/download/tacit-film.mp4) · [中文](README.md)

![One request, from the first sentence to finished work](docs/launch/demo.gif)

## An example

In a project, you say:

> Tacit 1.0 launches next Thursday. Make a web invitation and a press Q&A.

Then:

1. **It asks first.** Which Thursday do you mean, and what colour should the invitation use? Whatever does not depend on the answer starts right away.
2. **It splits the work and runs it in parallel.** The invitation and the Q&A are two tasks, each with its own executor.
3. **When a call is yours, you get a card with options.** The recommended one is marked. If none fits, just say so.
4. **What comes back is finished work.** The page opens, the document reads. The task is done only when you click accept.

| 1 It asks first | 2 You decide |
| --- | --- |
| ![The project assistant asks about the colour and the date](docs/launch/clarify.png) | ![An option card](docs/launch/decision.png) |

| 3 You can see how far it is | 4 Finished work comes back |
| --- | --- |
| ![Task page](docs/launch/task-board.png) | ![A delivered web page opens in the panel](docs/launch/delivery.png) |

Everything that waits on you sits on one board:

![The board of things waiting on you](docs/site/assets/board.webp)

## How it differs from other agent tools

- **You see tasks, not agents.** No naming agents, no configuring skills, no room full of chats to watch. Every task has an executor behind it, but what you manage is the work.
- **Your words travel with the task.** Each task carries what you actually said. Anything it remembers about you links back to the sentence you said it in.
- **You do not have to watch.** It comes to you in three cases only: a decision is yours, a delivery waits for your acceptance, or it is stuck.

## Install

You need DeepSeek Harness (tested on 0.2.1) and Node 24 or later. If you do not have DeepSeek Harness yet: `npm install -g @deepseek-ai/dsh`.

```sh
git clone https://github.com/DKKD13/tacit-dsh
cd tacit-dsh/plugin
npm test                                 # 484 unit tests, optional
dsh plugin --profile web add "$(pwd)"    # add the plugin to DeepSeek Harness
dsh --profile web                        # start it and open the address it prints
```

The sidebar now shows 个人助理 (personal assistant) and 项目 (projects). Create a project and state your first goal in its conversation. Models follow your DeepSeek Harness settings. The interface is in Chinese for now.

A step-by-step guide (in Chinese, about ten minutes): [`docs/GETTING-STARTED.md`](docs/GETTING-STARTED.md).

## What is in it

- **One board of things waiting on you.** Three lanes: waiting on you, running, done today. Click a task card to open the task; click a message card and a reply is drafted in the input box.
- **Task page.** The brief with your own words, what counts as done, files read, progress by time. Take a task over yourself, then hand it back.
- **Swappable executors.** Tasks run on DeepSeek Harness by default. If Claude Code is on the machine, hand a task to it. Codex can be chosen too, but a full task run on Codex has not been verified yet.
- **Memory with a source.** "About you" keeps only what you said yourself, each line with the original quote. You can edit or forget any of it.
- **A night pass.** On nights when the computer is idle, the personal assistant goes over the day and leaves at most three items for the morning, each with its source.
- **Read-only sources.** Feishu messages and the Mac folders you allow. Both are read-only and can be switched off at any time.

Where each feature was learned from and which tests back it: [`docs/FEATURES.md`](docs/FEATURES.md) (Chinese).

## How it works

- Every assistant is an ordinary DeepSeek Harness session. You can open any of them and read what it did.
- All state is one event log. The board, the task page and memory are computed from it.
- Waking an assistant tells it only "how many new messages, from where". It reads the content itself, so a lost wake never loses a message.
- Code only checks: is the quoted line really in that message, does the number come from the material. Meaning and wording stay with the model.

## Where it stands

- Version 1.0, MIT license. 484 automated tests, run on Linux and macOS.
- It runs only inside DeepSeek Harness. The interface is in Chinese for now. Feishu is read-only.
- Claude Code as an executor has been run for real. For Codex, switching and start-up were tried, but a full task run on its own model has not been verified yet.
- Claude Code and Codex run without permission prompts or a sandbox: they can read and write whatever your OS user can.
- It never decides, accepts or sends messages on your behalf. Model keys stay on the machine that runs it.

Every test finding, and what was not verified: [`docs/TESTING.md`](docs/TESTING.md) (Chinese).

## More

- Getting started: [`docs/GETTING-STARTED.md`](docs/GETTING-STARTED.md)
- Features: [`docs/FEATURES.md`](docs/FEATURES.md)
- Test report: [`docs/TESTING.md`](docs/TESTING.md)
- How we benchmarked against Manus, Genspark and Raft: [`docs/launch/benchmark.md`](docs/launch/benchmark.md)

License: [MIT](LICENSE).
