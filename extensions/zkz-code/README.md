# zkz Code

`yt_version.h` 宏、未激活 `#if` 折叠、clangd 索引。源码全在本包，也不调 `zkz\scripts`。

真源启用 `zkz-native` 后工作区 `.c/.h` 已是 UTF-8，clangd 和折叠直接用当前工作区即可。未转码的真源仍按内容探测编码。

## 宏表

只有一张表，留在内存里：`.clangd` 的 `-D/-U` 先入，再解析整个 `yt_version.h`（含表达式宏、芯片宏）。

- 状态栏预览按 `macroKeys` 的顺序显示，`=0` 仍隐藏。点宏名跳到定义。清空 `index` 的确认仍认 `MALL_*` / `MLS_*` 等前缀。
- 折叠直接读这张表。条件里出现表里没有的宏时不折（不当成 0）。
- `.clangd` 与 `yt_version.h` 都由宏表统一收。

打开 `.c` **不会**重算宏表。

### 还会触发的

| 触发 | 效果 |
| --- | --- |
| 启动 | 刷徽章、对齐基线；约 600ms 后折已打开的源文件（宏未齐最多再试 4 次） |
| 保存 `yt_version.h` | 同步表；白名单变了软重启 clangd（连续保存合并成一次）；全量有变则重折 |
| 磁盘上 `yt_version.h` 变了 | 400ms 防抖静默同步；有变才重折 |
| `.clangd` 保存/监视 | 失效宏表，重折，刷徽章 |
| 换分支（`.git/HEAD` 指向变了） | 同步宏，白名单变了软重启 clangd；刷新 `compile_commands` 时弹出通知。失败时 zkz-code 状态栏变黄，重载窗口后仍变黄，直到这次分支的编译数据库写成功。同分支提交、撤回不触发，也不把状态栏标黄 |
| 工作区文件夹变化 | 刷徽章 |
| 打开或切到 `.c/.cpp` | 只套折叠，不刷表 |

## 命令

| 命令 | 说明 |
| --- | --- |
| `zkz-code.refreshIfdefFolds` | 清缓存并重折当前编辑器 |
| `zkz-code.toggleIfdefFolds` | 切换 `code.ifdefFold.enabled`。关闭时展开当前文件已折的死分支 |
| `zkz-code.refreshCompileCommands` | 刷新 `compile_commands.json` |
| `zkz-code.restartClangd` | 软重启 clangd，不删索引 |
| `zkz-code.invalidateMacroImpactIndex` | 点了就清空 `.cache/clangd/index` 并重启；预编译头保留 |
| `zkz-code.restoreCmsisInclude` | 从固定基线恢复 CMSIS Include 到工作区；不暂存、不提交，目录已有文件时跳过 |

`zkz-code` 自己监视 `HEAD`，换分支后刷新宏和 `compile_commands`。

折叠开关在 `.zkz/settings.json` 的 `code.ifdefFold.enabled`、`code.ifdefFold.minLines`。只折 `.c/.cpp`，不折头文件。第一次打开折上未激活分支，之后只动从活变死或从死变活的行。点「刷新折叠」把当前文件的死分支重新折上。

状态栏只有 zkz-code 一条。菜单里是打开或关闭折叠、刷新折叠、恢复 CMSIS Include、刷新 `compile_commands`、重启 clangd、清空 `index` 目录，以及当前启用的宏。点宏名直接跳到定义。编译数据库没跟上当前分支时这条变黄，重载窗口后也还在。都不出现在编辑器标题栏或右键菜单。

`macroKeys` 读真源 `.zkz/workspace_lists.json`。同一文件的 `libraryDirNames` 给 zkz-native 决定编烧树里哪些目录做成链接。

`compile_commands` 使用 `fast-xml-parser` 校验并解析工程 XML，支持属性、注释、CDATA、自闭合节点和数字实体；只从 `Project/Targets/Target` 选择编译目标，忽略调试选项中的嵌套 Target。Cads 支持实际工程的 `TargetArmAds` 层级。格式损坏时报告行号，避免生成部分数据库。工程 XML、目录、机型和目标没变时，先用内存里的结果，没有再读 `.zkz/run/compile-commands-cache.json`。两边都没有才解析，并写回内存和这个文件。内容和现有 `compile_commands.json` 相同时不改写。
