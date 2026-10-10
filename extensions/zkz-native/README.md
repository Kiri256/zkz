# zkz Native

在**真源**工作区用 git clean/smudge 把 `.c/.h` 检出成 UTF-8，提交时写回仓库原编码（GBK / ASCII / UTF-8 / UTF-8 BOM）。不改仓库 blob。只开真源。

## 做什么

| 边界 | 编码 |
| --- | --- |
| 工作区（编辑器 / Agent / clangd） | 恒 UTF-8 |
| 仓库 blob | 按文件保留原编码 |
| 编烧树 `.zkz/keil-native/` | 仓库原编码，给 Keil 用 |

转换只发生在 git 的 blob ↔ 工作区边界：

- **smudge（检出）**：blob → UTF-8
- **clean（add/commit）**：UTF-8 → 原编码

编码表在本机 `.zkz/run/.workspace_source_encodings.json`（不进仓库），按路径决定每个文件怎么转。新文件第一次 clean 或同步编烧树时按当前编码登记：ASCII、UTF-8、UTF-8 BOM、GBK 均保留原字节（包括 BOM 和换行），不改工作区文件。UTF-8 新文件可以包含 GBK 无法表示的字符。后续提交和编烧树同步按登记的编码处理；已有文件仍按原编码表处理。

`native.enabled`、`native.glob` 写在 `.zkz/settings.json`。过滤器开或关以本机 git 配置为准（`zkz-native.enable` / `disable`）。

## 命令

| 命令 | 说明 |
| --- | --- |
| `zkz-native.enable` | 建表、装本地 filter/hook、把非库源码 smudge 成 UTF-8，并只对这些文件做往返自检 |
| `zkz-native.disable` | 卸 filter，按仓库原编码重新检出 |
| `zkz-native.refreshTable` | 按 HEAD 刷新编码表；重命名/新增后应刷 |
| `zkz-native.checkRoundtrip` | 检查当前 GBK 文件能否无损编回 cp936 |
| `zkz-native.status` | 状态摘要（状态栏点击弹出命令列表） |
| `zkz-native.syncKeilTree` | 把工作区 clean 到 `.zkz/keil-native/` |
| `zkz-native.copyDebugAxf` | 把调试 axf 拷到 `.zkz/output.axf` |
| `zkz-native.saveConfigOverlay` | 把 `.zkz/settings.json` 里 `native.paths` 列出的本机配置存成权威副本（切分支后提示是否还原） |
| `zkz-native.restoreConfigOverlay` | 立刻从权威副本还原上述全部路径；目录保留，只删其中除 `.gitkeep` / `gitkeep` 以外的文件 |

`.zkz/settings.json` 的 `native.paths` 只给手动的 overlay 保存/还原用。旧的 `.zkz/config_paths.json` 会在读取时并进这份名单后删除；其中的 `skipWorktree` / `overlay` / `forbidStage` 也会合并进来。这些文件按普通 Git 路径显示在更改里，不再 skip-worktree，也不禁止暂存。`.zkz/` 内部文件不进 overlay。

`zkz-native.isEnabled` / `zkz-native.resolveRoot` 仍可调用，不出现在命令面板。`zkz-code` 和 `zkz-keil` 不走这两个命令。

启用要求工作区干净。本地配置写在 `.git/info/attributes` 和 `.git/config`，不进仓库。filter 为 `required=true`：起不来时 git 会失败，这是为了避免把错误编码写进仓库。

git hook 只保留 `pre-commit` / `pre-push`（挡坏提交/推送）。过滤器启用时，监视 `.git/HEAD` 的分支指向：换分支才弹出通知并刷新编码表，同时询问是否从权威副本还原本地配置。同分支上的提交和撤回不触发。过滤器关闭后不再监视分支、不刷表、不提示还原，其它命令也不会执行，直到再次 Enable。不再走 `post-checkout` 等 hook。失败另有警告。

过滤器异常时运行 **zkz-native.disable** 即可卸掉（只改 `.git/config` 与 attributes，不依赖 filter 进程）。

往返失败会记入 `.zkz/run/roundtrip-failures.json` 并在状态栏标出。`pre-commit` / `pre-push` 会拦编码不对的 blob。握手被拒时写 `.zkz/run/handshake-reject.json`（含首包 hex）。

`ZKZ_NATIVE_LOG=1` 时写 `.zkz/run/zkz-native.log`。

## 编烧 / 调试

`zkz-keil` 在真源且 native 已启用时：

1. 同步编烧树（未改文件可跳过，改过的走 clean）
2. 编 `.zkz/keil-native` 下的工程
3. 把 hex/axf 拷回真源 `Project` 产物路径
4. gdb map 用 `substitute-path 编烧树 → 真源`

库目录在编烧树里是 junction，名单是 `.zkz/workspace_lists.json` 的 `libraryDirNames`。没有这项时用内置默认（Libraries、FreeRTOS、Modbus_zlg、FPU_DSP、RL-ARM、emWin、fatfs、USB）。真源根上已经是链接的目录也会链上。改完后重新加载窗口，再同步编烧树。axf 里若已是真源路径则不要误 substitute。

## 内存与缓存优化

Git 使用长驻 `filter.zkznative.process` 在同一进程内处理多个文件。握手完成后只加载一次编码表，后续 clean/smudge 直接复用内存映射，减少逐文件读取编码表和检查文件时间戳的开销。新文件首次 clean 仍立即通过独立的 `encoding-table` 锁保存编码表，并把映射写入当前进程的内存表，后续请求可直接命中。

缓存仅持续到该过滤进程退出，不缓存文件内容或转码结果，也不跨 Git 命令持久保留内存。进程存活期间不会重新读取外部修改的编码表；应在当前 Git 操作结束后刷新编码表，再发起下一条 Git 命令。其他调用 `loadTable` 的扩展操作按编码表文件的 mtime、ctime 和大小判断缓存是否失效。

过滤失败状态在进程首次成功请求时检查并清零，后续成功请求跳过重复读取；中途失败会使该缓存失效，下一次成功重新清零。GBK 往返失败的记录与检查仍独立执行。

`roundtrip-failures.json` 保留历史诊断；状态统计忽略当前已不存在的文件路径，避免删除或迁移目录后的旧告警持续显示。仍存在的文件不会因记录较旧而隐藏，成功执行 GBK clean 后才清除对应失败项。

过滤进程启动及每次编烧树同步时刷新库目录集合快照，操作中的路径匹配只查询内存 Set，不逐文件检查配置；修改库目录配置应等待当前 Git 操作结束再执行下一条命令。其他操作使用按配置文件路径、mtime、ctime 和大小校验的动态缓存，最多保留 8 个仓库。过滤响应逐包编码写出，等待写入完成及背压解除后才发送下一包，协议输出临时缓冲区最多为一个包，不再分配整文件响应缓冲区。

pkt-line 输入使用分块队列，收到数据时不再复制全部未消费内容；包落在同一块时使用 Buffer 视图，跨块时仅复制该包。队列达到约 256 KiB 时暂停输入，消费到约 64 KiB 时恢复，避免消费者等待输出时继续接收大量数据；阈值不包含上游内部缓冲，单个输入块也可能超过阈值。消费完的块会释放队列引用，避免长期积累。协议头或负载被截断、长度非法时会拒绝当前读取；输入流错误保留原始异常并拒绝待处理及后续读取，输出错误或提前关闭也会拒绝写入。转码仍需读取完整文件，此优化没有把整体过滤改成流式转码，也没有设置文件大小上限。

编烧树另有磁盘 stamp 与完成标记。同步使用 `git ls-files --cached --others --exclude-standard -z` 枚举已跟踪与未忽略的新文件，再比较实际源文件的大小、精确 mtime、ctime 和文件编号，无需 `git status` 的内容比较及过滤开销。stamp 保存上次成功同步的源文件元数据，因此修改撤销后仍能恢复编烧字节；已暂存但源文件不再变化时无需反复复制。Git 枚举失败或源文件读取权限异常会中止同步，不当作缓存命中。这些缓存与 Git 过滤进程的内存表相互独立。

stamp 的失效条件包括算法版本、HEAD、分支、编码映射内容和库目录快照。编码规则、库分类或库目录存在情况变化时全量重建；缺少完成标记或旧版本 stamp 也会全量重建，覆盖中断操作已写出的文件。项目目录的 `Obj/Flash` 等跳过目录仍保留 `.sct/.ini/.scf`，其他编译产物继续跳过。

增量同步同时检查 stamp 中目标文件的大小、mtime、ctime 和文件编号。编烧文件被外部覆盖、替换或删除后，下次同步会恢复对应文件；其他源文件同时修改也不影响恢复。实际同步写入前清除完成标记，全部完成后再生成，避免中断操作留下可命中的旧标记。命中缓存仍需 Git 文件枚举及源、目标文件 stat，不使用延迟或 TTL 跳过检查。目标元数据变化时直接重新生成，避免额外读取并哈希整个目标文件。源或目标内容与全部上述元数据都被外部工具恢复成相同值时，元数据检查无法识别，应清除完成标记后全量同步；此机制不是逐字节内容校验。

库源文件也保留元数据快照，只在变化时检查编码。已有库告警会在其他文件更新及缓存命中时继续保留，修复对应库文件后清除。项目辅助文件每次重新枚举，能发现 Git 忽略的新增链接脚本。普通业务文件的新建仍遵循 Git ignore；已经复制的文件即使被忽略，后续修改和删除仍会检查。

缓存正确性、冷启动与重复操作耗时的检查见源码仓库中的 `extensions/validation.md`（三个扩展验收指南）。性能数据 `.zkz/run/performance.jsonl` 当前记录编码表构建、编烧树同步及 compile_commands 生成，不记录每次 Git clean/smudge 耗时；Git 性能应单独计时。

编烧树日志增加 `gitListMs`、`sourceScanMs`、`targetCheckMs`，分别记录 Git 文件枚举、源文件元数据及项目扫描、目标文件元数据检查耗时；总 `ms` 还包含配置、链接处理、转码写入等开销。

## 限制

- 换机器 / CI 没装本地 filter 时，检出的是原始 GBK，通常无所谓。
- 非 `.c/.h`（如 `.uvproj`）保持原字节，工具可能乱码。
- VS Code 内置内联 diff 左侧对 GBK blob 仍可能乱码；CLI `git diff` 有 textconv。
- 重命名 GBK 文件后必须先刷新编码表，否则会按新文件写成 UTF-8。
- 库目录不过滤，编码没有 clean 兜底；编烧树里仍是 junction。改过的库 `.c/.h` 会在同步编烧树、提交和推送时巡检：HEAD 为 GBK 而当前变成 UTF-8，或出现 U+FFFD，会写入 `.zkz/run/lib-encoding-warnings.json` 并告警，不改文件、不拦编译。要提交时拦住，设 `git config --local zkz.libEncodingStrict true`。
