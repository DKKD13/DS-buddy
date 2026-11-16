# DS-buddy

**Say the goal. Make the calls.**

DS-buddy is an open-source plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). You state a goal in one sentence. It asks about what you left unclear, splits the work into tasks that run at the same time, and brings finished work back to you. You face projects, tasks and one board called Waiting on you. You never see the agent layer.

[Why it is built this way](https://dkkd13.github.io/tacit-dsh/site/blog/en/) · [Long read](https://dkkd13.github.io/tacit-dsh/site/blog/en/deep/) · [Product page](https://dkkd13.github.io/tacit-dsh/site/) · [Film](https://github.com/DKKD13/tacit-dsh/releases/latest/download/tacit-film.mp4) · [中文](README.md)

![One request, from the first sentence to finished work](docs/launch/demo.gif)

## Install

You need DeepSeek Harness (tested on 0.2.1) and Node 24 or later. If you do not have DeepSeek Harness yet: `npm install -g @deepseek-ai/dsh`.

```sh
git clone https://github.com/DKKD13/tacit-dsh
cd tacit-dsh/plugin
dsh plugin --profile web add "$(pwd)"    # add the plugin to DeepSeek Harness
dsh --profile web                        # start it and open the address it prints
```

The sidebar gains a personal assistant and projects. Create a project and state your first goal. The model is the one you configured in DeepSeek Harness. Step by step: [`docs/GETTING-STARTED.md`](docs/GETTING-STARTED.md) (Chinese).

## How it thinks

- **No agents for you to manage.** Work needs only context and a model. You say what to do, where the context is and what the standard is. It splits that into tasks, each carrying its own context.
- **Context comes in by itself.** What you do on screen and the messages in Feishu are organised into a timeline filed by project. All of it is read-only and can be turned off at any time.
- **The execution layer can be swapped.** Tasks run in DeepSeek Harness by default and can be switched to Claude Code per task. The record stays on the task, so nothing is lost in the switch.
- **It comes to you only when it is your turn.** A decision is yours, a delivery waits for your acceptance, or it is stuck. A job is done only after you accept it.

## Docs

- Getting started: [`docs/GETTING-STARTED.md`](docs/GETTING-STARTED.md)
- Features: [`docs/FEATURES.md`](docs/FEATURES.md)
- Test report: [`docs/TESTING.md`](docs/TESTING.md), with every finding and what was not verified

## Where it stands

Version 1.0. It runs only inside DeepSeek Harness, the interface is in Chinese for now, and Feishu is read-only. Claude Code as an executor has been run for real. Codex can be selected, but a complete task run on it has not been verified yet. Both run without permission prompts or a sandbox: they can read and write whatever your OS user can.

License: [MIT](LICENSE).
