# 宣传片：怎么录，怎么剪

成片 `tacit-promo.mp4`（44 秒，另有竖屏版 `tacit-promo-vertical.mp4`）用的全部是真实界面和真实任务：在一个专门拍片用的项目里，一句话派活，项目助理先问清主色和日期，回答后两个任务并行，网页邀请函交付后在面板里直接打开，点「验收通过」。

## 结构

参考了豆包工作、Manus 2.0、Claude Design、Genspark 等产品片的 60 秒结构：价值主张 → 真实任务 → 过程看得见 → 交付成品 → 收尾。界面是主角，占画面大部分；每个镜头先给全景，再推近到正在发生的地方；一屏只讲一句话。

## 录

`promo-src/record/` 下的脚本用 Playwright 驱动真实界面，整段连续录像，每个关键动作写一个时间点到 `marks.json`：

- `film.py`：建项目（或复用）、打开「待你决定」、在项目对话里逐字打出任务并发送、等任务出现、打开任务详情、等交付。
- `film2.py`：在对话里回答项目助理的问题、等新任务、看进展、打开交付里的网页、点「验收通过」。
- `readme_shots.py`：README 截图，只截拍片项目、只截右侧面板。

脚本只在拍片项目里操作，不碰其他项目。

## 剪

`promo-src/remotion/` 是一个 [Remotion](https://www.remotion.dev/) 工程（按 Remotion 官方的 agent skills 写法：每个镜头一个 `TransitionSeries.Sequence`，秒数从 fps 换算）：

- `Promo.tsx`：`Shot` 把录像的一段放进一张浮在暖白底上的卡片，`focus` 和 `zoom` 决定推近到哪里；`cover` 用磨砂盖住录像里的侧栏（公开版用，侧栏里有真实项目名）。
- `marks.ts`：录像脚本写出的时间点。
- 三个成片（合成名沿用旧的内部名）：`MiraPromo`（内部版，含「昨晚想到的」镜头）、`MiraPromoPublic`（公开版）和 `MiraPromoVertical`（竖屏版）。一键重拍：`PRODUCT_CN=Tacit PRODUCT_EN=Tacit SLOGAN=… bash promo-src/record/run_film_meld.sh`。

```sh
npx remotion render MiraPromoPublic out/tacit-public.mp4
```

录像文件（take1.mp4、take2.mp4）不进仓库，放在 `public/` 下再渲染。Remotion 对个人和 3 人以内的团队免费，更大的团队见它的许可说明。
