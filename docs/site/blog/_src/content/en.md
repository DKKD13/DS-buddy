^ Notes on building AI products
# Introducing DS-buddy: your next agent product may not need agents

Hi everyone.

When you build an AI application today, the first and most central problem is lowering the bandwidth of communication between people and AI. That also explains why I don't agree with how today's multi-agent products are organised. The dilemma we keep facing is that we are run off our feet, playing the role of glue most of the time, and short of real time to think and set the right direction. So we need a more efficient way to work with agents, which comes down to managing context as well as possible. Managing agents is managing context, and we don't need the concept of an agent at all.

Start with projects. What is the difference between several conversations in a project around a shared theme, and several agents around the same theme? In fact there isn't one. To an agent, a conversation is a session: a continuous, one-way way of assembling context. But it isn't how people work, and it isn't organised around the task.

Why did everyone's abstraction of their scenarios go to agents first? Because we are used to organising context through people, each with a job of their own. But for an agent, all we really need is context and a model (an agent is part context, part model). The agent is an unnecessary layer of abstraction, and it brings misunderstandings and failures with it.

Having agents pass messages to each other is unnecessary most of the time. Just as messages passed between people pick up errors, multiple agents pick up errors too, and they add a communication cost we don't need. At the same time, agents differ from each other far less than people do; what matters more is the difference between models.

That is also why a fork works better than multiple agents most of the time: a fork is simply shared context, while passing context between agents tends to lose some of it.

But a fork can't solve the problem of a main conversation that keeps getting longer. So the best answer for context has to be designed consciously from the start, rather than refined as the conversation goes on.

So multi-agent, at heart, is about creating a good environment for the AI to manage context, building our context around the nature of the task.

The direction shouldn't be people in control: setting up channels, @-mentions and so on. People only need to say clearly what to do, where the context is and what the standard is. The AI then breaks that down into tasks (threads), each with a context pack that is maintained every time. Think of the pack roughly as a goal file. It is what we really maintain over time, injected each time and updated each time.

The temporary agents are really tools. Their state is fragile; each is just a runtime, and the context is injected again each time. They hardly need maintaining.

(Of course, this involves how context is organised when each agent starts, whether it starts a fresh context, and how to save tokens around the cache.) I'm not sure our design is the best one here, but these shouldn't be details a user can feel.

So this is the core motivation for building DS-buddy. Similar multi-agent products on the market today all expose too much. They offer a very good layer of abstraction, Multica and Raft for example, through group chats and tickets being passed along, and it really is a good way to organise. But it still isn't convenient enough.

Because for a person, building context and dividing up the work is hard work in itself. In a truly ideal state, the AI should complete this layer by itself.

For an AI to complete it, it first needs to take in enough of your context. In Multica and Raft, dividing up tasks and projects is still mostly done by people, not by the AI, when letting the AI do it is the best solution. That brings in our most important design: collecting context. By collecting continuously from every source, the AI comes to know enough.

DS-buddy offers a way of capturing context automatically. That isn't new either: Screenpipe is the best-known example, along with AirJelly, Littlebird and the Computer History built into Codex, and they have existed for a while. But most of them haven't closed the loop from context to action.

I think this is how we will work in future: people express preferences and values and give the key guidance only at the points where they are really needed, instead of being reduced, as today, to carriers of information whose attention suffers. ([Gloria Mark](https://news.gallup.com/businessjournal/23146/too-many-interruptions-work.aspx), who studies attention, found that interrupted work takes 23 minutes on average to be picked up again.)

There are many similar products on the market: Claude Projects, Raft, Multica and others. But Claude Projects is limited to Claude's models, and Raft and Multica still put the emphasis on the idea of agents, which I think is unnecessary. Still, I think their underlying abstractions are very well made, and I borrowed their thinking and the way they are built.

Finally, our core assistant is called Tacit by default, meaning tacit understanding. I think a really good buddy should know all the relevant context before you open your mouth.

DS-buddy is an open-source plugin for DeepSeek Harness. The code is on [GitHub](https://github.com/DKKD13/tacit-dsh), and the design details are in [the long version](deep/).
