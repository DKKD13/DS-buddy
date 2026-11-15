# 对标：Manus、Genspark、Raft 怎么做官网和发布文章

2026-11-16 读了三家的官网、发布文章和博客，记下它们的做法，以及 Tacit 的落地页和文章各学了哪一条。每条后面是出处，方便你自己去看。

## 一、官网

### Manus（manus.im）

- 首屏几乎没有文案：一条公告条「Introducing Manus 2.0」，一张产品截图，一个输入框，标题就是一句问话「What can I do for you?」，下面一排起手的快捷项（Create slides、Build website…）。
- 全页只有一句口号：「Less structure, more intelligence.」
- 没有数字、没有客户 logo、没有评价。可信度靠产品本身和页脚的 Trust center。
- 页脚有一组「Compare」：VS ChatGPT、VS Lovable、VS Replit。

**学到的：** 首屏用产品最有代表性的那个动作开场，而不是一段介绍。Tacit 的首屏是一句交代的话，下面直接是它变成的看板。

### Raft（raft.build）

- 首屏：一句标题「Where humans and AI agents build together.」，一句定义「The agent-native workspace for builders and teams.」，两个按钮（Download Raft、Request a demo），一张真实感的产品界面。
- 接着是一句引语当论点：「The future of work isn't humans using AI tools. It's humans and AI agents building together.」
- 「What makes Raft different」下面四五节，每节一句祈使式的小标题加一张界面：Teammates who really know you、Work that finishes itself、Bring the agents you already run、A team that gets smarter together。
- 然后是七条创始人评价、团队介绍（人和 agent 混排）、七个常见问题（含和 Slack、OpenClaw、Codex 的区别）、收尾按钮「Ready to build?」。

**学到的：** 页面骨架。标题 + 一句定义 + 两个按钮 + 真界面；一句论点；「有什么不一样」每节一句话一张图；常见问题里直接回答「和谁有什么不同」；结尾再给一次按钮。Tacit 的落地页就是这个顺序。评价和团队两节我们现在没有，没有硬凑。

### Genspark（genspark.ai）

- 官网和博客都拦了自动读取，结构是从 VentureBeat 的发布报道里看的。
- 发布时的打法是演示先行：三个具体场景（五天圣地亚哥行程并电话订餐厅、做菜短视频、动画短片），再给数字（9 个模型、80 多个工具、GAIA 87.8% 对 Manus 的 86%）。

**学到的：** 数字要带比较对象和条件才有说服力。Tacit 的页面只放自己量过的四个数，每个都写了条件。

## 二、发布文章

### Manus《Introducing Manus 2.0》（约 1000 字）

- 开头三句：宣布发布；说这不是一次版本更新，而是新架构、新产品、新能力；用一个问题定调。
- 每个功能的写法固定：名字加冒号，后面三个短句（「Game Dev: Build it. Ship it. Play it together.」），然后一个具体场景，常常带一句「以前要怎样」，最后才是好处。全文对读者说「你」。
- 只有量过的地方给数字（Cascade：token 少 23.2%、时间少 28.2%、成本低 32%），并注明是「一个测试配置」。
- 结尾单独一节 Availability：现在哪里能用、哪些要邀请码。最后一句很短：「Manus empowers you to build. You decide what's worth building.」

### Raft《Is Having Agents in the Room Meant to Be Chaotic?》（约 1500 字）

- 用一个小场景开头：一屋子 agent 报数，报着报着全是重复。第三句给出论点：「The agents are not broken. The room is.」
- 给问题起名字（AX，agent experience），再用两个功能（收件箱、扣住的草稿）当证据，配三张示意图。
- 结尾是一句软的邀请，不催注册。

### Manus《Rebuilding Manus with Manus》（约 3500 字，工程复盘）

- 标题就承诺讲「改了什么、坏了什么」。开头是一个场景，不是论点。
- 十二节编号的教训。有具体数字，也有具体的失败（一个没人看的周末，agent 自己开出 200 多条待办）。
- 专门有一节「What isn't working yet」，结尾注明哪些数字是估计。

**学到的，用在 Tacit 的文章和页面上：**

| 做法 | 出处 | 用在哪 |
| --- | --- | --- |
| 开头先说「这不是什么」 | Manus 2.0 | 文章标题「多 agent 卷了一年，我们决定把 agent 藏起来」 |
| 一句话论点，短到能被引用 | Raft 博客 | 落地页第二屏的引语 |
| 功能 = 祈使短句 + 场景 + 好处 | Manus 2.0、Multica README | 落地页「说一句就够」「交付的是成品」几节 |
| 只给量过的数字，写明条件 | Manus 2.0、Genspark | 落地页「有据可循」四个数 |
| 写「现在还有哪些不行」 | Manus 复盘 | 落地页常见问题、测试报告的「没验到的」 |
| 常见问题里直接比较 | Raft、Manus 页脚 | 落地页「和 Raft / Manus 有什么不同」 |
| 说清学自谁 | 三家都没有，这是我们自己加的 | 落地页「学自谁」一表 |

## 三、和它们比，Tacit 现在差在哪

- **没有外部评价。** Raft 有七条创始人的话。我们要等第一批用户。
- **没有成片。** 三家的视频都是真实界面加一个小故事。我们的新片还在做，页面上暂时放的是上一版 44 秒的剪辑。
- **没有独立域名和下载页。** 现在的入口是 GitHub 仓库。
- **英文只有落地页有。** 文章和上手指南还是中文。

## 出处

- Manus 官网：https://manus.im
- Manus 2.0 发布文章：https://manus.im/blog/introducing-manus-2-0
- Manus 工程复盘：https://manus.im/blog/rebuilding-manus-with-manus
- Raft 官网：https://raft.build
- Raft 博客：https://raft.build/resources/blog/is-having-agents-in-the-room-meant-to-be-chaotic/
- Genspark 发布报道（VentureBeat）：https://venturebeat.com/business/gensparks-super-agent-ups-the-ante-in-the-general-ai-agent-race
