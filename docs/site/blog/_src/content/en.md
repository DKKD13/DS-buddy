^ Notes on building AI products
# A really good agent product doesn't need the agent abstraction
> DS-buddy is open source today. This is the one thing that became clear to me while building it.

Hi everyone.

Agents keep getting more capable, and I keep getting busier.

Busy carrying things, mostly. Pasting a conclusion from one conversation into another, briefing a newly started agent on the background all over again, watching which one has finished and which one is stuck, then stitching the results together. By the end of the day I have mostly been glue. The work that is actually mine, thinking the direction through and making the call, is what I have no time left for.

It isn't just me. In March, BCG published a [survey](https://hbr.org/2026/03/when-using-ai-leads-to-brain-fry) of 1,488 workers in Harvard Business Review: people who have to keep watching AI at work are more tired, and self-reported productivity tops out at three AI tools at once. They call it "AI brain fry".

So when you build an AI product, I think one question comes before all the others: how to lower the bandwidth a person has to spend talking to the AI. The less the person has to say the better, and the AI still has to get the job right.

Seen from that question, I don't quite agree with how today's multi-agent products are organised. My view: **managing agents is managing context.** A really good agent product doesn't need to put the agent layer in front of you.

**Taken apart, an agent is some context plus a model.** Everyone's abstraction went to agents first, I think, because we are used to organising context through people: who owns what, who to ask. So the AI got job titles and names too. But people differ a lot from one another, which is why we divide work between them. Agents hardly differ at all: give the same model a different paragraph of instructions and the "designer" becomes the "engineer". What really differs is the model behind them.

One step further: what is the difference between opening three conversations in one project and getting three agents to work on the same thing? I thought about it for a long time and I don't think there is one. Either way it is three contexts, each with a model behind it. A conversation is just how the agent's side holds context: one line that only grows. People don't think in conversations, and a task shouldn't be boxed into one either.

**Having agents pass messages to each other is mostly unnecessary.** Messages get distorted between people, and they do between agents too, at the price of an extra round. I have been burned by this myself: in an early version I gave the assistant a goal in one sentence, and when it handed the job to the working agent it added a few requirements I had never stated. Downstream they were taken as my own words and followed. That is also why fork works better than multi-agent most of the time: a fork carries the context across whole. Nothing is paraphrased, so nothing is distorted.

**But a fork drops nothing, and it trims nothing either.** The main conversation keeps getting longer, and every fork carries the whole history. Looking back, what multi-agent is really good for is at the other end: it gives each piece of work a clean context of its own. Take away the names and the roles, and what is left is a way of managing context.

I want both: a clean context for each piece of work, with the words in it carried over unchanged. That doesn't grow out of a conversation that just keeps going. It has to be designed around the task from the start.

Which way should it be built? Not, I think, by having people run it: setting up channels, forming groups, deciding who to @. **A person only needs to say three things clearly: what to do, where the context is, and what the standard is.** The AI then splits that into tasks, and each task carries a context pack. Think of it roughly as a goal file: the goal, your own words, what counts as done, and how far it has got. That is the thing to maintain over time, updated whenever there is progress and injected whenever work starts.

As for the agents that do the work for a while, they are tools: a runtime with fragile state. If one breaks or gets swapped, inject the context pack again. Whether each start is a brand-new context, and how to save tokens around the cache, I haven't thought through yet. But none of that should be a detail a user can feel.

**That is where DS-buddy starts.** Today's multi-agent products, I think, expose too much. Claude Projects lets several conversations in a project share one set of material, but only with Claude's models. Multica uses tickets and Raft uses group chat. Their underlying abstractions are well made, and I borrowed a good deal from them. But there the agents still stand at the front, and how a job is split and what background each piece carries is still mostly decided by the person. Building context and dividing up work is hard work for a person in itself, so the glue work has only moved somewhere else.

**For the AI to take over that layer, it first has to know you well enough.** So the most important design in DS-buddy is collecting context. What you are doing on screen and the messages in Feishu keep coming in and are organised into a timeline every 10 minutes, filed under a project when it is clear which one. Files on your computer can be read when it needs them. All of it is read-only and can be turned off at any time.

Collecting context automatically is nothing new. Screenpipe (which is what DS-buddy uses to read the screen), AirJelly, Littlebird and the Computer History in Codex are all doing it already. From what I have seen, they mostly stop at remembering and being searchable. Proposing a piece of work from the context it has seen, splitting it, getting it done and bringing it back to you for the call: that loop is still left for the person to close. It is the loop DS-buddy wants to close.

I think this is how we will work: people speak only where they are really needed, to state a preference, make a trade-off, give the one piece of direction that matters, and stop being carriers of information.

The assistant that is always there is called Tacit by default, as in tacit understanding. A really good buddy should already know everything relevant to the job before you open your mouth. By then you won't need to know how many agents are behind it, or what they are called.

DS-buddy is an open-source plugin for DeepSeek Harness, and the code is on [GitHub](https://github.com/DKKD13/tacit-dsh). It is early: tasks are split by the AI, for example, but a project is still only created when you ask for one. To see what the product looks like and how other products compare, read [the long version](deep/). Come and try it, and tell me where it doesn't hold up.
