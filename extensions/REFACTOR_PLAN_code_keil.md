# zkz-code / zkz-keil 重构计划

> 目标：在不改变对外行为的前提下，修掉已知 bug、删死代码、消除重复逻辑、收敛跨扩展漂移的常量。
> 通信约定：所有说明中文；未获授权不 commit、不 force-push、不改打包版本号。
> 参照 `zkz-native/REFACTOR_PLAN.md` 的分阶段做法，先补测试基线再动主干。

---

## 一、模块现状

### zkz-code（独立的宏/索引/折叠/FFFD 辅助扩展）
11 个源文件，按职责分层：

- 宏内核：`macros.js`（.clangd -D + yt_version.h 全量宏表 + 发布 macro-table.json）、`pp_expr.js`（预处理表达式求值）、`macro_impact.js`（宏变更 → 检索引用文件 → 删 clangd .idx）
- 折叠：`ifdef_fold.js`（未激活 #if/#elif/#else 折叠，FoldingRangeProvider + 命令式折叠双机制）
- clangd / 编译库：`compile_commands.js`（从 Keil uvproj 生成 compile_commands.json）、`cc_stamp.js`（HEAD/戳记、判断 compile_commands 是否过期）、`head_watch.js`（无 native 时自行盯 HEAD）
- UI 与杂项：`extension.js`、`status.js`（状态栏主逻辑、宏同步、命令）、`status_bar.js`、`fffd.js`（U+FFFD 检测）、`encoding.js`、`util.js`、`lists.js`（workspace_lists 配置）、`pair.js`（解析工程根）

### zkz-keil（Keil UV4 编译 / J-Link 烧录 / 调试准备）
8 个源文件：

- 动作内核：`keil.js`（build/rebuild/flash/prepare 编排、UV4 spawn、日志解析、gdb map）、`keil_flash.js`（J-Link 脚本、Intel HEX 校验、H750 QSPI 设备 patch）
- 布局与配置：`keil_layout.js`（H750/F429 路径布局）、`keil_config.js`（读 vscode 配置）
- 集成：`keil_tasks.js`（TaskProvider + 伪终端）、`extension.js`、`status_bar.js`、`pair.js`

### 跨扩展共性
- `zkz-code/src/pair.js` 与 `zkz-keil/src/pair.js` 逐行相同。
- Keil 布局常量（H750 `H750/Projects/MDK-ARM/H750_N.uvprojx`、F429 `Project/MDK-ARM(uV4)/b_01.uvproj[x]`）在 `zkz-keil/keil_layout.js` 与 `zkz-code/compile_commands.js` 各存一份。
- 两个扩展都各自 bundle `iconv-lite` + `safer-buffer` 做 GBK 解码。

---

## 二、Bug 与隐患清单

### zkz-code

| 编号 | 严重度 | 位置 | 问题 |
| --- | --- | --- | --- |
| C1 | 中 | `macros.js` loadMacroTable 的调用方 | 徽章/菜单与折叠/同步用不同 root，单槽缓存来回失效，成对模式下宏值可能不一致 |
| C2 | 中 | `macro_impact.js` `invalidateIndexForMacroChanges` | `readYtVersionText` + `expandSearchMacroNames` 全文件多轮扫描被算两遍 |
| C3 | 低 | `pair.js` `resolvePairPreferred` | 导出但 zkz-code 内无人调用（只用 `resolvePair`），死导出且与 keil 版重复 |
| C4 | 低 | `fffd.js` | `countFffd`（字节版）、`isSkippedFffdTop`、`TEXT_EXT`/`SKIP_TOP` 均为死导出，运行时只用 `countFffdText` |
| C5 | 低 | `lists.js` / `macros.js` | `listsFilePath`/`LISTS_PATH` 死导出；`MACRO_KEYS` 在模块加载时一次性冻结，改配置需 reload 才生效 |
| C6 | 低 | `compile_commands.js` `resolveKeilLayout` | 与 keil 布局重复且会漂移：硬编码 target 名、不读 `zkz-keil.flavor`/`*.target` |
| C7 | 低 | `macros.js` `parseClangdCompileDefines` | 冗余判断 `/^\S/.test(raw) && !/^\s/.test(raw)` 两条件等价 |
| C8 | 观察 | `ifdef_fold.js` | Provider 折叠范围与命令式 `applyFoldsToEditor` 两套过滤 + setTimeout + 最多 4 次重试，竞态复杂 |

### zkz-keil

| 编号 | 严重度 | 位置 | 问题 |
| --- | --- | --- | --- |
| K1 | 中 | `keil_layout.js` / `keil.js` / zkz-code 副本 | Keil 布局常量三处重复，易漂移 |
| K2 | 低 | `keil.js` `nativeInstalledOnDisk` | 靠 `.git/info/attributes` 里 `filter=zkznative` 字符串探测，与 native 内部标记名硬耦合 |
| K3 | 低 | `keil.js` + `keil_tasks.js` | 命令模式走 OutputChannel、task 模式走伪终端，两条 emit 格式化路径重复 |
| K4 | 低 | `pair.js` | 与 zkz-code 逐行重复；`resolvePair` 只是 `resolvePairLocal` 的瘦包装 |
| K5 | 低 | `keil_flash.js` `installH750JLinkCustomDevice` | 全局 JLinkDevices.xml patch 靠硬编码字符串（`ST_STM32H745I_Disco_QSPI.elf`、400 字节窗口），J-Link/Keil 版本一变即 miss |
| K6 | 观察 | `test/run.js` | 仅覆盖 `parseIntelHex`，build/flash/layout/gdb-map 无测试 |

---

### 关键细节

#### C1 — loadMacroTable 的 root 不一致

`status.js` 同步与折叠路径显式传 `clangdRoot()`：

```286:290:extensions/zkz-code/src/status.js
    const table = loadMacroTable({
      workspaceRoot: clangdRoot(),
      text: (opts && opts.text != null) ? String(opts.text) : undefined,
      filePath: (opts && opts.filePath) || findWorkspaceYtVersion() || undefined
    });
```

但徽章/菜单只传 `filePath`，root 靠 `inferWorkspaceRoot(ver)` 推断：

```389:391:extensions/zkz-code/src/status.js
  try {
    const macros = loadMacroTable({ filePath: ver }).macros;
    alignYtMacroBaseline(macros);
```

`macros.js` 只有一个全局槽 `gTableCache`，key 里含 root 与 `clangdCacheKey(root)`。当 `clangdRoot()`（工作区文件夹[0]）与 `inferWorkspaceRoot(ver)`（含 ver 的文件夹或向上探测）在成对/Project 布局下不一致时：缓存 key 在两值间来回失效，每次 badge↔fold 切换都重新解析全量宏表；更糟的是两个 root 取到不同的 `.clangd -D` 层，徽章与折叠可能得到不同宏值。
修法：把 root 解析集中到一个 `resolveMacroRoot()`（badge/menu/sync/fold 共用同一实现），传给 `loadMacroTable`。

#### C2 — 宏影响面重复扫描

```307:309:extensions/zkz-code/src/macro_impact.js
  const ytText = readYtVersionText(workspaceRoot);
  const searchMacros = expandSearchMacroNames(seeds, ytText);
  const files = await findFilesReferencingMacros(workspaceRoot, seeds);
```

`findFilesReferencingMacros` 内部又跑一遍：

```225:226:extensions/zkz-code/src/macro_impact.js
  const ytText = readYtVersionText(workspaceRoot);
  const names = expandSearchMacroNames(macroNames, ytText);
```

`expandSearchMacroNames` 对整份 yt_version.h 做最多 4 轮正则扫描，这里被算两遍，而外层 `searchMacros` 仅用于日志/计数。
修法：让 `findFilesReferencingMacros` 接收已算好的 `names`（或返回 `{ files, searchMacros }`），`invalidateIndexForMacroChanges` 只算一次。

#### K1 — Keil 布局三处重复

同一组 H750/F429 常量分别写在 `zkz-keil/src/keil_layout.js`、`zkz-keil/src/keil.js`（`resolveBuildLayout` 在其上叠 keil-native 前缀）、`zkz-code/src/compile_commands.js`。zkz-code 已通过 `preferredLayout` 优先调用 `zkz-keil.resolveLayout` 命令，但**回退分支**仍是独立硬编码副本，且不带 flavor/target 配置，未装 keil 或命令不可用时会与 keil 真实布局分叉。
修法见阶段 3。

---

## 三、重构计划（分阶段）

### 阶段 0：补测试基线
固化现有行为，防止重构回归。

- zkz-code：现有测试覆盖 `pp_expr`、`cc_stamp`、`loadMacroTable` 缓存、`buildCompileCommands`、`countFffdText`。补：
  - `collectPpBranches`（`ifdef_fold`）对 if/ifdef/ifndef/elif/else/嵌套/unknown 各一条，锁住折叠语义。
  - `expandSearchMacroNames` 的派生（`MACHINE_VALUE` → `Machine_*`）与多轮 RHS 追踪各一条。
- zkz-keil：现有仅 `parseIntelHex`。补：
  - `resolveKeilLayout`/`discoverFlavor` 对 h750/f429/override 三分支（用临时目录造 uvprojx）。
  - `assertH750HexQspiOnly` 的拒绝/放行用例（内部 flash、无扩展地址、type 02）。
  - `summarizeBuild` 的退出码映射（keilCode 0/1/2/3 与「日志里有 error」）。

风险：低，纯新增。

### 阶段 1：统一 zkz-code 宏表 root（解决 C1）
- 新增 `resolveMacroRoot(filePath?)`，内部沿用 `clangdRoot()` 优先、再 `inferWorkspaceRoot`，全扩展唯一入口。
- `refreshMacroBadge` / `showMacros` / `macroMenuItems` / `syncYtMacros` / 折叠统一走它，`loadMacroTable` 始终拿到同一 root。
- 顺带确认 `gTableCache` 单槽在统一 root 后不再抖动。

风险：中。核心宏路径，靠阶段 0 折叠/宏测试护航。收益：消除重复解析与 badge/fold 宏值分叉。

### 阶段 2：宏影响面去重（解决 C2）
- `findFilesReferencingMacros(workspaceRoot, names)` 直接吃展开后的 `names`；把 `readYtVersionText` + `expandSearchMacroNames` 上提到 `invalidateIndexForMacroChanges` 只算一次。
- 或让 `invalidateIndexForMacroChanges` 返回 `{ files, searchMacros }`，`findFiles` 不再自算。

风险：低。收益：大工程下宏切换少扫一遍全树头文件。

### 阶段 3：收敛 Keil 布局与 pair 重复（解决 K1、K4、C6、C3）
- 抽 `keil_layout` 为「单一真源」：zkz-keil 内 `keil.js` 的 `resolveBuildLayout` 复用 `keil_layout.resolveKeilLayout` 再叠 keil-native 前缀（现已如此，确认无第二份常量）。
- zkz-code `compile_commands.js` 的 `resolveKeilLayout` 回退：保留（跨扩展无法共享模块），但**加注释标明它是 zkz-keil 未装时的降级副本**，并对齐字段（target 名改为与 keil 默认一致、去掉不用的 `relMap`）。可选：把两份布局常量提到各自包内一个 `keil_paths.js`，减少同包内散布。
- `pair.js`：两个扩展各自把 `resolvePair` 直接实现，删掉 `resolvePairLocal` 中转；zkz-code 删除未使用的 `resolvePairPreferred` 导出（K4/C3）。

风险：低。注意 zkz-code 与 zkz-keil 是独立 vsix，无法直接共享文件，只能各自内聚 + 注释同步责任。

### 阶段 4：清理死代码与边角（C3–C7、K2、K3）
- `fffd.js`：删死导出 `countFffd`（字节版）、`isSkippedFffdTop`、`TEXT_EXT`/`SKIP_TOP`；仅保留运行时用到的 `countFffdText` / `shouldCheckFffd` / `activate`。
- `lists.js`：删 `listsFilePath`、`LISTS_PATH` 死导出。`MACRO_KEYS` 改为每次 `loadMacroKeys()`（走 lists 的 mtime 缓存），使 workspace_lists.json 改动免 reload 生效；或明确文档化「需 reload」。
- `macros.js`：`parseClangdCompileDefines` 去掉冗余的 `/^\S/ && !/^\s/` 双判断（C7）。
- `keil.js`：`nativeInstalledOnDisk` 的 `filter=zkznative` 标记名抽成常量并加注释，标明与 zkz-native 的耦合点（K2）。
- `keil.js`/`keil_tasks.js`：把 emit 格式化（换行归一）收敛到一处 helper，命令模式与 task 模式共用（K3）。

风险：低。纯减负，删除前用 `grep` 复核无外部引用（已核对 C3/C4/C5 均无消费方）。

### 阶段 5（可选）稳健性与观察项
- C8：`ifdef_fold` 的 Provider 与命令式折叠合流——让命令式 `selectFoldTargets` 与 `branchesToFoldingRanges` 复用同一过滤函数，减少两套判定漂移；重试次数/延时提取为常量并加注释说明「等宏表就绪」。
- K5：`keil_flash.js` 的全局 JLinkDevices.xml patch 增加「已是目标 FLM 则跳过」的显式日志与版本探测；把硬编码匹配串（`ST_STM32H745I_Disco_QSPI.elf`、窗口 400）提为常量并注明来源 J-Link 版本。
- K6：为 build/flash 编排补最小烟测（mock UV4/JLink spawn，断言 args 与退出码映射）。

---

## 四、执行顺序与验收

按 0 → 1 → 2 → 3 → 4 →（5 按需）。阶段 1、2 是 zkz-code 主干（一致性 + 性能），阶段 3 收敛跨扩展漂移，阶段 4 低风险清理。

每阶段验收：
1. 两个扩展各自 `node test/run.js` 全绿。
2. 在真实工程手测一轮：
   - zkz-code：切分支后徽章/折叠宏值一致、宏变更弹窗只弹一次、「局部刷新索引」删 .idx 数量合理。
   - zkz-keil：build / rebuild / flash（H750 QSPI-only 校验生效）/ prepare 调试各跑一遍，日志与退出码正确。
3. 确认 `git status` 无意外改动。
4. 版本号与打包（zkz-code 当前 1.0.36、zkz-keil 当前 1.0.17）按需递增并重新打包 vsix，安装后验证生效——**改版本/打包需另行授权**。
