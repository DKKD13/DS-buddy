^ Notes on building AI products
# Introducing DS-buddy: say the goal, make the calls

This past year, agent products have been turning into teams. Agents get names, roles, channels and tickets of their own, and the person sits in the middle @-mentioning them. The agents keep getting more capable, and the people using them keep getting busier: briefing this one on the background, carrying that one's conclusion over, watching which one has finished and which one is stuck.

I see it differently. Take an agent apart and it is a piece of context plus a model. Managing agents is managing context. A really good agent product doesn't need to put the agent layer in front of people.

DS-buddy is built on that idea, as an open-source plugin for DeepSeek Harness. You state a goal, it asks about whatever is unclear, splits the goal into a few tasks that run at the same time, and brings the finished work back to you. All you face is projects, tasks and one board called Waiting on you.

Here is what that means for your day.

**You say three things.** What to do, where the context is, and what the standard is. For example: "Using the job description, write a second-round interview set, interview.md: 3 questions on motion and interaction detail, each with scoring points." It opens a task, takes that sentence and that file along, and what comes back is interview.md.

**Each job has a context of its own.** Every task carries a record: the goal, your own words, what counts as done, and how far it has got. The agents doing the work are only tools: by default a DeepSeek Harness session, and a task can be switched to Claude Code without losing the record. Your words go in verbatim. In an early version the assistant rewrote my words in a handoff and added requirements I had never stated, and a job that takes a minute or two dragged on for 11.6 minutes. Now a handoff may only quote the original, and code checks it.

**Context comes in by itself.** What you do on screen and the messages in Feishu are organised into a timeline every 10 minutes, filed under a project when it is clear which one. Files on your computer are read when needed. All of it is read-only and can be turned off at any time.

**It comes to you only when it is your turn.** Decisions, acceptances, failures, and messages someone is waiting for you to answer are all on Waiting on you. At night it reviews the day and leaves up to three cards for the morning. A job is done only after you accept it.

The assistant that is always there is called Tacit by default, as in tacit understanding: it should know the background of a job before you open your mouth. It remembers only what you said yourself, and it never makes a call or sends a message for you.

DS-buddy is early. Projects are still created by you, Codex as an executor hasn't been verified through a complete task, and the interface is in Chinese only. It needs DeepSeek Harness 0.2.x and Node 24. Installation is in the README on [GitHub](https://github.com/DKKD13/tacit-dsh), under the MIT license. Why it is designed this way is in [the long version](deep/).

Say the goal. Make the calls.
