# 三个扩展验收指南

本指南用于检查实现、安装后的命令和自动事件。自动测试不代表 UV4、J-Link、Cortex-Debug 或真实硬件已经验收。涉及启停过滤器、切分支、恢复配置、清索引和烧录的步骤应在独立测试仓库及测试板执行，先记录测试仓库的 Git 状态。

## 自动检查

在仓库根目录执行，三个命令均应输出 `all passed`：

```powershell
npm test --prefix extensions/zkz-native
npm test --prefix extensions/zkz-code
npm test --prefix extensions/zkz-keil
git diff --check
```

native 覆盖编码识别、clean/smudge、真实 Git 过滤集成、编码表和锁、配置 overlay、库链接、编烧树同步及 pkt-line。code 覆盖表达式、宏表、条件分支、工程布局与编译数据库缓存。keil 覆盖设置缓存、HEX 校验、工程布局、调试配置及工具退出码；实际编译、烧录和编辑器界面仍需以下检查。

按 `extensions/README.md` 构建三个 VSIX，安装后 Reload Window。使用真源工作区，检查三个状态栏和输出频道。记录版本、编辑器版本、Node/Git 版本、机型和外部工具路径。F429、H750 分别验收；H750 设置 `keil.flavor=h750`。下面的命令名可用于定位命令面板项；内部命令从扩展集成测试调用。

## zkz-native 命令

| 命令 | 检查结果 |
| --- | --- |
| `enable` | 配置 process filter、属性和 hook；GBK blob 检出后工作区为 UTF-8，Git 状态不产生伪修改 |
| `disable` | 工作区恢复仓库编码与换行，Git 状态保持预期；再启用可以恢复 |
| `refreshTable` | ASCII、GBK、UTF-8、UTF-8 BOM 与 CRLF 记录符合样本；新进程使用更新表 |
| `syncKeilTree` | 业务源生成编烧字节，库使用链接；新增、修改、删除、重命名、撤销和切分支后结果正确 |
| `toggleLocalConfig` | 按 `.zkz/settings.json` 的 `native.paths` 给已跟踪路径打上或去掉 `skip-worktree`。工作区改长后 `git status` 不显示该文件，索引对象不变。暂存后 `pre-commit` 把索引收回 HEAD 的 blob，工作区仍是本机内容。切分支、拉取、合并、变基、拣选、还原，以及 `reset --hard`、`--merge`、`--keep` 走扩展目录里的 git 替身：开始时把清单路径改名挪进 `.zkz/local`，把磁盘写成索引内容，结束后删掉 Git 写出的再挪回来。改名失败才逐个复制。关掉后差异重新出现在更改里 |

以上前缀为 `zkz-native.`。状态栏只显示 `native 开` 或 `native 关`；菜单里编码过滤器是一条「过滤器 开 / 关」，点击在 `enable` 与 `disable` 之间切换。悬停显示编码表统计和失败记录，编不回的文件从菜单打开。调试 axf 由 `zkz-keil` 准备调试时拷到 `.zkz/output.axf`。检查 pre-commit/pre-push 在独立仓库中正确拦截编码不一致；GBK 无法往返时保留原内容并产生失败记录，不能让 Git 无响应。

自动事件：分支名变化后编码表刷新，hook 不同步编烧树；同分支提交与撤销不刷编码表。本地配置开着时，HEAD 变化后只重新打上 `skip-worktree`，不按副本改文件。编辑器重新获得焦点以及 HEAD 监视/轮询应能捕获外部切分支。

## zkz-code 命令

| 命令 | 检查结果 |
| --- | --- |
| `refreshIfdefFolds` | 清除分析缓存后当前编辑器按新宏重新折叠 |
| `toggleIfdefFolds` | 状态栏菜单切换折叠开关；关闭时当前文件已折的死分支展开，再打开后重新折上 |
| `refreshCompileCommands` | 当前工程、target、宏、include 与绝对路径正确，结果可被 clangd 使用 |
| `restartClangd` | 状态栏菜单软重启 clangd，不删索引 |
| `invalidateMacroImpactIndex` | 点了就清空 `index` 目录并保留预编译头 |
| `restoreCmsisInclude` | 固定基线的 Include 恢复，已有文件跳过，恢复结果未暂存 |

以上前缀为 `zkz-code.`。状态栏宏清单点击能跳到定义。`showCommandMenu` 的项目和执行结果应与命令一致。

自动事件：启动时刷新徽章并折叠已打开源文件；保存或外部修改 `yt_version.h`、`.clangd` 后宏表、折叠与徽章更新。保存或换分支后白名单宏变化会软重启 clangd，连续保存合并成一次，不删索引。普通源文件打开/切换只套用折叠。修改折叠设置后重新折叠；工作区文件夹变化刷新徽章。换分支后宏与编译数据库更新。编译数据库没跟上当前分支时 zkz-code 状态栏变黄，重载窗口后仍变黄并再刷一次。同分支提交/撤销不触发，也不把状态栏标黄。

## zkz-keil 命令和任务

| 命令 | 检查结果 |
| --- | --- |
| `keilBuild` | 增量编译，日志与成功/警告/错误状态符合 UV4 返回结果 |
| `keilRebuild` | 执行全量重建，HEX/AXF 输出属于当前机型 |
| `keilFlash` | 状态栏直接烧录，不确认机型。J-Link 使用当前设备、速度与 HEX；F429 不擦 boot，H750 仅允许预期 QSPI 地址 |
| `prepareCortexDebug` | AXF 与源路径映射正确；缺少 AXF 时符合 README 约定 |
| `configureLaunch` | 两条调试配置使用当前 device/SVD/GDB/速度，其他配置保留 |
| `jlinkGdbServerPath` | 调试启动时返回当前机型 GDB Server 路径 |

以上前缀为 `zkz-keil.`。状态栏有编译、重新编译、烧录、准备调试、配置调试。内部 `resolveLayout` 返回当前机型工程与产物路径。任务列表为 Keil Build、Build + Flash + Prepare Debug、Prepare Cortex Debug；重新编译和烧录由状态栏启动对应任务。任务退出码与工具状态一致。检查工作区旧 shell 任务是否遮蔽同名任务。

联动：native 启用时先同步再编译编烧树，产物拷回真源；禁用时编真源。启用过滤却缺少 native 同步命令时应失败。调试断点应映射回真源；换机型后重新生成 launch 配置，确认 GDB Server 随机型解析。缺失工具、编译错误、非法 HEX 和硬件断开应给出错误，不能报告成功。

## 缓存正确性与内存

| 场景 | 预期 |
| --- | --- |
| 同一过滤进程处理多文件 | 编码表和库目录快照复用，新文件 clean 后当前内存表更新；成功状态不重复清零 |
| 过滤进程中途失败再成功 | 失败状态缓存失效，下次成功重新清零；往返失败记录仍独立 |
| 修改编码表或库名单 | 当前过滤进程保留快照；结束当前 Git 操作后，新 Git 操作读取新配置 |
| pkt-line 任意分块、二进制及多包 | 字节无变化；消费后的队列引用释放，多个读请求按顺序完成 |
| pkt-line 非法长度或截断 | 当前读取报错，无挂起或静默丢失负载 |
| 编烧树不变、源修改后撤销 | 不变时命中；撤销后恢复旧编烧字节，即使其他源仍有修改 |
| 删除编烧文件或子目录 | 下次同步恢复；无额外修改时后续同步恢复缓存命中 |
| 同步中断 | 完成标记失效，重试不得命中旧完成状态 |
| 编码表、库配置或算法版本变化 | 全量重建；新增配置库目录后下次同步能创建链接，移除库分类后业务文件恢复为副本 |
| 项目辅助文件 | `Project` 及 H750 MDK 的 `Obj/Flash` 下 `.sct/.ini/.scf` 能新增、修改和删除，`.o` 等产物不复制 |
| 源文件元数据快照 | 同大小并保留 mtime 的修改仍通过 ctime 等识别；已同步的 staged 文件不重复写入，撤销、未跟踪新目录及重命名结果正确。索引里的 blob 没变时，没被点名的已跟踪源文件不再 stat；只改工作区的文件仍重写，其余沿用。索引只刷新时间也沿用。已暂存且 blob 变了则整批取戳。未跟踪文件、skip-worktree 和项目辅助文件仍检查。Git 枚举失败，或这些仍要读取的源文件权限失败时中止 |
| 库文件元数据快照 | 库编码漂移后告警在缓存命中或其他业务文件更新时保留；库修复后消除告警 |
| 协议流错误和输出背压 | 保留输入原始错误；低 highWaterMark 下输出字节正确，写入失败或提前关闭时拒绝请求 |
| 输入积压与恢复 | 消费者空闲时队列达到约 256 KiB 后暂停上游，消费到约 64 KiB 时恢复；大于阈值的负载仍完整输出 |
| 设置重复读取、外部修改或删除 | 内容不变时复用解析；mtime/ctime/大小变化、删除或解析错误失效；返回对象的修改不污染缓存 |
| 编译数据库重复刷新 | 单槽内存缓存命中；XML、target、机型、工程目录变化时重建；损坏磁盘缓存可恢复 |
| 编译数据库输出不变或被覆盖 | 不变时两份输出都不写入；被覆盖或删除时恢复实际内容 |
| 性能日志增长 | 达到 5 MiB 后轮转，当前文件记录新操作，最多保留一份 `.1` 备份 |

过滤转码仍读取整个文件，不缓存文件内容，不是流式转码。目标文件元数据变化（含外部覆盖、替换和删除）会触发恢复；同大小并恢复 mtime 的覆盖也有回归测试。源或目标内容及全部元数据均被外部工具恢复成相同值时需清除完成标记重建，当前不做逐字节内容校验。硬件状态和编译/烧录结果不缓存。设置最多缓存 8 个工程；编译数据库只保留最后一份。用大文件、多小文件以及多次切换工程观察内存是否持续增长，区分 Buffer 的 `external/arrayBuffers` 与 JS 堆；单次峰值不能证明泄漏。

运行 `node extensions/benchmark_workspace.js E:/work/b_01_zkz_1 --current-filter` 可测当前源码过滤器；省略该选项使用工作区配置的过滤器。需要干净工作区。Git 对照使用编码表中已跟踪的文件，临时索引与对象目录独立，结束后验证真实索引、源码哈希、HEAD 和状态不变。报告中的 `memory` 是过滤子进程预加载探针的数据：`peakRssKiB` 为操作系统记录的进程 RSS 峰值，`baseline/final` 为启动和退出时内存快照，不能把退出时 heap/Buffer 用量当峰值。探针自身会带来少量开销；raw Git 没有 Node 子进程，因此没有相应内存记录。

## 性能比较

使用相同测试仓库、工具版本与机器，分别记录首次运行和连续至少 5 次的重复运行，中位数与最大值均保留。比较优化前后的编码结果、Git diff 和产物，再比较耗时，不预设加速比例。

```powershell
Measure-Command { git status --porcelain -z --untracked-files=all | Out-Null }
Measure-Command { git diff --no-ext-diff | Out-Null }
Get-Content .zkz/run/performance.jsonl -Tail 20
```

干净 `git status` 通常不执行过滤，不能单独用它证明过滤速度提高。在独立仓库中用相同的一组源文件执行实际触发 clean 的 `git add`，以及触发 smudge 的文件恢复/检出，分别计时，并在每轮开始前重置相同测试状态。已有文件、新文件、GBK/UTF-8、CRLF 和库路径都要覆盖。

性能日志目前覆盖编码表构建、编烧树同步、compile_commands 生成，以及本地配置替身。替身阶段名是 `zkz-native.localConfig`，`step` 为 `prepare` 或 `restore`，并带 `command`、`moved`、`copied`、`ms`。不记录每次 clean/smudge。编烧树观察 `cacheHit`、`written`、`skipped`、`dirty`、`sourceReuse` 与 `ms`，并用 `gitListMs`、`sourceScanMs`、`targetCheckMs` 定位文件枚举、源元数据及项目扫描、目标存在检查开销。`sourceReuse` 为真表示已跟踪源文件沿用了 blob 戳。`dirty` 现在是相对上次同步元数据变化的路径数，不是 Git status 的修改数。编译数据库日志只有耗时、条目数、机型和 target。目标文件 stat、未跟踪文件和 Git 枚举仍有 I/O。
