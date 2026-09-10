# zkz Code

`yt_version.h` 宏、未激活 `#if` 折叠、clangd 索引、FFFD。源码全在本包，运行时不依赖 `zkz-sandbox`，也不调 `zkz\scripts`。

签出时由 zkz-sandbox 可选调用 `beginYtMacroCheckoutGuard` / `syncYtVersionAfterCheckout`。

## 宏表

只有一张表：`.clangd` 的 `-D/-U` 先入，再解析整个 `yt_version.h`（含表达式宏、芯片宏）。

- 徽章 / 列表 / 「刷索引」弹窗：只显示白名单（`MALL_*`、`MLS_*` 等），`=0` 仍隐藏。
- 折叠直接读这张表，不再自己解析。
- `.clangd` 与 `yt_version.h` 都由宏表统一收。

打开 `.c` **不会**重算宏表。

### 还会触发的

| 触发 | 效果 |
| --- | --- |
| 启动 | 刷徽章、对齐基线；约 600ms 后折已打开的源文件（宏未齐最多再试 4 次） |
| 保存 `yt_version.h` | 同步表；白名单变了可弹刷索引；全量有变则重折 |
| 磁盘上 `yt_version.h` 变了 | 400ms 防抖静默同步；有变才重折 |
| `.clangd` 保存/监视 | 失效宏表，重折，刷徽章 |
| 签出 | 先冻基线，再同步（可弹窗） |
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
| `zkz-code.invalidateMacroImpactIndex` | 按白名单变化删对应 `.idx` |
| `zkz-code.checkFffd` | 检查当前文件 U+FFFD（打开/保存业务源也会扫） |
| `zkz-code.refreshStatus` | 只刷徽章 |

设置：`zkzCode.ifdefFold.enabled`、`zkzCode.ifdefFold.minLines`。折叠只针对 `.c/.cpp`，不折头文件。

C/C++ 编辑器右键和标题栏有 **zkz Code** 子菜单（宏、折叠、Refresh CC、宏影响索引、Reindex、FFFD）。不必装 zkz-sandbox。

`macroKeys` / `scanTops` / FFFD 跳过目录也只读沙箱 `.zkz/workspace_lists.json`（与 zkz-sandbox 同文件）。
