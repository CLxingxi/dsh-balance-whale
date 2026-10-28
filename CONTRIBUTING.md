# 贡献指南

欢迎改 bug、加皮肤、调手感。改动尽量小而聚焦，一个 PR 做一件事。

## 环境

- **Node ≥ 18**：跑挂件自检。DSH 自带的 node 就在 `dependencies/node/bin/node.exe`。
- **Python 3 + Pillow + numpy**：只在新增或修改皮肤资源时需要。DSH 自带的 Python 里已经装好。

不需要 `npm install`——这个包没有运行时依赖，React 由浏览器的模块表提供。

## 提交前必须跑

```
node tools/balance-whale-smoke.mjs        # 118 项检查，必须全绿
python tools/prepare-skins.py --check     # 有皮肤资源时校验清单与图片
```

CI 会做同样的事。改动如果让自检变红，请先修好再提。

## 加一套皮肤

不用改代码：

```
python tools/prepare-skins.py --skin my-skin --name "我的皮肤" --accent "#FF8800" \
    --frame idle=raw/idle.png --frame happy=raw/happy.png
```

它会裁掉空白、居中到 256px 方形透明画布、自动抠掉不透明底色（要保留就加 `--opaque`），
并写好 `assets/my-skin/skin.json`。心情名用 `idle / happy / work / excited / worried / sleep / error`，
缺的心情在挂件里回落到 `idle`。原始立绘放 `raw/`（已在 `.gitignore` 里）。

**请不要提交你无权分发的立绘。** 想给别人用，请让使用者自己放进 `assets/`。

## 改挂件外观

`client.js` 里的 `CSS` 与 `WHALE_SVG` 是唯一的真源。README 顶部的预览图是
`docs/preview.html` 渲染出来的镜像，改了外观记得同步，然后重新生成：

```
python tools/make-preview.py
```

它会用无头 Chromium/Edge 逐帧渲染 `docs/preview.html`（`--virtual-time-budget` 推进动画时钟），
再把帧合成循环 GIF。需要 Pillow；找不到浏览器时用 `--browser` 指定，其他参数见 `--help`。

## 提交信息

用 `feat:` / `fix:` / `docs:` / `chore:` 开头，一句话说清改了什么。
涉及界面的改动，最好在 PR 描述里贴一张截图。

## 许可

提交即表示你同意以 [MIT](LICENSE) 授权你的改动。
