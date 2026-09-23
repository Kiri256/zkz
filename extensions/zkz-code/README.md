# zkz Code

`yt_version.h` 宏、未激活 `#if` 折叠、clangd 索引、FFFD。源码全在本包，也不调 `zkz\scripts`。

真源启用 `zkz-native` 后工作区 `.c/.h` 已是 UTF-8，clangd / 折叠 / FFFD 直接用当前工作区即可。未转码的真源仍按内容探测编码。

## 宏表

只有一张表：`.clangd` 的 `-D/-U` 先入，再解析整个 `yt_version.h`（含表达式宏、芯片宏）。

- 查看宏清单和状态栏预览按 `macroKeys` 的顺序显示，`=0` 仍隐藏。刷索引弹窗仍认 `MALL_*` / `MLS_*` 等前缀。
- 折叠直接读这张表，不再自己解析。条件里出现表里没有的宏时不折（不当成 0）。
- `.clangd` 与 `yt_version.h` 都由宏表统一收。

打开 `.c` **不会**重算宏表。

### 还会触发的

| 触发 | 效果 |
| --- | --- |
| 启动 | 刷徽章、对齐基线；约 600ms 后折已打开的源文件（宏未齐最多再试 4 次） |
| 保存 `yt_version.h` | 同步表；白名单变了可弹刷索引；全量有变则重折 |
| 磁盘上 `yt_version.h` 变了 | 400ms 防抖静默同步；有变才重折 |
| `.clangd` 保存/监视 | 失效宏表，重折，刷徽章 |
| HEAD 变化（切分支 / rebase / merge） | 冻基线后同步宏（可弹窗）；刷新 `compile_commands` 时弹出通知（失败另有警告，clangd 状态栏会标出过期） |
| 工作区文件夹变化 / `refreshStatus` | 刷徽章 |
| 打开或切到 `.c/.cpp` | 只套折叠，不刷表 |

## 命令

| 命令 | 说明 |
| --- | --- |
| `zkz-code.showMacros` | 白名单宏，跳到定义 |
| `zkz-code.foldInactiveIfdef` | 强制折当前编辑器未激活分支 |
| `zkz-code.unfoldInactiveIfdef` | 展开 |
| `zkz-code.refreshIfdefFolds` | 清缓存并重折可见编辑器 |
| `zkz-code.refreshCompileCommands` | 刷新 `compile_commands.json` |
| `zkz-code.reindexClangd` | 清 `.cache/clangd` 并重启 |
| `zkz-code.restartClangd` | 重启 clangd（不清理索引） |
| `zkz-code.invalidateMacroImpactIndex` | 按白名单变化删对应 `.idx` |
| `zkz-code.checkFffd` | 检查当前文件 U+FFFD（打开/保存业务源也会扫） |
| `zkz-code.refreshStatus` | 只刷徽章 |

`zkz-code.beginYtMacroCheckoutGuard` / `zkz-code.syncYtVersionAfterCheckout` / `zkz-code.onHeadChanged` 给切分支监测和其它扩展调用，不出现在命令面板。

设置：`zkzCode.ifdefFold.enabled`、`zkzCode.ifdefFold.minLines`。折叠只针对 `.c/.cpp`，不折头文件。

`zkz-code` 状态栏菜单是一层：折叠、展开、刷新折叠、检查 FFFD、刷新状态栏，以及当前启用的宏。点宏名直接跳到定义。clangd 菜单是刷新 `compile_commands`、按宏影响刷新索引、重建索引、重启 clangd。没有 Keil 工程或 `compile_commands.json` 时 clangd 这条不显示。都不出现在编辑器标题栏或右键菜单。

`macroKeys` / `scanTops` / FFFD 跳过目录读真源 `.zkz/workspace_lists.json`。
