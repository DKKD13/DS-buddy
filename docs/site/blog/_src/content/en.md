^ Notes on building AI products
# A really good agent product doesn't need the agent abstraction
> DS-buddy is open source today. This is the one thing that became clear to me while building it.

Hi everyone.

When you build an AI product, I think one question comes before all the others: how to lower the bandwidth a person has to spend talking to the AI. The less the person has to say the better, and the AI still has to get the job right.

Seen from that question, I don't agree with how today's multi-agent products are organised.

Why did everyone's abstraction go to agents first? Because we are used to organising context through people, each with a job of their own. So, quite naturally, the AI got job titles and names too.

But what an AI needs in order to work is only two things: context and a model. **Taken apart, an agent is some of the context plus some of the model.** Wrapping that in a named character adds a layer nobody needs, and it brings misunderstandings and failures with it.

That is also why fork works better than multi-agent most of the time. **A fork is simply shared context**: what is already known goes across as it is. Between agents, context travels by paraphrase, and some of it is lost on the way. Read the source of open-source multi-agent projects and the finding is consistent: a subagent receives a description written by its parent and hands back only its last message. Cognition has an example: build Flappy Bird by giving the background to one subagent and the bird to another. Neither sees the other's work, and the background comes back looking like Mario.

But a fork doesn't solve another problem: the main conversation keeps getting longer.

So I think the best answer for context has to be designed on purpose from the start. It doesn't grow out of a conversation that just keeps going. What multi-agent is really for is giving the AI a good environment for managing context, organised around the task itself.

Which way should that be built? Not, I think, by having people run it: setting up channels, forming groups, deciding who to @. **A person only needs to say three things clearly: what to do, where the context is, and what the standard is.** The AI then splits that into tasks (threads), and each task carries a context pack. Think of it roughly as a goal file: the goal, your own words, the standard for done, and how far it has got. That is the thing to maintain over time, updated whenever there is progress and injected whenever work starts.

As for the agents that do the work for a while, **they are really tools**. Their state is fragile and doesn't need much maintaining: each is a runtime, and the context is injected again each time. There are plenty of details here, such as whether each agent starts in a brand-new context and how to save tokens around the cache. I'm not sure our current design is the best one. But these shouldn't be details a user can feel.

That is where DS-buddy starts.

The multi-agent products on the market expose too much. Multica and Raft both offer a very good layer of abstraction, organising work through group chats and through tickets being passed along. It is a good way to organise, and it still isn't effortless enough. For a person, building context and dividing up the work is itself hard work. Ideally the AI does that layer.

For the AI to be able to, it first has to have taken in enough of your context. That is what Multica and Raft lack today: the one dividing work into projects and tasks is still the person. So the most important design in DS-buddy is **collecting context**. What you are doing on screen and the messages in Feishu keep coming in and are organised by project, and files on your computer are read when it needs them. That is how the AI comes to know enough about you.

The assistant inside is called Tacit by default, as in tacit understanding. I think a really good buddy should already know everything relevant to the job before you open your mouth.

DS-buddy is an open-source plugin for DeepSeek Harness, and the code is on [GitHub](https://github.com/DKKD13/tacit-dsh). To see what the product looks like and how other products compare, read [the long version](deep/).
