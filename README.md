# paseo-plugin-model-hotkeys

给 Paseo 桌面端对话输入框下方的**模型选择器**补齐键盘快捷键，不修改 Paseo 源码。
通过 Paseo 官方插件机制加载（客户端代码运行在渲染进程内，与页面共享同一 DOM）。

## 快捷键

| 按键 | 作用 |
| --- | --- |
| `Ctrl+M` | 打开 / 关闭模型选择弹层 |
| `Ctrl+N` 或 `↓` | 高亮下一项 |
| `Ctrl+P` 或 `↑` | 高亮上一项 |
| `Enter` | 确认高亮项（等价于点击该行，选中后弹层自动关闭） |
| `Escape` | 关闭弹层（Paseo 原生行为，无需本插件） |

细节：

- 打开弹层后初始高亮落在**当前已选中的模型**上，`Ctrl+N/P` 从它开始移动。
- 弹层内的高亮行以蓝色描边展示；列表支持按住方向键连续移动（自动处理
  FlatList 虚拟化：目标行未渲染时先滚动再逐帧重试）。
- 弹层打开时仍然可以打字过滤模型，过滤 + 方向键可以混用。
- 行内包含三类可选项：模型（`model-row-*`）、provider（`model-provider-*`）、
  Agent Profile（`model-profile-row-*`），高亮导航覆盖全部三类。
- 终端获得焦点时 `Ctrl+M` 不拦截（在终端里它是回车 CR）。

## 安装

要求：Paseo ≥ 0.14.0，daemon 已开启插件（`pluginsEnabled: true`，
即 Settings → Plugins 里能看到插件列表即可）。

```bash
paseo plugin install ~/cascode/github.com/paseo-plugin-model-hotkeys
```

安装后重启 Paseo 桌面端（插件客户端代码在应用启动时评估）。用
`paseo plugin ls` 确认 `model-hotkeys` 处于 enabled/running。

## 修改与卸载

```bash
# 改完代码后重载（daemon 会重新编译本目录）：
paseo plugin reload model-hotkeys

# 卸载（只删除安装记录，不动这个目录）：
paseo plugin remove model-hotkeys
```

重载后建议重启一次桌面端，确保渲染进程拿到新的客户端 bundle。

## 工作原理

Paseo 的插件客户端 bundle 由渲染进程用 `globalThis.eval` 在主世界执行
（`packages/app/src/plugins/evaluate.ts`），因此本插件直接：

1. 在 `window` 上以捕获阶段监听 `keydown`（先于页面其他处理器拿到按键）；
2. 通过 Paseo e2e 套件依赖的稳定 `data-testid` 定位元素：

   | 元素 | 选择器 |
   | --- | --- |
   | 模型触发按钮 | `[data-testid="combined-model-selector"]` |
   | 弹层视口（判断开关状态） | `[data-testid="agent-controls-model-viewport"]` |
   | 可导航行 | `[data-testid^="model-row-"]`、`[data-testid^="model-provider-"]`、`[data-testid^="model-profile-row-"]` |

3. 用合成 `click` 事件激活 RN-web `Pressable`——react-native-web 的
   `onPress` 由原生 `click` 触发且不校验 `isTrusted`，所以一次
   `dispatchEvent(new MouseEvent("click"))` 即可精确激活一次；
4. 关闭弹层时合成一个 `Escape` keydown，Paseo 在 `window` 捕获阶段监听
   并交给顶层弹层处理（`packages/app/src/lib/overlay-root.ts`）。

## 限制与说明

- `data-testid` 不是面向插件的公开 API，但被 Paseo 官方 e2e 测试依赖，
  相对稳定；若未来版本改名，症状是快捷键无反应（不会崩溃），届时更新
  `index.client.ts` 顶部的选择器常量并 `paseo plugin reload` 即可。
- 焦点在浏览器面板（内嵌 webview）内时，按键不会到达主窗口，
  `Ctrl+M` 暂不可用；先点一下 Paseo 自身的界面即可。
- macOS 上 `Cmd+M` 是系统级窗口最小化，与本插件无关；本插件只用 `Ctrl+M`。
- 在 Windows/Linux 上 `Ctrl+N` 与 Paseo 的“新建工作区”冲突（弹层打开时
  本插件优先拦截）；macOS 无此问题。
- 本机开发类型检查：`npm install && npm run typecheck`。Paseo 安装时用
  自带 esbuild 编译 TS，无需本地构建。

## 版本兼容

- 0.1.0：基于 Paseo 0.14.0 源码验证（选择器、RN-web 0.21 事件语义）。
