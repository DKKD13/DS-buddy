# DS-buddy

**只说目标，只管拍板。**

DS-buddy 是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的一个开源插件。你说一句目标，它把没说清的问清楚，拆成几个任务同时去做，做完把成品交到你面前。你面对的只有项目、任务和一块「待你决定」的看板，看不到 agent 这一层。里面那个一直在的个人助理，默认叫 Tacit，取「默会」的意思。

[为什么这么做](https://dkkd13.github.io/tacit-dsh/site/blog/) · [长文](https://dkkd13.github.io/tacit-dsh/site/blog/deep/) · [产品页](https://dkkd13.github.io/tacit-dsh/site/) · [演示片](https://github.com/DKKD13/tacit-dsh/releases/latest/download/tacit-film.mp4) · [English](README.en.md)

![一条任务从交代到交付](docs/launch/demo.gif)

## 装上

需要 DeepSeek Harness（在 0.2.1 上测过）和 Node 24 以上。没装过 DeepSeek Harness 的话，先 `npm install -g @deepseek-ai/dsh`。

```sh
git clone https://github.com/DKKD13/tacit-dsh
cd tacit-dsh/plugin
dsh plugin --profile web add "$(pwd)"    # 把插件装进 DeepSeek Harness
dsh --profile web                        # 启动，在浏览器里打开它给的地址
```

打开后左边多出「个人助理」和「项目」。新建一个项目，说第一句目标就行。模型用的是你在 DeepSeek Harness 里配好的那个。一步一步的说明见[上手指南](docs/GETTING-STARTED.md)。

## 它怎么想

- **没有要你管的 agent。** 干活需要的只是上下文和模型。你说清要做什么、上下文在哪、标准是什么，它拆成任务，每个任务带一份自己的上下文。
- **上下文自己进来。** 屏幕上在做的事和飞书里的消息，整理成一条按项目归好的时间线。全部只读，随时能关。
- **执行的那一层可以换。** 默认由 DeepSeek Harness 执行，也可以在任务里换成 Claude Code。记录留在任务上，换了也不丢。
- **该你的时候才找你。** 要你拍板，等你验收，做不下去了。只有你点了验收，一件事才算完。

## 文档

- [上手指南](docs/GETTING-STARTED.md)
- [功能介绍](docs/FEATURES.md)
- [测试报告](docs/TESTING.md)：自动化测试和逐条的走查记录，没验到的也列在里面

## 现在到哪一步了

1.0 版。只能跑在 DeepSeek Harness 里，界面目前只有中文，飞书只读。Claude Code 当执行者实跑验证过；Codex 能选，但还没有验证到它跑完一个完整任务。这两者当执行者时不弹权限确认，也没有沙箱：你的系统用户能读写的，它都能读写。


许可证：[MIT](LICENSE)。
