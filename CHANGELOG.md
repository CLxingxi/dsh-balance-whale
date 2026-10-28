# Changelog

本项目的所有重要变更都记在这里，格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [1.0.0] — 2026-10-28

首个公开版本。

### 新增

- **挂件本体**：常驻 DSH Web 界面右下角，同一个包同时提供 Host 半（`index.js`：余额、工作状态、
  账本、皮肤与图片路由）与 Browser 半（`client.js`：挂件 UI），靠自带 `cordis.patch.yml` 一行插入挂载。
- **皮肤**：内置手绘皮肤 `深海经典鲸`（纯 SVG，不依赖图片）；`assets/<id>/` 下带合法 `skin.json`
  的目录会被自动发现并可切换，选择记在 `localStorage`。
- **表情**：`idle / working / happy / worried / excited / sleep / error` 七种状态，随
  `api-session/status`、`tools/execute`、`agent/error`、余额涨跌与拖拽手势切换，并叠加齿轮+打字点、
  爱心+星星、汗滴、彩带星、zzz、红色感叹号等道具。
- **气泡**：事件气泡带优先级队列（最多 3 条、自动合并）与五种描边色调；空闲时每 4–9 分钟随机闲聊，
  页面不可见时不说。
- **音效**：WebAudio 现场合成 8 种音效（tick / pop / boing / coin / chime / blip / warn / hello），
  不依赖音频文件，首次手势解锁 AudioContext，🔊/🔇 开关持久化。
- **记账**：今日已用与轮数、上一轮消耗与时间、本次启动累计、近 7 天柱状图、最近几笔变化（带工具名）；
  账本落在 `$DSH_HOME/balance-whale/ledger.json`，保留 60 天。
- **手感**：里程表数字滚动、拖拽吸附左右边缘、左吸附时镜像翻转、QQ 弹弹呼吸与点击回弹、
  `--dsw-alias-*` 主题 token 跟随明暗主题、`Enter`/空格刷新与 `←`/`→` 换边吸附。
- **自检**：`node tools/balance-whale-smoke.mjs` 共 118 项检查（用自带的迷你 React 真跑 hooks、
  异步 fetch 与虚拟时钟，含路径穿越防护），`python tools/prepare-skins.py --check` 校验皮肤清单与图片。
- **CI**：`.github/workflows/smoke.yml` 在 Node 20/22/24 上跑自检，并单独校验皮肤资源。

### 说明

- 仓库不附带第三方立绘，`assets/` 只保留 `.gitkeep`；立绘由使用者自行添加。
- 早期提交曾包含一组本地测试用的立绘，已在发布前从历史中移除。
