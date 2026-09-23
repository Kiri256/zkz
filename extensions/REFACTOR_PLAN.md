# zkz 扩展审查与重构计划（回退后版本）

> 适用代码基线：git 提交 `b476319`（"1"），即回退到较早版本后的当前磁盘状态。
> 范围：`extensions/zkz-native`、`extensions/zkz-code`、`extensions/zkz-keil`。
> 注意：本文件已按回退后的**真实文件内容**重写。上一版计划里针对 git-wrapper 死代码子系统、JS↔Python 双运行时、compile_commands 双实现、git_head/hooks 三包重复等内容，在当前版本已不适用。

## 0. 回退让哪些"旧债"消失了

经逐一 `Test-Path` / grep 核实，上一版报告里列为"最大债"的三条，在当前版本已不存在：

| 旧报告中的"最大债" | 当前版本实况 |
|---|---|
| zkz-native 整套 git-wrapper 死代码子系统（`git_wrapper.js`/`git_wrapper_install.js`/`git_shim.cs`/`bin/git.exe`/`git_head.js`/`overlay.js`） | 这些文件**都不存在**；激活链已简化（`extension.js` 36 行，无 setImmediate） |
| JS ↔ `native_hook.py` 双运行时行为分叉 | `native_hook.py` **源已删**，只剩孤儿 `python/__pycache__/*.pyc`；当前 JS（`filter_process.js`/`textconv.js`/`hook_runner.js`）是唯一运行时 |
| zkz-code 的 `compile_commands_core.js`↔`cc_hook.py` 双实现、`git_head.js`/`hooks.js` 三包重复 | 这些文件在 zkz-code 里**都已不存在**；compile_commands 只剩 `compile_commands.js` 一条路径，不再 spawn python |

健康度评分因此回升：**zkz-native 7/10、zkz-code 6.5/10、zkz-keil 5.5/10**（上一版三个都约 4/10）。

**总体结论：当前版本不需要"大重构"，只需要"轻量清理 + 局部加固"；但 zkz-native 存在若干值得单独讨论的架构级设计缺陷（见第 2 节）。**

---

## 1. 当前真实存在的问题（三包汇总）

### 1.1 跨包重复（现在只剩两处）

- `zkz-keil/src/pair.js` 与 `zkz-code/src/pair.js` **SHA256 逐字节相同**（`138AD263...`）——复制粘贴。
- `encoding.js` 在 zkz-native 与 zkz-code 各一份独立副本。
- （旧的 git_head/hooks/compile_commands 三包重复已随回退消失。）

### 1.2 zkz-native（7/10）

- 全链 `spawnSync`/`readFileSync` 同步跑在扩展主线程，激活/enable 有卡顿风险。
- 激活关键步骤全空 catch（`extension.js:21/23/25`），配置没装上用户无感。
- **硬编码本机绝对路径**：`hooks.js:91` 写死 `C:/Users/Administrator/Desktop/zkz/scripts`。
- 三处各写一遍的 git 输出解析（`enc_table.js:89`、`precommit.js:9`、`keil_tree.js:130`）。
- 卫生：死命令 `zkz-native.copyArtifacts`（+ 后端 `copyArtifactsBack`）、多个死导出（`splitPackets`/`setKind`/`nativeLogPath`/`defaultConfigPaths`）、`appendLog` 已成空壳仍被大量调用、孤儿 `.pyc`。
- filter-process 握手/终止靠启发式 + 私有 API `process.stdout._handle.setBlocking`；`textconv` 不读编码表，与 smudge 判定可能分叉。

### 1.3 zkz-code（6.5/10）

- `status.js` **466 行上帝文件**（名为 status，实为全扩展主控：宏同步 + 命令 + watcher + FFFD + clangd），12 个模块级全局 `let`。
- `evalPpExpr`（`macros.js:261`）**不支持位运算 `& | ^ ~ << >>`、十六进制 `0x1F`、三元 `?:`**——`#if (FLAGS & 0x2)` / `#if VER >= 0x10` 会算错，正确性隐患。
- 死代码：`toast.js` 整文件、`encoding.js` 6/7 导出、`compile_commands.js:workspaceLayout`、`macros.js` 4 个薄包装、孤儿 `.pyc`。
- `macros.js:3-4/351` mojibake 乱码注释；`status.js` 大量 `\uXXXX` 中文串（讽刺：FFFD 检查包自身带乱码）。
- ~48 处空 catch、~59 处同步 IO。

### 1.4 zkz-keil（5.5/10，三包最弱）

- **配置全硬编码**：`D:\ruanjian\keil\UV4\UV4.exe`（`keil.js:31`）、JLink 路径、FLM、`STM32H750IB`、6000kHz、QSPI 地址；flavor 靠目录名 `indexOf('h750')`（`keil_layout.js:9`）。
- **`keil.js` 412 行上帝文件**；`spawnUv4` 用 `setInterval` 每 500ms 同步轮询日志文件（`keil.js:121-162`）。
- **三处高脆弱外部集成**（全部证实）：对全局 `JLinkDevices.xml` 用字符串 `indexOf/slice` 打补丁（`keil_flash.js:95-143`）、靠 stdout 正则判烧录成败（`:216-224`）、手写 Intel HEX 解析且**不校验 checksum**（`:145-173`）。
- 死代码：`resolveTarget` 的 `requested` 参数恒空（`keil.js:40-44`）、`jlink_devices` 目录写了但 JLink 不读（`keil_flash.js:274`）、`pair.js:assertRootGit`。

---

## 2. zkz-native 架构级设计缺陷（重点）

zkz-native 的方案核心：repo blob 保留原编码（GBK/ASCII/UTF-8），工作区经 git clean/smudge filter 呈现为 UTF-8；每个 `*.c`/`*.h` 的编码由 `.zkz` 里一张 `路径 → kind` 表决定。以下按严重度排列其设计缺陷。

### 缺陷 1：真相源错位——编码表与对象库是两份真相，靠时序 hook 维持一致（最根本）

- `clean`/`smudge` 完全信任 `.zkz` 编码表（`filter_core.js:14-27`）。
- 但表是用 `HEAD:` 的 blob **离线构建**的（`enc_table.js:76` `specs = 'HEAD:'+p`）；filter 实际面对的是任意 blob（切分支/merge/其它客户端）。
- HEAD 变而表未及时重建（`reset --hard`、外部 git、CI、构建静默失败）时，`clean`/`smudge` 会用过期 kind 转码，**静默产出错误编码**。正确性被外包给"必须每次准时跑成功"的 hook，契约脆弱。

### 缺陷 2：`required=true` filter + 手写脆弱协议 + 写死 node 绝对路径 = 高爆炸半径单点

- `filter.zkznative.required=true`（`git_config.js:114`）：filter 起不来或协议不符，**所有 `git status/add/checkout/commit/diff` 全部失败**，仓库 git 不可用。
- filter 是手写 filter-process v2：握手靠 `raw.indexOf('git-filter-client')>=0`（`filter_process.js:20`）、依赖私有 API `process.stdout._handle.setBlocking`（`:10`）、不实现 `delay`/`abort`、`writeError` 后不继续消费（`:52-57`）。
- node 绝对路径由 `nodeBin()` 探测后**写死进 `.git/config`**（`git_config.js:107-108`）。换机器/换 node/便携环境即失效 → filter 起不来 → `required=true` → git 全挂。

### 缺陷 3：soft-fail 把正确性让渡给可绕过的 hook（职责错配）

- `clean` 往返失败时，默认（非 strict）不报错、原样交回工作区字节（`encoding.js:143-150`），注释称"交给 pre-commit 拦"。
- 但 pre-commit 可被 `--no-verify` 跳过，外部客户端不装 hook。**强约束点（filter）做成软的，正确性兜底压在可绕过的 hook 上**，强弱职责放反，数据可能在 filter 层就错着放过。

### 缺陷 4：同一意图多份并行实现，天然分叉

- "blob→可读文本"两套：`smudge` 查表（`filter_core.js:15`）vs `textconv.js:12` 只 `detectKind`、不查表 → `git diff` 与工作区解码可能不一致。
- "库文件不过滤"两套：attributes 里 `top/** -filter`（`git_config.js:61-76`）vs filter 内 `isLibRel`（`filter_core.js:13`）→ 库集合可能漂移。
- git diff 解析器三份：`enc_table.js:89`、`precommit.js:9`、`keil_tree.js`。表增量正确性依赖它，分叉即回到缺陷 1。

### 缺陷 5：把具体工程特征硬编码进通用判定

- `verifyGitConfig` 用具体库名当"陈旧"哨兵：`attrStale = attr.indexOf('emWin/**') < 0 ...`（`git_config.js:143`）。换无 `emWin` 的工程会被永远判 stale、每次激活重写 attributes。
- 同类：`hooks.js:91` 写死 `C:/Users/Administrator/Desktop/zkz/scripts`。

### 缺陷 6：副作用最重的写操作放在同步激活路径且无反馈

- `extension.js:14-27` 同步执行 `verifyGitConfig`（可能重写 `.git/config` 与 attributes）、`installHooks`（写 hook）、`applySkipWorktree`，全 `spawnSync`、全空 catch。既有卡顿风险，失败又对用户完全静默。

### 一句话总结

用一张离线构建、易过期的旁路表（而非对象库本身）作为编码真相源，再用一个 `required=true`、手写、依赖绝对路径的强制 filter 去执行，最后把出错兜底交给可绕过的 hook——真相源、执行器、兜底三处的强弱职责都放反，导致"要么整仓 git 卡死，要么静默写坏编码"。

---

## 3. 分阶段计划

### 总原则

- 渐进式，不推倒重来；每阶段结束三包都能正常打包安装、功能不回退。
- 每阶段一个（或一组）commit，便于二分回滚。
- **验证基线**：每阶段后跑 `node extensions/zkz-native/test/run.js` + 三个 `package_zkz_*.py` 打包成功 + Reload Window 冒烟。
- 删文件前先全仓 grep 确认无 `require`，删完更新对应 `package_zkz_*.py` 白名单。

---

### 第 1 档 — 纯清理（零行为风险，先做）

1. zkz-native：删死命令 `zkz-native.copyArtifacts` + 后端 `copyArtifactsBack`；删死导出 `splitPackets`/`setKind`/`nativeLogPath`/`defaultConfigPaths`；删已空壳的 `appendLog` 及其调用；删孤儿 `python/__pycache__/`。
2. zkz-code：删 `toast.js`；`encoding.js` 只留 `bufferToText`，删其余 6 个死导出；删 `compile_commands.js:workspaceLayout` 与 `macros.js` 4 个薄包装；删孤儿 `python/__pycache__/`。
3. zkz-keil：删 `pair.js:assertRootGit`、`resolveTarget` 的死参数、无效的 `jlink_devices` 写入。
4. 更新 `package_zkz_native.py` / `package_zkz_code.py` 白名单（打包脚本 `_unlisted_requires` 会兜底校验）。
5. 修 `extensions/README.md`：版本号改真实值（native `0.0.25` / code `1.0.12` / keil `1.0.5`，或改为"见各 package.json"）。

**验证**：三包打包成功；native 测试通过；Reload 冒烟正常。回滚：纯删除，`git checkout` 恢复。

---

### 第 2 档 — 去本机耦合 / 可移植性（高收益，低-中风险）

1. zkz-native：
   - 去掉 `hooks.js:91` 硬编码 `C:/Users/Administrator/...`，改为基于仓库根/环境变量发现。
   - `verifyGitConfig` 的 `emWin/**` 哨兵（`git_config.js:143`）改为通用判定（比较期望的 attributes body 全文，而非某个具体库名）。
2. zkz-keil：把 UV4/JLink/FLM 路径、设备型号、速度、QSPI 地址、flavor 判定挪进 `package.json` 的 `configuration`；`keil_layout.js` 改为读配置 + 发现式，不再靠目录名 `indexOf('h750')`。这是"换机器就崩"的根因。
3. 抽 `pair.js` 为共享或统一走 `zkz-native.resolveRoot`，消 zkz-keil↔zkz-code 逐字节重复。

---

### 第 3 档 — 正确性 / 健壮性加固（中风险，需测试兜底）

1. zkz-code：`evalPpExpr` 补位运算 `& | ^ ~ << >>`、十六进制/八进制、三元 `?:`（或至少显式检测到不支持语法时告警而非静默算错）；补单测覆盖 `0x10`、`(FLAGS & 0x2)`、`A ? B : C`。
2. zkz-keil：HEX 解析加 checksum 与记录长度校验；烧录成败以退出码为主、stdout 正则为辅；评估 `JLinkDevices.xml` 全局打补丁的替代方案。
3. zkz-native：让 `textconv` 也读编码表以对齐 `smudge`；把三处 git diff 解析收敛为一个工具函数；关键激活步骤（`verifyGitConfig`/`installHooks`）失败至少落一条可见日志/通知。

---

### 第 4 档 — zkz-native 架构级加固（修订版，保留正确性护栏）

> 状态：**前 3 档已完成**。**第 4 档（修订版）已完成**：保留 `required=true` 与 clean soft-fail；sidecar + 状态栏 + pre-push；路径自愈 + 原子写 + `ZKZ_NATIVE_LOG=1`；smudge `reconcileSmudgeKind` + 表漂移自动刷新；in-flight 锁 + hook 自愈；握手失败一行错误。未改协议、未改 `required`、未让 clean 硬失败。
>
> **重要修订**：原第 4 档写的"改 `required=false`""clean 改硬失败"经复审会**削弱这套系统存在的意义（数据正确性）**，不采纳。原因见下。修订后只做加固，保留两个护栏。

#### 保留的护栏（不动）

- **`filter.zkznative.required=true`**（`git_config.js:121`）：这是正确性护栏。filter 失败时 git 宁可中止也不写错误编码。若改 `false`，坏掉的 filter 会静默把 UTF-8 字节塞进本应 GBK 的 blob → 制造这套系统要防的损坏。**保留。**
- **clean 往返失败走 soft**（`encoding.js:147-150`）：与 `required=true` 耦合——若 clean 在 `git status` 时硬失败，整条 status 会挂（测试 `clean Gbk unencodable is soft (status must not die)` 就在保这个）。git filter 协议不告知是 add 还是 status 触发，无法"只在提交时硬失败"。**保留**，正确性兜底仍由 pre-commit 承担。

#### 要做的加固（三项，全部保留开关/可回滚）

1. **4.1 node/脚本路径自愈（低风险）**
   - 现状：`verifyGitConfig`（`git_config.js:143-158`）仅比较 `have` vs 新算的 `want`，node 移动/升级后若 `where node` 找不到会静默失败。
   - 改法：新增 `commandPathsExist(cmd)`——用 `/"([^"]+)"/g` 解析出 `.git/config` 里 filter 命令引用的 node 与脚本路径，逐个 `fs.existsSync`；任一缺失即强制 `installGitConfig` 重装（用新解析的 node）。把该判定并入现有的 `attrStale || 路径不符` 触发条件。
   - 验证：构造 `have` 指向不存在的 node → 触发 repaired=true；现有 `nodeBin is real node` 测试不受影响。

2. **4.2 smudge 以 blob 实际编码为准（中风险，需测试）**
   - 现状：`filter_core.js:smudge` 表命中就用表 kind，表陈旧（切分支未刷）会出乱码或误解码。
   - 改法：新增 `reconcileSmudgeKind(actual, hinted)`，`smudge` 改为 `reconcileSmudgeKind(detectKind(blob), 表提示)`：
     - blob 实为 GBK（非合法 UTF-8）→ 一律 `Gbk` 解码，无视陈旧表；
     - blob 为合法 UTF-8/ASCII 但表仍标 `Gbk` → 用 blob 实际 kind，**绝不 GBK 解码**（避免损坏）；
     - 二者都属 UTF 家族 → BOM 细节沿用表。
   - 说明：只改 smudge。clean（工作区→blob）**无法**自推断（工作区永远 UTF-8，推不出原编码），仍必须靠表，不动。
   - 验证：新增两条用例——"表说 Utf8 但 blob 是 GBK → 正确解码""表说 Gbk 但 blob 是 UTF-8 → 原样直出";现有 6 条 smudge/clean 用例须继续通过。

3. **4.3 filter 协议健壮化（中风险，仅安全改动）**
   - 现状：`filter_process.js` 握手靠 `indexOf('git-filter-client')` 启发式（`:20`）、`setBlocking` 用私有 API（`:10`）、握手失败在 `main().catch` 里 dump 整个 stack（`:95-98`）。
   - 改法（不动 happy path）：握手失败改为输出**一行**清晰错误而非堆栈；`setBlocking` 不可用时保持 best-effort（已 try/catch），补一条注释说明 Windows 下的取舍。**不收紧**握手容忍度（收紧反而更易崩），协议单发/重写等大改**不做**。
   - 验证：手动 Reload + `git status`/`git add`/`git checkout` 冒烟正常。

#### 不做的事（明确排除）

- 不改 `required` 为 false；不让 clean 硬失败；不重写 filter-process 协议；不让 clean 去 cat-file 自推断（每文件调 git，性能/重入不可接受）。

#### 已决定的编码策略

- 工作区保持 UTF-8；`Utf8Bom` 保留为独立 kind，**这类 blob 的 BOM 必须保住**（smudge 从工作区剥 BOM 给 clangd/编辑器看，clean 再补回 BOM → blob 与编烧树保 BOM，正好满足 armcc 对 UTF-8 `.c` 的识别）。当前 `encoding.js` 已如此。
- **4.2 实施约束**：smudge 自推断时必须保证"blob 有 BOM → 仍判为 `Utf8Bom`"，不得把带 BOM 文件降级成 `Utf8` 而在工作区残留 BOM；须加对应用例。

---

### 第 4 档配套 — 健壮性专章

围绕 `required=true`（filter 必须永远正确运行）这个核心，分三类风险 + 横切工程措施加固。

#### 风险一：filter 一挂，整仓 git 全挂（爆炸半径）

- 4.1 node/脚本路径自愈（见上）。
- filter 对任何意外输入都回合法响应，宁可透传原字节也不崩进程；`handshake` 失败只影响当次 git 操作。
- 暴露易达逃生口：`zkz-native.disable` 不依赖 filter（只做 `git config --unset` + 改 attributes），filter 坏了也能一键卸；文档/状态栏显式提示。
- 熔断：filter 短时间连续失败 N 次 → 通知 + 提示禁用，不让用户面对"git 全挂却不知为何"。

#### 风险二：静默把错误编码写进 blob（最高优先）

- **让静默变响亮**：clean 每次 soft-fail 把出问题路径记入 `.zkz/roundtrip-failures.json`，状态栏/通知标红——即使本次没拦住也立刻可见。
- **加更难绕的第二道关**：除 pre-commit 外加 **pre-push** 钩子复检已提交 blob。
- **后台巡检**：激活/定时跑 `checkRoundtrip`，把"当前有多少文件编不回原编码"做成状态栏徽章。

#### 风险三：编码表与 HEAD 漂移

- 4.2 smudge 自推断，让检出侧不再依赖表。
- 漂移检测：比对 `table.head`（`enc_table.saveTable` 已存）vs 当前 HEAD，不一致则自动刷表或打警告徽章。
- 保证 `buildTableIncremental` 可靠、可频繁触发。

#### 横切工程措施（三包适用）

1. **原子写**：表 / config_paths / keil-native-stamp 等改为"写临时文件 + rename"。避免进程中途死掉截断表 → `JSON.parse` 失败 → 当空表 → clean 拒绝新文件/编错。
2. **可观测性**：恢复可选日志/输出通道（`appendLog` 现为空壳），关键路径（filter 安装、hook 安装、往返失败）至少落一条。
3. **并发锁**：`enable`/`refreshTable`/`syncKeilTree` 加 in-flight 锁，避免连点或与 hook 同时触发时竞争表文件。
4. **环境探测有反馈**：node/git/iconv-lite 缺失、junction 需权限/开发者模式，各给明确错误 + 状态提示，不空 catch 咽掉。
5. **hook 自愈升级**：从"仅在 `!hooksPresent` 时装"（`extension.js:22`）改为校验 hook 内容是否与期望一致，漂移即重写（对齐 `verifyGitConfig` 对 attributes 的做法）。
6. **测试即保险**：把陈旧表、BOM 往返、CRLF 组合、不可编码字符、重命名、原子写失败等边界钉进 `test/run.js`。

#### 健壮性实施优先级

1. **静默损坏变响亮**（sidecar 记录 + 状态栏 + pre-push）——先堵最危险的正确性漏洞。
2. **4.1 自愈 + 原子写 + 可观测性**——低风险高回报。
3. **4.2 smudge 自推断 + 表漂移检测**——治检出侧脆弱。
4. **并发锁 + hook 自愈 + 补测试**——收尾。

---

## 4. 阶段依赖与建议节奏

| 阶段 | 依赖 | 风险 | 收益 | 状态 |
|---|---|---|---|---|
| 第 1 档 清理 | 无 | 极低 | 中 | ✅ 已完成 |
| 第 2 档 去本机耦合 | 第 1 档 | 低-中 | 高（可移植性） | ✅ 已完成 |
| 第 3 档 正确性加固 | 第 1 档 | 中 | 高 | ✅ 已完成 |
| 第 4 档 native 加固（修订版） | 第 2/3 档 | 低-中 | 高 | ✅ 已完成（0.0.10） |

**第 4 档实施顺序建议**：以"健壮性专章 → 健壮性实施优先级"为准——① 静默损坏变响亮（sidecar + 状态栏 + pre-push）② 4.1 自愈 + 原子写 + 可观测性 ③ 4.2 smudge 自推断 + 表漂移检测 ④ 并发锁 + hook 自愈 + 补测试；4.3 协议小加固可随手插入。每项独立 commit，实施后跑 `node extensions/zkz-native/test/run.js` 并 Reload 冒烟。

---

## 5. 第 5 档 — 并发竞态与 filter 握手根治（现场事故驱动）

> 状态：**已完成**（源码，打包后需重装新 vsix 覆盖现场 0.0.11）。stdin 先挂 `PktReader` 再读表；握手失败落 `.zkz/handshake-reject.json`；原子写随机 tmp + 重试 + finally 清理；`withLock` 进程内链 + `.zkz/locks` 跨进程互斥；filter-fail 5 分钟衰减；hook 内 git 带 `-c filter.zkznative.required=false`。`required=true` 未改。
> 运行版本：已安装 `zkz.zkz-native-0.0.11`（node `D:/ruanjian/node/node.exe`，git 2.55.0.windows.5）。
> **重要：本档改的是源码，需重打包 + 重装 0.0.11 才生效。**

### 5.0 现场诊断（已还原）

时间线（`.zkz/filter-fail.json` + 9 个 `filter-fail.json.<pid>.tmp` 残留佐证）：

| 时间 | 事件 |
|---|---|
| 15:33:52–53 | 切分支瞬间 git 并发拉起 ~9 个 filter 进程，全部在 `handshake()` 抛 `unsupported filter handshake` 退出；计数冲到十几~21，弹告警；多进程同时抢写 `filter-fail.json` → Windows `rename` 撞车 → 遗留 9 个 `.tmp` |
| 15:35:43 | filter 又跑通一次，`resetFilterFail` 把计数清零，告警条件消失（**已自愈**） |

**性质**：一次性瞬时并发抽风，非持续故障；filter 本体没坏。"敲命令不报错"是那些命令基本没触发 `.c/.h` 的 smudge。已手工清理残留 `.tmp` 并确认计数归零。

### 5.1 根因分级

- **根因 A（filter 独有，强候选）**：`filter_process.js:main()` **先 `process.stdin.resume()` 再 `new PktReader` 挂 `'data'` 监听**（`:88` 早于 `:92`）。flowing 模式下若数据在监听器就绪前到达会被 Node 丢弃；正常同步路径不丢，但高并发 + Windows + node 冷启动被抢 CPU 时时序被打散，git 握手首包可能在监听前丢失 → 读到残缺内容 → 抛 `unsupported filter handshake`。与"只有切分支（并发暴涨）才翻车"高度吻合。对照：`precommit.js:readStdinText` 是"先挂监听再 resume"（正确），反证此处为 bug。
- **根因 B（filter + 所有 hook 共有）**：`paths.js:atomicWriteFile`（`:128-139`）在 Windows 并发下 `rename` 撞车走 `unlink+rename` 回退，多进程同写同一 sidecar 时失败并遗留 `.tmp`，极端下可写出半截/损坏的 JSON（编码表、filter-fail、roundtrip-failures 都受影响）。
- **根因 C（所有 hook 共有）**：`lock.js:withLock` 的 `chains` 是**单进程内模块级变量**；每次 hook 是独立 node 进程，此锁**跨进程完全失效**，给人假安全感。`hook_runner.js:lightRefresh` 外面这层锁防不住 `git pull`（post-checkout + post-merge）、rebase（post-rewrite）等相邻 hook 进程并发写编码表。
- **放大器 D**：`filter.zkznative.required=true` + 握手 `throw` 把"个别进程抖一下"放大成"整片 checkout 失败 + 刷屏"。
- **误导 E**：`observe.js` 计数器只在成功时清零（粘性），风暴后告警会一直挂到下次成功 smudge，制造"持续坏了"的错觉。

#### 5.1.1 现场实测结论（真凶已定位，非根因 A）

实施 5.3.1（stdin 监听顺序）后仍失败；5.3.2 的诊断 dump（`.zkz/handshake-reject.json`）抓到原始首包：

```
raw = "git-filter-clientversion=2"   // 两段之间没有任何换行符
headers = { "git-filter-clientversion": "2" }   // 黏成一个 key
env.cwd = "D:\\ruanjian\\cursor"      // Cursor 内置 git 拉起
```

- **真根因（记为 A′）**：`pktline.readTextHeaders` 采用"**把所有包拼接后按 `\n` 切**"。而部分 git 客户端（此处为 Cursor 内置 git）发的 pkt-line 负载**不带尾随 `\n`** → `git-filter-client` 与 `version=2` 黏成 `git-filter-clientversion=2`；且握手用 `/\bversion=2\b/`（单词边界）判定，黏连后 `\b` 不成立 → `ver=''` → 抛 `unsupported filter handshake`。命令头 `command=smudge`/`pathname=...` 同样会黏，**整条协议对该客户端全废**。带 `\n` 的 git 才碰巧能跑通（故此前计数会归零）。
- **根因 A（stdin 顺序）**：经实测**不是本次病因**；5.3.1 仍作为正确的健壮性改进保留。
- **修复（已实施 + 测试）**：
  - `pktline.readTextHeaders` 改为 **逐包解析**（一包=一条逻辑记录，再兼容包内 `\n`），带不带尾随换行都正确；`raw` 改为逐行 join。
  - `filter_process.handshake` 判定改用 `indexOf`（`raw.indexOf('git-filter-client')` + `headers.version==='2' || raw.indexOf('version=2')>=0`）替代 `\b` 正则，双保险（即便某客户端把两段塞进一个包也能识别）。
  - `test/run.js` 新增两条用例：`handshake accepts newline-less pkt-lines`、`readTextHeaders parses newline-less packets per-line`，全绿。
  - **仍需重打包 + 重装** 才在 `e:\work` 生效（当前跑的是旧 0.0.11）。

### 5.2 hook 侧现状评估（结论：hook 较安全，主崩点是 filter）

| 问题 | filter | post-checkout/merge/rewrite | pre-commit/pre-push |
|---|---|---|---|
| 假锁（进程内） | — | ✅ 有，防不住多进程 | — |
| atomicWrite rename 竞态 | ✅ | ✅（写编码表） | 间接 |
| 一次瞬时错误=硬失败 | ✅ 崩 checkout | ❌ 非致命（`main().catch` 不 `exit(1)` + hook 片段带 `\|\| true`），只打 warning | ⚠️ 挡提交/推送（可重试，fail-closed 合理） |
| stdin resume 顺序 bug | ✅ 独有 | — | ❌ pre-push 写对了 |

- post-checkout 内部即使抛错也不会让 checkout 失败（`hook_runner.js:64-67`），所以"切分支 hook 报错"大概率是 **checkout 阶段 smudge 的 filter 错误（`required=true`）** + post-hook 打的几行 warning 被一起当成"hook 报错"。
- buildTable 的 git 子命令（`cat-file --batch`/`ls-files`/`diff --name-status`）**不触发 smudge**，故 hook 本身不额外增加 filter 进程数；并发 filter 来自 git 自身 checkout 的 smudge + VSCode 内置 Git/clangd 等并发 git。

### 5.3 详细改法（按优先级，全部可回滚）

#### 5.3.1【根因 A】修 filter stdin 监听顺序（治本，低风险）

- 文件：`extensions/zkz-native/src/filter_process.js` 的 `main()`。
- 改法：**删除提前的 `process.stdin.resume()`；先 `const reader = new PktReader(process.stdin)`（挂 `'data'` 会自动切 flowing），再做 `findRepoRoot`/`loadTable`。** 保证任何字节都不会在监听器就绪前被丢弃。
- 具体顺序（改后）：
  ```
  setBlocking();
  const reader = new PktReader(process.stdin);   // 先挂监听
  const repoRoot = findRepoRoot(process.env.GIT_WORK_TREE || process.cwd());
  const table = loadTable(repoRoot);
  const out = process.stdout;
  if (!await handshake(reader, out)) return;
  ```
- 验证：现有 filter 冒烟（Reload 后 `git status`/`git add`/`git checkout`）；有条件时构造并发压力（多个 `git` 同时跑）复现前后对比。

#### 5.3.2【根因 A 诊断】握手失败落原始首包（低风险，抓现行）

- 文件：`filter_process.js:handshake`。
- 改法：`throw new Error('unsupported filter handshake')` 前，把 `first.raw` 的**原始字节 hex + 解析出的 headers** 写入 `.zkz/handshake-reject.json`（含 pid、时间、`process.env` 关键项）。用现有 `atomicWriteJson`（修完 5.3.3 后并发安全）。
- 目的：万一 5.3.1 没完全根治，下次复现能一眼看清 git 到底发了什么、我方读到什么，把"高置信推测"钉成"确定结论"。
- 验证：构造非法首包 → 断言 sidecar 落盘且内容含 hex。

#### 5.3.3【根因 B】原子写并发安全 + 清理 tmp（治本，中风险，全局收益）

- 文件：`extensions/zkz-native/src/paths.js:atomicWriteFile`。
- 改法：
  - tmp 名加随机后缀防同 pid/同毫秒撞名：`file + '.' + process.pid + '.' + Date.now().toString(36) + Math.random().toString(36).slice(2,8) + '.tmp'`。
  - `rename` 失败时**带小重试**（如 3 次、每次 sleep 数十 ms，覆盖 Windows 上目标被短暂占用）。
  - **`finally` 里清理残留 tmp**（`fs.existsSync(tmp) && fs.unlinkSync(tmp)`），杜绝垃圾文件。
- 影响面：filter-fail、roundtrip-failures、编码表、keil-native-stamp 等所有 sidecar 一并受益。
- 验证：新增用例——两个"写者"交错写同一文件后，目标文件为合法 JSON 且目录无 `.tmp` 残留。

#### 5.3.4【根因 C】withLock 升级为跨进程文件锁（治本，中风险）

- 文件：`extensions/zkz-native/src/lock.js`（保持 `withLock(key, fn)` 签名，`hook_runner.js` 不改调用）。
- 改法：以 `.zkz/locks/<hash(key)>.lock` 目录/文件做**跨进程互斥**：
  - 用 `fs.mkdirSync(lockDir)`（原子）或 `fs.openSync(lockFile, 'wx')` 抢锁；抢不到则轮询等待到超时（如 10s）。
  - 记录持有者 pid + 时间戳；**过期陈旧锁**（持有者已死 / 超过 TTL 如 60s）可强夺，防死锁。
  - `finally` 释放（删目录/文件）。
  - 仍保留原进程内串行（两层：进程内 Promise 链 + 进程间文件锁），双保险。
- 验证：新增用例——两个进程/两次并发 `withLock(sameKey)` 串行执行、无交叠；陈旧锁能被强夺。
- 备选（更省事，若不想引入文件锁）：仅把 `buildTable` 的编码表写入依赖 5.3.3 的并发安全原子写兜底；但**推荐做真锁**,因为它同时解决"半截表"以外的重入问题。

#### 5.3.5【误导 E】计数器去粘性（低风险，可选）

- 文件：`extensions/zkz-native/src/observe.js:loadFilterFail`/`recordFilterFail`。
- 改法：读取时若 `now - at > 阈值`（如 5 分钟）自动视作 0（时间衰减），避免"早自愈了还挂着 21 次"的误导。或达到告警上限并通知后自动 reset。
- 验证：构造 `at` 为很久以前 → `loadFilterFail` 返回 count 0。

#### 5.3.6【放大器 D】降并发窗口（可选，中风险）

- 让 post-checkout 等 hook 内部的 git 子命令带 `-c filter.zkznative.required=false` 运行（`git_exec` 统一注入），即使 hook 期间意外触发 filter 也不会硬崩。
- 注意：`required=true` 的正确性护栏**只在真正检入检出路径保留**；hook 内部只读 blob 的辅助命令降级为非必需是安全的。

### 5.4 实施顺序与验证

1. 5.3.1（stdin 顺序）+ 5.3.2（握手诊断）——一个 commit，治本 + 抓现行。
2. 5.3.3（原子写并发安全）——一个 commit，全局竞态收口。
3. 5.3.4（跨进程文件锁）——一个 commit，hook 竞态收口。
4. 5.3.5 / 5.3.6——可选收尾，各独立 commit。

每步后：`node extensions/zkz-native/test/run.js` 全绿 + `package_zkz_native.py` 打包成功 + Reload 冒烟（`git status`/`add`/`checkout`/切分支）。**打包后需在目标机重装新 vsix 覆盖 0.0.11 方生效。**

### 5.5 明确不做

- 不改 `required` 为 false（正确性护栏，仅 5.3.6 对 hook 内部辅助命令局部降级）。
- 不重写 filter-process 协议、不改握手容忍度（收紧反而更易崩）。
- 不为消除 filter 而做全仓 blob 转 UTF-8（与"blob 保留原编码"既定策略冲突）。

---

## 6. 第 6 档 — hook / filter 去硬编码路径（跨客户端可移植）

> 状态：**待实施**。触发：`.git/hooks/post-checkout:47` 与 `.git/config` 的 filter/textconv 命令把 **node 绝对路径 + 版本 pin 的扩展目录**写死。这些 hook/filter **VSCode、命令行等所有 git 客户端都会执行**，不只 Cursor。

### 6.0 风险定级

现场硬编码行（`e:\work\b_01_zkz_4\.git\hooks\post-checkout:47`）：
```
"D:/ruanjian/node/node.exe" "c:/Users/Administrator/.cursor/extensions/zkz.zkz-native-0.0.11/src/hook_runner.js" post-checkout "$@" || true
```

- **版本目录 pin `zkz.zkz-native-0.0.11`（致命）**：Cursor 升级扩展到新版本后旧目录被删 →
  - `.git/config` 的 `filter.zkznative.process`（`required=true`）指向已删除脚本 → **所有客户端 git 全挂**，直到扩展在 Cursor 内重新激活自愈；
  - `pre-commit`/`pre-push`（`exec node .../hook_runner.js`）模块缺失 → 非零退出 → **挡提交/推送**；
  - VSCode/CLI **不触发** Cursor 扩展的 `verifyGitConfig`/`verifyHooks` 自愈 → 升级窗口内直接踩空。**与第 5 档事故同类**。
- **node 绝对路径 `D:/ruanjian/node/node.exe`（次要）**：同机 VSCode/CLI 共用同一 node，node 不搬家即有效；换机/搬家才失效（换机时扩展激活会自愈）。

结论：**版本目录 pin 是真正的可移植性杀手**（"其它客户端 + 扩展升级"必翻车）；node 绝对路径次要。

### 6.1 现状生成链

- `hooks.js:nativeSnippet` 用 `nodeBin()`（`git_config.js:16-28`）+ `scriptPath(extensionRoot,...)` 直接拼出"绝对 node + 版本目录脚本"写进 hook。
- `git_config.js:installGitConfig` 同样用 `quoteCmd(nodeBin(), scriptPath(extensionRoot,'filter_process.js'))` 写进 `.git/config`。
- 两者都把 `extensionRoot`（含版本号的目录）钉死。`verifyGitConfig` 的 `commandPathsExist` 只能在**扩展激活时**发现失效并重装——救不了不激活扩展的其它客户端。

### 6.2 根治设计：稳定启动器 + 运行时解析

不再直连"版本目录里的脚本 + 绝对 node"，改为指向**版本无关的稳定启动器**，由它在运行时解析 node 与当前扩展目录。

1. **启动器**：扩展在每仓库写 `.zkz/native/zkz-run.sh`（稳定路径，跨版本不变；加入 `.git/info/exclude`）。内容：
   ```sh
   #!/bin/sh
   NODE="${ZKZ_NODE:-}"
   [ -n "$NODE" ] && [ -x "$NODE" ] || NODE=$(command -v node 2>/dev/null)
   [ -n "$NODE" ] || NODE=$(cat "$(dirname "$0")/node-path" 2>/dev/null)
   [ -n "$NODE" ] || NODE=node
   SRC=$(ls -dt "$HOME"/.cursor/extensions/zkz.zkz-native-*/src 2>/dev/null | head -1)
   [ -n "$SRC" ] || SRC=$(cat "$(dirname "$0")/src-dir" 2>/dev/null)
   exec "$NODE" "$SRC/$1" "${@:2}"
   ```
   - node：环境变量 → PATH → 扩展记录的回退文件 `.zkz/native/node-path` → 兜底 `node`。
   - 扩展目录：glob 最新 `zkz.zkz-native-*/src`（**版本无关，升级不 pin**）→ 回退到扩展记录的 `.zkz/native/src-dir`。
   - `exec` 传递退出码/信号（pre-commit/pre-push 退出码、filter 进程生命周期依赖）。
2. **hook 片段**（`hooks.js:nativeSnippet`）改为：
   ```sh
   "$(git rev-parse --show-toplevel)/.zkz/native/zkz-run.sh" hook_runner.js post-checkout "$@" || true
   ```
   pre-commit/pre-push 保持 `exec sh ".../zkz-run.sh" hook_runner.js <event> "$@"`。
3. **`.git/config`**（`git_config.js:installGitConfig`）改为（repoRoot 绝对路径为 per-clone，可接受；node/版本由启动器解析）：
   ```
   filter.zkznative.process = sh "<repoRoot>/.zkz/native/zkz-run.sh" filter_process.js
   diff.zkznative.textconv  = sh "<repoRoot>/.zkz/native/zkz-run.sh" textconv.js
   ```
4. **写启动器 + 回退文件**：新增 `installLauncher(repoRoot, extensionRoot)`——写 `zkz-run.sh`（LF 行尾、`chmod 755`）、`node-path`（= `nodeBin()`）、`src-dir`（= `<extensionRoot>/src`）；被 `installGitConfig`/`installHooks` 调用。
5. **exclude**：`git_config.js:excludeBody` 增加 `.zkz/native/`。
6. **平滑迁移 + 自愈**：`verifyGitConfig`/`verifyHooks` 识别旧的"版本 pin 直连"格式（命令里含 `.cursor/extensions/zkz.zkz-native-<ver>/`）即判 stale → 重写为启动器格式，并刷新 `zkz-run.sh`/`node-path`/`src-dir`。`commandPathsExist` 相应改为校验启动器存在。

### 6.3 Windows / 跨客户端注意

- git for Windows 通过自带 `sh` 执行 filter.process 与 hook；`sh` 启动器与 `ls -dt` glob 在 git-bash 下可用。`$HOME` 在 git-bash = `/c/Users/<user>`。
- 若同时用 VSCode 且其扩展目录不同，glob 可扩展为同时搜 `~/.cursor/extensions` 与 `~/.vscode/extensions`（一般 zkz-native 只装在 Cursor，默认搜 `.cursor` 即可）。
- filter.process 是长驻进程（每次 git 调用一个），启动器的 `sh` 开销可忽略；textconv 每文件一次，开销亦小。

### 6.4 备选方案（更重，不推荐默认）

- **vendored 运行时**：把 `filter_process.js`/`textconv.js`/`hook_runner.js` 及其依赖（含 `node_modules/iconv-lite`）整体拷进 `.zkz/native/`，git-time 完全不依赖扩展目录。最抗升级，但需拷贝依赖图（iconv-lite 较重）且要保持同步，维护成本高。仅在"扩展可能被完全卸载仍需 git 正常"时才考虑。

### 6.5 实施顺序与验证

1. 新增 `installLauncher` + 改 `excludeBody`（一个 commit）。
2. 改 `hooks.js:nativeSnippet` + `git_config.js:installGitConfig` 引用启动器（一个 commit）。
3. 改 `verifyGitConfig`/`verifyHooks`/`commandPathsExist` 识别旧格式并迁移（一个 commit）。
- 验证：`node extensions/zkz-native/test/run.js` 全绿；装好后检查 `.git/hooks/*` 与 `.git/config` 无版本号；**模拟扩展升级**（把 `zkz.zkz-native-*` 目录改名新增一个更高版本）后，不重激活扩展直接 `git status`/切分支/`git commit` 仍正常；VSCode 下同验。

### 6.6 明确不做

- 不把 `.git/config`/hook 里的 repoRoot 绝对路径也去掉（per-clone、非提交物，无跨机问题；相对路径反而受 cwd 影响更脆）。
- 不默认走 vendored 依赖拷贝（见 6.4）。

---

## 7. 第 7 档 — compile_commands 收敛到 zkz-code（方案 B：hook 经启动器调 JS）

> 状态：**待实施**。触发：`.git/hooks/post-checkout:29-30` 用 `python "$ZKZ_SCRIPTS/lib/getcompile_commands.py" "$ROOT"` 生成 clangd 的 `compile_commands.json`，与 `extensions/zkz-code/src/compile_commands.js` 是**同一算法的两份实现**。

### 7.0 问题：同一 YTSwarm+绝对化算法维护在两种语言里

`scripts/lib/getcompile_commands.py` 与 `zkz-code/src/compile_commands.js` 逐段等价：

| 步骤 | python | zkz-code JS |
|---|---|---|
| Keil 布局识别（h750/f429） | `resolve_keil_layout` | `resolveKeilLayout` |
| 跑 YTSwarm.exe 抽取 | `subprocess.run([ytswarm, uvproj])` | `spawnYtSwarm` |
| 绝对化（跳 `.s`、`<compilerPath>`→clang、`-I` 绝对化、路径转 `\`） | `absolutize_entries` | `absolutizeEntries` |
| 写 `mdk/compile_commands.json` + 拷到仓库根 | 是 | 是 |

- 唯一差异且 **JS 更强**：JS 的 `preferredLayout` 先调 `zkz-keil.resolveLayout` 拿动态布局，python 只能硬编码。python 是 JS 的退化副本。
- 触发时机现状：切分支自动重建走 **python hook**；手动重建走 zkz-code 命令（JS）；zkz-code 在 checkout 只同步宏（yt_version），**不重建 compile_commands**。两者不同时跑，但**逻辑重复、已开始漂移**（属"一个意图多份实现→天然分叉"）。
- python 路径还额外依赖：①`ZKZ_SCRIPTS` 发现（回退硬编码 `$HOME/Desktop/zkz/scripts`，与第 6 档 node 硬路径同款债）②装了 python ③`scripts/` 目录在。

### 7.1 方案 B：hook 不再调 python，改经第 6 档启动器调 zkz-code 的同一份 JS

> 相对"方案 A（纯扩展内在 checkout/激活时自建、彻底删 hook）"，**方案 B 保留"无编辑器（纯 CLI/其它客户端）切分支也能重建 compile_commands"的能力**，同时消除 python 双实现。代价：git-time 依赖 node + 第 6 档启动器（与 filter/hook_runner 一致）。选 B 的前提是确有"不开 Cursor/zkz-code 也要 compile_commands 立即刷新"的工作流（CI、纯 VSCode + clangd 等）。

要点：

1. **单一真相源**：`compile_commands.js` 作为唯一实现；`getcompile_commands.py` 退役（保留文件仅供 CI 兜底或直接删，见 7.4）。
2. **提供 CLI 入口**：新增 `zkz-code/src/cc_cli.js`（薄壳）：`require('./compile_commands').refreshCompileCommands(process.argv[2] || process.cwd(), { force: true, log: (m)=>process.stderr.write(m+'\n') })`，退出码透传（成功 0 / 失败非 0）。
   - 注意：`compile_commands.js:preferredLayout` 现依赖 `vscode.commands`（`zkz-keil.resolveLayout`），CLI 无 `vscode`。需把布局解析拆成"可无 vscode 运行"：CLI 路径直接用 `resolveKeilLayout(root)` 回退（等价于现 python 行为），仅编辑器内才尝试 `zkz-keil` 动态布局。即 `refreshCompileCommands` 增加 `{ noVscode: true }` 开关，CLI 传入。
3. **hook 改造**：把 post-checkout 第 29-30 行
   ```sh
   python "$ZKZ_SCRIPTS/lib/getcompile_commands.py" "$ROOT" || true
   ```
   改为经第 6 档启动器调 zkz-code 的 CLI（启动器需能定位 zkz-code：glob `zkz.zkz-code-*/src`）：
   ```sh
   "$(git rev-parse --show-toplevel)/.zkz/native/zkz-run.sh" --pkg zkz-code cc_cli.js "$ROOT" || true
   ```
   - 即第 6 档 `zkz-run.sh` 增加可选 `--pkg <扩展名前缀>` 参数：默认解析 `zkz.zkz-native-*`，`--pkg zkz-code` 时解析 `zkz.zkz-code-*`。这样一个启动器服务三包。
4. **归属**：该 hook 片段仍属"项目工程 hook"（非 zkz-native 的 `>>> zkz-native` 标记块），由谁安装/维护需明确——建议由 zkz-code 在激活时也用"标记块 + 自愈"方式管理它自己的 post-checkout 片段（对齐 zkz-native 的 `installHooks`），而不是散落在手写 hook 里。这样 python→JS 迁移与后续维护都可自愈。

### 7.2 具体改动清单

- `zkz-code`：新增 `src/cc_cli.js`；`compile_commands.js:refreshCompileCommands`/`preferredLayout` 支持 `noVscode` 无 vscode 运行；`package.json`/`package_zkz_code.py` 白名单加 `cc_cli.js`。
- `zkz-native`：第 6 档 `zkz-run.sh` 增加 `--pkg` 解析（默认 native），供 zkz-code 复用。
- hook：post-checkout 的 python 行替换为启动器调用；建议由 zkz-code 用标记块自管理该片段。
- 退役 `scripts/lib/getcompile_commands.py`（或保留并在顶部注释"已被 zkz-code cc_cli.js 取代，仅 CI 兜底"）。

### 7.3 验证

- `node extensions/zkz-code/src/cc_cli.js <repoRoot>` 直接跑通，生成的 `compile_commands.json` 与旧 python 输出**逐条等价**（可对老 python 结果做 diff 回归）。
- 无 vscode 环境（纯 `node`）下 CLI 不因 `require('vscode')` 崩（布局走 `resolveKeilLayout` 回退）。
- 装好后 CLI 切分支（关闭编辑器）→ compile_commands 仍自动刷新；编辑器内手动命令与 checkout 行为不回退。
- YTSwarm 缺失时返回 skip、不报错崩 hook（保持 `|| true` 语义）。

### 7.4 明确不做 / 注意

- 不在 CLI 路径强依赖 `vscode`（否则 hook 场景必崩）——`noVscode` 分支是硬约束。
- 若确认**没有**"无编辑器也要刷新"的工作流，则应优先选**方案 A**（纯扩展内触发、直接删 hook 与 python），比 B 更简单、无 git-time node 依赖；B 仅为保留该能力而付出的代价方案。
- 该档依赖第 6 档启动器先落地。

---

## 8. 第 8 档 — 刷新型 hook 改为扩展监测分支切换 + 提示（取代第 6/7 档大部分）

> 状态：**已完成**。已删 `post-checkout`/`post-merge`/`post-rewrite` 三个刷新型 hook；切分支由扩展监测 `.git/HEAD`（watcher + 聚焦 + 轮询、去抖），静默做 overlay / skip-worktree / 增量刷表。`pre-commit`/`pre-push` 保留。zkz-code：HEAD 变化后**静默自动刷新** `compile_commands`（失败才提示 + 过期徽章可点重试）。

### 8.0 为什么可行（前提已满足）

- **smudge 已对陈旧表免疫**：`filter_core.js:18/32-33` 的 `reconcileSmudgeKind(detectKind(blob), 表提示)`（第 4 档 4.2，已完成）——切分支后即使表未及时重建，检出侧也以 blob 实际编码为准，**不会写坏编码**。这拆掉了"延迟/等确认再刷新"的最大正确性风险。
- **漂移检测已有**：`status_bar.js:22`、`commands.js:57` 已有 `tableDrift`（表落后于 HEAD 判定）。"何时该刷新"的判断已在跑，只差把触发从 hook 换成扩展监测。

### 8.1 收益（正好消化第 6/7 档一堆债）

- 删掉三个刷新型 hook → **彻底没有硬编码 node/版本目录/python**（第 6 档那类雷、第 7 档 python 双实现一并消失）。
- 重活（建表、YTSwarm 生成 compile_commands）**移出 git 关键路径**，不再在 checkout 瞬间与 filter 抢并发。
- 提示式 → 无"切个分支卡半天跑 YTSwarm"的突袭。

### 8.2 必须守住的边界

- **`pre-commit`/`pre-push` 不能删**：它们是"挡住坏提交/推送"的正确性闸门，扩展**拦不住命令行 `git commit`/`git push`**，只有 hook 能。因此第 6 档启动器仍需服务这两个 hook（但只剩 2 个 hook，且不含刷新逻辑）。
- **关编辑器时从 CLI 切分支**：靠"激活时 `tableDrift` 兜底提示"覆盖（复用现有 drift 判定）。
- **其它客户端 checkout 仍会触发 git 自身 smudge**：正常（pkt-line 已修，smudge 对陈旧表免疫）。

### 8.3 检测机制

- 监听 `.git/HEAD`（+ `.git/refs`）的 `vscode.workspace.createFileSystemWatcher`；rebase/merge/reset 都改 HEAD，统一按 HEAD 变化触发。
- **注意**：VSCode/Cursor 默认可能不监视 `.git` 目录，需显式创建 watcher 并在 Windows 上实测确实触发；必要时叠加"窗口重新聚焦 + 定时"轮询 `rev-parse HEAD` 兜底。
- 去抖：HEAD 连续变化（如 rebase 过程中）合并为一次处理。

### 8.4 分档策略：别做成"每次切分支弹窗"

- **便宜且关正确性**（overlay 还原、skip-worktree、编码表增量重建）→ 检测到就**静默自动做**，仅失败时提示。
- **昂贵**（YTSwarm 生成 compile_commands）→ **已改为与刷表一样静默自动做**；失败才非模态提示 + 状态栏过期徽章可点重试。不弹模态。

### 8.5 具体改动清单

- `zkz-native`：
  - 新增 HEAD 监测模块（`observe.js` 或新 `head_watch.js`）：watcher + 去抖 + 激活兜底；检测到变化 → `applySkipWorktree` + `restoreOverlay` + `buildTable`（增量）静默执行（复用现有函数，均已并发安全）。
  - `hooks.js:HOOKS` 从 5 个缩减为 `['pre-commit','pre-push']`；`installHooks`/`uninstallHooks`/`verifyHooks` 相应调整；卸载/迁移时清理旧的三个刷新 hook 标记块。
  - `hook_runner.js` 仅保留 `pre-commit`/`pre-push`（`post-*` 分支可删）。
- `zkz-code`：
  - 监测到分支切换（复用 zkz-native 事件或自建 HEAD watcher）→ compile_commands 走"状态栏过期徽章 + 手动/提示刷新"；激活时若 `compile_commands.json` 缺失或落后则提示。
  - `preferredLayout` 无需再考虑 CLI/无 vscode 场景（不再有 hook 调用），第 7 档的 `cc_cli.js` / `noVscode` 分支**可不做**。
- 项目 hook：post-checkout 里非 zkz 的工程片段（CMSIS 还原等）若仍需要，保留为项目自管理；zkz 相关刷新片段移除。

### 8.6 与第 6/7 档的关系

- **第 7 档（compile_commands 方案 B）**：被本档取代——不再需要"hook→启动器→JS"与 `cc_cli.js`。仅当确有"无编辑器纯 CLI 也要 compile_commands 自动刷新"的硬需求时，才回退到第 7 档方案 B。
- **第 6 档**：post-* 三个 hook 直接消失（最优，连路径都没有）；启动器缩小到只服务 `pre-commit`/`pre-push`，其余内容仍有效。
- **依赖**：第 4 档 4.2（已完成）。可与第 5 档并行；第 6 档启动器仅剩 pre-commit/pre-push 部分需落地。

### 8.7 明确不做

- 不删 `pre-commit`/`pre-push`。
- 不做模态弹窗式强提示（用状态栏徽章 + 非模态）。
- 不因监测/刷新失败而阻塞用户（只提示，绝不挡 git）。

---

## 9. 第 9 档 — 三扩展性能优化（空闲开销 + 激活阻塞 + 重复解析）

> 状态：**已完成**（9.1–9.5）。9.6 按「不默认落地」未做：textconv 不引入常驻进程，Keil 日志仍 500ms 轮询。HEAD 检测改为读 `.git/HEAD`（空闲不再周期 spawn git），兜底轮询 30s；native 已装时 code 不再自建 watcher。native 激活校验链改到 `setImmediate`。宏表磁盘缓存用 mtime/size，折叠按文档版本复用解析，FFFD 扫编辑器文本。
>
> 定级依据：本档所有 file:line 均经当前磁盘源码核实（`extension.js`/`head_watch.js`/`git_exec.js`/`cc_stamp.js`/`macros.js`/`ifdef_fold.js`/`keil.js`）。

### 9.0 性能热点总览（按"常驻/高频"优先）

| 热点 | 位置 | 现状开销 | 级别 |
|---|---|---|---|
| **双 HEAD 轮询各 spawn git** | native `head_watch.js:9,54` + code `head_watch.js:8,48` | **每 4s 两个 `git rev-parse HEAD` 子进程**常驻（+每次窗口聚焦再各一次），空闲也在跑 | 🔴 高（常驻） |
| **native 激活链全同步 spawnSync** | `extension.js:42-54` | `verifyGitConfig`+`verifyHooks`+`applySkipWorktree`+`restoreOverlay`+`tableDrift` 全在 `activate()` 内同步串跑，阻塞扩展宿主启动 | 🔴 高（启动） |
| **宏表每次重算全文件哈希** | `macros.js:247-250,333-351` | 命中缓存也先 `macroTextHash` 逐字符 O(n) 扫全文 + 读并 hash `.clangd`；被徽章/折叠/命令高频调用 | 🟠 中（高频） |
| **同一文档折叠解析两遍** | `ifdef_fold.js:335-348,376-407` | `provideFoldingRanges` 与 `applyFoldsToEditor` 各 `collectPpBranches(全文)` 一次 | 🟠 中（高频） |
| **FFFD 每次开/存读全文件** | `status.js:481-499` | 每 open/save `fs.readFileSync` 整文件再扫 FFFD | 🟡 低-中 |
| **textconv 每文件冷启动 node** | `textconv.js:30` + `.git/config` textconv | `git diff` 多文件时每文件一个 node 进程（+`require iconv-lite`+读表） | 🟡 低（非空闲） |
| **Keil 日志 500ms 轮询 tail** | `keil.js:145` | 编译期间 `setInterval(500)` 反复 openSync/readSync/closeSync | 🟢 低（用户触发、长任务） |

### 9.1 【最高优先】消除双 HEAD 轮询的常驻 git 子进程

**问题**：native 与 code **各自**起一个 `startHeadWatch`，`POLL_MS=4000` 的 `setInterval` 每次 `fire('poll')` 都调用 `currentHead`/`gitHead` = `spawnSync('git', ['rev-parse','HEAD'])`（native `git_exec.js:60-64`、code `cc_stamp.js:9-19`）。结果：**空闲时每 4 秒有两个 git 进程被拉起**，外加两处 `onDidChangeWindowState` 聚焦时再各 spawn 一次。这是纯常驻浪费——两个扩展已各自挂了 `.git/HEAD`/`packed-refs`/`refs/**` 的 `createFileSystemWatcher`，poll 只是兜底。

**改法（两条，可组合）**：

1. **poll 变化检测不 spawn git，改读文件**：`fire('poll')` 的目的只是"检测 HEAD 是否变了"，不需要解析出完整 oid。改为读 `.git/HEAD`（`fs.readFileSync`，几十字节）：
   - 内容形如 `ref: refs/heads/xxx` → 再读 `.git/refs/heads/xxx`（不存在则查 `.git/packed-refs`）拿到指向的 oid；
   - 内容直接是 40 位 oid（detached）→ 即为当前值。
   与上次缓存值比较，变了才进 `onChange`（`onChange` 内部本就会 spawn 一次拿权威 HEAD，无需 poll 阶段 spawn）。**空闲期零 git 子进程。**
2. **拉长兜底轮询 + 去重**：既然 `HEAD`/`refs/**` 已有文件 watcher，poll 仅作 watcher 漏报兜底，间隔从 4s 放宽到 30s；聚焦触发保留但也走"读文件比较"而非 spawn。

**可选进一步（去重两个 watcher）**：native 已通过 `vscode.commands.executeCommand('zkz-code.onHeadChanged', …)`（`extension.js:73-79`）主动通知 code。可让 **code 在检测到 native 已装时不再自建 head_watch**（`status.js:605-610` 处），完全复用 native 的事件，彻底去掉第二套轮询/watcher。native 未装时 code 才自建。

**验证**：切分支/rebase/reset 仍触发刷新；空闲期用进程监视器确认无周期性 git 子进程；native 事件驱动 code 的路径不回退。

### 9.2 【高优先】native 激活链去同步阻塞

**问题**：`extension.js:activate` 内顺序同步执行 `verifyGitConfig`（可能 spawnSync 读写 `.git/config`+attributes）、`verifyHooks`、`applySkipWorktree`（spawnSync）、`overlaySeeded`+`restoreOverlay`、`tableDrift`（`git rev-parse`）——全部在 `activate()` 返回前跑完，**阻塞扩展宿主激活**。仅 `tableDrift` 命中后的 `refresh` 是异步（`:50`）。

**改法**：`activate` 内**先注册命令、建状态栏并立即返回**；把 `verifyGitConfig`/`verifyHooks`/`applySkipWorktree`/`restoreOverlay`/drift 判定挪到 `setImmediate`（或 `queueMicrotask` + `await`）里执行，状态栏先显示"初始化中"，完成后 `bar.refresh()`。保持现有 try/catch + `warnActivate` 失败反馈不变。

**注意**：这些步骤有先后依赖（verifyGitConfig 应在 applySkipWorktree 前），异步化时保持顺序即可；`setContext('zkzNative.enabled', …)`（`:82`）可在异步块末尾再置一次以反映真实安装态。

**验证**：Reload 后扩展宿主激活更快；`git status`/`add`/切分支冒烟正常；配置/hook 仍被正确校验安装（构造缺失 hook → 异步补装）。

### 9.3 【中优先】zkz-code 宏表加载去重复哈希

**问题**：`loadMacroTable`（`macros.js:333`）每次都：① `macroTextHash(text)` 逐字符扫全文（`:247-250`）② `loadClangdLayer` 读 `.clangd` 并再 hash（`:299-305`）③ 才比 key 命中缓存。徽章刷新（`refreshMacroBadge`）、`syncYtMacros`、`showMacros`、折叠（`loadMacroEnv`→每个 provider/apply）都走它，属高频。`getYtVersionText`/`getClangdText` 还每次线性扫 `workspace.textDocuments` 找匹配文档。

**改法**：

1. **从磁盘读时用 `(filePath, mtimeMs, size)` 做快速缓存键**，避免整文件 O(n) 哈希；仅当传入 `opts.text`（编辑器内容，无 mtime）时才 hash 文本。`.clangd` 同理用 mtime。
2. **保留内容 hash 作为二级校验**只在快速键变化时才算，或直接信任 mtime（编辑器保存/磁盘变更都会更新 mtime）。
3. `getYtVersionText`/`getClangdText` 扫开文档：命中当前活动编辑器优先，或缓存"路径→document"映射，减少每次 `for … textDocuments`。

**验证**：改宏后徽章/折叠仍及时更新（mtime 变化触发重解析）；`macroTextHash` 测试（若有）不回退；连续调用 `loadMacroTable` 命中缓存时不再重扫全文。

### 9.4 【中优先】折叠解析结果按文档版本缓存，供 provider 与 apply 共用

**问题**：一次折叠触发里，`provideFoldingRanges`（`ifdef_fold.js:335`）与 `applyFoldsToEditor`（`:376`）各自 `collectPpBranches(document.getText())` 全量解析同一文档一遍；宏未变时切换编辑器/重折还会反复解析。

**改法**：以 `(doc.uri, doc.version, 宏表 key)` 为键缓存 `collectPpBranches` 结果（`Map`，随 `onDidChangeTextDocument`/宏表失效清理）。`provideFoldingRanges` 与 `applyFoldsToEditor` 都先查缓存，命中直接复用分支数组。`resolveWorkspaceRoot()`（`:108`，每次 `findYtVersion` 做 fs.existsSync）结果也可短期缓存。

**验证**：折叠行为不变（同样只折 known-inactive、非 wrapper）；编辑文档使版本号变化 → 重解析；宏表变化（`onMacrosChanged`→`invalidateEnvCache`）清缓存。

### 9.5 【低-中】FFFD 扫描避免重复读全文件

**问题**：`activateFffd`（`status.js:481-501`）在每次 `onDidOpenTextDocument`/`onDidSaveTextDocument` 都 `fs.readFileSync(fp)` 读整个文件再 `countFffd`。文档已在编辑器里时，磁盘读是多余的。

**改法**：优先用已打开文档的 `doc.getText()`（内存）扫 FFFD，仅在需要原始字节判断时才读盘；对 open 事件加轻量去抖/按 `(path, mtime)` 跳过未变文件。保持 `shouldCheckFffd` 的目录跳过逻辑。

**验证**：中文乱码文件仍报 FFFD 诊断；纯净文件不误报；大文件打开不再明显卡。

### 9.6 【低，可选】textconv 冷启动与 Keil 日志轮询

- **textconv 每文件冷启动 node**（`textconv.js` + `.git/config` `diff.zkznative.textconv`）：`git diff` 涉及多文件时每文件一个 node 进程（含 `require('iconv-lite')` + `loadTable`）。**根治需常驻 daemon**（与第 6 档启动器/filter 生命周期冲突，成本高），**默认不做**；仅记录为已知项。轻量缓解：确认 `loadTable` 每进程只读一次表（现状已是，`enc_table.js:14-40` 有 mtime 缓存但跨进程无效）。
- **Keil 日志 500ms 轮询**（`keil.js:145` `setInterval(readTail,500)`，每次 openSync/readSync/closeSync）：编译是用户触发的长任务，500ms 开销可接受。可选改为持有一个只读 fd 持续 `read` 或 `fs.watch(logFile)` 事件驱动，减少反复 open/close。**低优先，可不做。**

### 9.7 实施顺序与验证

1. **9.1 双 HEAD 轮询**（一个 commit，收益最大、常驻开销直接归零）。
2. **9.2 native 激活异步化**（一个 commit，改善启动）。
3. **9.3 + 9.4 zkz-code 宏表/折叠缓存**（一个 commit 或两个，编辑器交互路径提速）。
4. **9.5 FFFD**（可选，一个 commit）。
5. 9.6 记录/可选，不默认落地。

每步后：`node extensions/zkz-native/test/run.js` + `node extensions/zkz-code/test/run.js` 全绿 + 三包打包成功 + Reload 冒烟（切分支、开/存 `.c`、折叠、`git status/add/diff`）。用进程监视器确认空闲期无周期 git 子进程。

### 9.8 明确不做

- 不为 textconv/filter 引入常驻 daemon（与 git filter 生命周期、第 6 档启动器策略冲突）。
- 不改 HEAD 变化的触发语义（仍覆盖切分支/rebase/merge/reset），只换更省的检测手段。
- 不动 `git()` 的 `maxBuffer: 64MB`（大仓 `cat-file --batch` 需要，见 `git_exec.js:19`）。
- 不改 filter 协议 / `required=true`（性能优化不触碰正确性护栏）。

---

## 10. 第 10 档 — keil-native 库 junction 的编码盲区（巡检告警，不改过滤边界）

> 状态：**已完成**。保留库不过滤 + junction。`lib_encoding.js` 在 `syncKeilTree`、`pre-commit`、`pre-push` 巡检被改库 `.c/.h`：HEAD 为 GBK 而当前为 UTF-8/UTF-8 BOM，或工作区含 U+FFFD，或 GBK 无法 cp936 往返，则写入 `.zkz/lib-encoding-warnings.json` 并告警，不改字节、不拦编译。`zkz.libEncodingStrict=true`（或 `ZKZ_LIB_ENCODING_STRICT=1`）时 pre-commit/pre-push 才拒绝。
>
> 决策：**保留"库不过滤 + junction"边界不变**（方案 C），只补一道针对**被修改库文件**的编码巡检 + 告警。已评估并**否决**"库也纳入过滤 + keil-native 存 clean 副本"（方案 A/B，理由见 10.2）。

### 10.1 盲区本质（为什么 junction 不背锅）

- keil-native 库目录是 junction 指回真源（`keil_tree.js:207-220`），Keil 经 junction 读到的就是工作区库文件**当前字节**，一字不差。
- 设计前提不是"库没被改过"，而是"**库不走过滤 ⇒ 工作区字节 == blob 字节 == 要给 Keil 编的字节**"。只要修改没改变文件编码，junction 直连恒正确。
- 出问题的唯一链路是**编码漂移**：某 GBK 库文件（含中文注释）在 UTF-8 编辑器里被打开并保存 → 被静默转成 UTF-8/写坏；因库 bypass filter，`clean` 不会修回（`filter_core.js:38` 对库 `return 原字节`）→ ① 提交时 blob 被污染成 UTF-8；② Keil 经 junction 也读到被污染字节 → 中文乱码，极端下 armcc 解码异常。**这不是 junction 造成的，但 junction 把漂移直接带进编译。**

### 10.2 为什么不采纳"库也过滤 + 存副本"（方案 A/B 否决记录）

"库过滤"与"keil-native 存副本"是**强绑定**的：一旦库走过滤，工作区库文件变 UTF-8，junction 会把 UTF-8 喂给 Keil（要 GBK）→ 必须改成 clean 副本、不能 junction。评估后否决全量/选择性过滤，主因：

- **性能撞 git 关键路径**：编码表要覆盖数千库文件（`buildTable` 的 `cat-file --batch`+`detectKind`）；**每次 checkout/切分支 git 会 smudge 整棵库树**；`status/add/diff` 全过 filter。与第 8/9 档"重活移出 git 关键路径、砍常驻开销"方向相反。
- **一次性 renormalize 腐蚀风险**：纳入过滤后首次 renormalize 按启发式 `detectKind` 重新解释并改写每个库 blob；某第三方文件编码判错（Latin-1 / 混合 / 已 UTF-8 带特殊字节）就可能**改坏库 blob**。当前"库原样不动"正是规避此风险。
- **往返 soft-fail 噪声 + diff churn + 磁盘翻倍**（junction→全量拷贝）。
- **成本收益不匹配**：真第三方库（HAL/FreeRTOS/DSP）多为纯 ASCII，盲区几乎不触发；为小概率的"含中文且被改"的库付全局代价不划算。

> 若将来确有"某含中文库目录会被频繁编辑"的硬需求，可再评估**选择性**把该目录移出 `DEFAULT_LIB_TOPS`、纳入过滤——但**必须先走 10.4 的强制干跑护栏**确认无误判再 renormalize。

### 10.3 方案 C：被修改库文件的编码巡检 + 告警（要做）

思路对齐第 4 档"静默损坏变响亮"：不改过滤边界，只让库的编码漂移**可见**。

1. **数据来源**：`syncKeilTree` 已用 `changedRels`（`keil_tree.js:130-133`，`git status --porcelain -z`）拿到改动路径；筛出 `isLibRel` 的 `.c/.h` 即"被修改的库文件"。
2. **巡检判定**（每个改动库文件）：
   - 取 HEAD blob（`cat-file`）与工作区字节，各跑 `detectKind`；**blob 为 `Gbk` 而工作区已变 `Utf8`/`Utf8Bom`** → 判定编码漂移（疑似被 UTF-8 编辑器改过）。
   - 工作区字节含 **U+FFFD（`EF BF BD`）** → 判定已损坏（复用 zkz-code `countFffd` 同款检测）。
   - 可选：对判为 `Gbk` 的库文件跑一次 `checkRoundtrip` 式回编 cp936 验证。
3. **告警出口**：命中写 `.zkz/lib-encoding-warnings.json`（含路径、blob kind、工作区 kind、FFFD 数、时间），状态栏标红 + 非模态通知；**不阻塞**（与 clean soft-fail 一致），只提示。
4. **触发时机**：① `syncKeilTree`（编烧前顺带扫，几乎零额外成本，已有 changedRels）；② 可选在 `pre-commit`/`pre-push` 加一段"改动库文件编码巡检"，默认告警、`strict` 时可拦（库现在完全不过 pre-commit 检查，这是补齐）。
5. **文档**：zkz-native README「限制」补一条——库文件不过滤、编码无兜底；要改库文件先确认编码，巡检会对疑似漂移告警。

### 10.4 强制护栏：任何"改写库编码"的动作前先干跑确认

- 巡检报告本身就是一次 **`detectKind` 干跑 + roundtrip 检查**，只报告、不改字节；人工看过再决定是否处理漂移文件（手工修编码 / 单独规整）。
- **升级红线**：若将来把某库目录纳入过滤（方案 B/A），**必须先对该目录全量跑 `detectKind` 干跑 + `checkRoundtrip` 报告，人工确认无误判**，再执行 renormalize。严禁直接 renormalize（防 10.2 的一次性腐蚀）。

### 10.5 实施顺序与验证

1. 新增库编码巡检函数（`enc_table.js`/`observe.js` 或新 `lib_encoding.js`）：输入改动库路径，输出漂移/FFFD 列表；写 `.zkz/lib-encoding-warnings.json`（走 `atomicWriteJson`）。
2. `syncKeilTree` 末尾调用巡检并 `emit` 摘要；状态栏 + 通知接线（复用 `status_bar.js`/`observe.js`）。
3. 可选：`hook_runner.js` 的 `pre-commit`/`pre-push` 加改动库文件巡检（默认告警）。
4. 验证：构造一个"原 GBK 库文件被存成 UTF-8/含 FFFD"的用例 → 巡检命中并落 sidecar + 告警；纯 ASCII 库改动不误报；`node extensions/zkz-native/test/run.js` 全绿；junction/过滤边界与现状一致（未改 `attributesBody`/`isLibRel`）。

### 10.6 明确不做

- 不把库纳入 clean/smudge 过滤、不动 `attributesBody` 的 `top/** -filter -diff`（`git_config.js:81`）。
- 不把 keil-native 库 junction 改成拷贝（保留零拷贝 + "改库立即编"）。
- 巡检**不阻塞** git/编译（默认告警；仅显式 strict 时 pre-commit 才拦）。
- 不对库做自动"改写编码"修复（仅报告，人工处理，见 10.4）。

---

## 阶段依赖与建议节奏（更新）

| 阶段 | 依赖 | 风险 | 收益 | 状态 |
|---|---|---|---|---|
| 第 1 档 清理 | 无 | 极低 | 中 | ✅ 已完成 |
| 第 2 档 去本机耦合 | 第 1 档 | 低-中 | 高 | ✅ 已完成 |
| 第 3 档 正确性加固 | 第 1 档 | 中 | 高 | ✅ 已完成 |
| 第 4 档 native 加固（修订版） | 第 2/3 档 | 低-中 | 高 | ✅ 已完成（0.0.10） |
| 第 5 档 并发竞态 + 握手根治 | 第 4 档 | 低-中 | 高（根治现场事故） | ✅ 已完成 |
| 第 6 档 hook/filter 去硬编码路径 | 第 2/4 档 | 低-中 | 高（跨客户端 + 抗升级） | ⏳ 待实施（缩为仅 pre-commit/pre-push，被第 8 档部分取代） |
| 第 7 档 compile_commands 收敛到 zkz-code（方案 B） | 第 6 档 | 中 | 中-高（消 python 双实现 + 去 ZKZ_SCRIPTS 硬路径） | ⏳ 备选（默认被第 8 档取代） |
| 第 8 档 刷新型 hook 改扩展监测 + 提示 | 第 4 档 | 中 | 高（去 hook 硬路径 + 移出 git 关键路径） | ✅ 已完成 |
| 第 9 档 三扩展性能优化 | 第 8 档 | 低-中 | 高（消常驻 git 轮询 + 去激活阻塞 + 减重复解析） | ✅ 已完成（9.6 未做） |
| 第 10 档 keil-native 库编码巡检告警 | 第 4 档 | 低 | 中（补库文件编码盲区，不改过滤边界） | ✅ 已完成 |
