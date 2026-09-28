# zkz-native 重构计划

> 目标：在不改变对外行为的前提下，修掉已知 bug、删除死代码、消除重复逻辑，并让 enable/disable 对称且更快。
> 通信约定：所有说明中文；未获授权不 commit、不 force-push。

## 一、模块现状

zkz-native 用 git clean/smudge 过滤器，把仓库里的 GBK / UTF-8-BOM 源码在工作区呈现为 UTF-8，提交时写回原编码。当前 25 个源文件按职责分四层：

- 编码内核：`encoding.js`、`filter_core.js`、`pktline.js`、`filter_process.js`、`textconv.js`
- git 交互：`git_exec.js`、`git_status.js`、`git_config.js`、`hooks.js`、`hook_runner.js`、`precommit.js`
- 状态与表：`enc_table.js`、`bootstrap.js`、`observe.js`、`lib_encoding.js`、`paths.js`
- VS Code 层：`extension.js`、`commands.js`、`status_bar.js`、`head_watch.js`、`keil_tree.js`、`config_freeze.js`、`overlay.js`、`lock.js`

## 二、Bug 与隐患清单

| 编号 | 严重度 | 位置 | 问题 |
| --- | --- | --- | --- |
| B1 | 高 | `bootstrap.js` enable | `checkout-index -f -a` 是无效重活，也是启用慢的根源 |
| B2 | 高 | `config_freeze.js` | skip-worktree 一整套是死代码，`applySkipWorktree` 名不副实 |
| B3 | 中 | `bootstrap.js` | 三处几乎相同的「按 kind 扫表」循环 |
| B4 | 中 | `enc_table.js` `countByKind` | 把 `Gbk+crlf` 当成独立桶，且结果基本无人消费 |
| B5 | 低 | `hooks.js` `installOne` | 恒等替换 `replace(/\n/g, '\n')`，遗留笔误 |
| B6 | 低 | `git_config.js` `verifyGitConfig` | 每次校验多次调用 `nodeBin()`，最坏触发 `where.exe` |
| B7 | 低 | `git_config.js` `attributesBody` | 用全部配置库名而非磁盘实际存在的库目录，写入不存在的 `output.hex/**` |
| B8 | 低 | `enc_table.js` `loadMeta` | 与 `loadTable` 读同一文件两次，不走缓存 |
| B9 | 观察 | `git_status.js` `parseNameStatusZ` | 对 `-z` 输出用双重兜底假设，换 git 版本有风险 |
| B10 | 观察 | `filter_process.js` | 长驻进程启动时只 `loadTable` 一次，会话中途表更新读不到 |

### B1 detail — enable 的无效重活

```js
// bootstrap.js enable()
applySkipWorktree(repoRoot, { force: true });
git(repoRoot, ['checkout-index', '-f', '-a'], { allowFail: true }); // 空跑
resmudgeStale(repoRoot);                                            // 真正干活
git(repoRoot, ['add', '--renormalize', '.'], { allowFail: true });  // 全树跑 clean
```

刚装完过滤器时整棵树 stat 与 index 一致，`checkout-index -f -a` 会跳过所有文件、不触发 smudge，真正转换全靠随后的 `resmudgeStale`。这一行对整棵树空跑，纯粹拖慢启用。`add --renormalize .` 又对全树（含库）跑一遍 clean，只为算出 `unstable` 列表。这是我们已在 disable 侧修好问题的镜像，enable 侧没同步。

### B2 detail — skip-worktree 死代码

```js
// config_freeze.js
function applySkipWorktree(repoRoot) {
  const cfg = loadConfigPaths(repoRoot);
  if (!fs.existsSync(configPathsFile(repoRoot))) saveConfigPaths(repoRoot, { paths: cfg.paths });
  const files = clearSkipWorktree(repoRoot); // 只清除，从不设置
  return { files: files, failed: [], skipped: false };
}
```

`applySkipWorktree` 只调用 `clearSkipWorktree`，`{ force: true }` 参数被忽略；`skip-worktree-stamp.json` 全仓库只有 `unlinkSync`、从无写入。这套「配置冻结」机制已被 overlay 取代，残留脚手架散布在 `enable`/`refresh`/`silentRefresh`/`extension.activate` 四处调用。

## 三、重构计划（分阶段）

### 阶段 0：补测试基线
固化现有行为，避免重构回归。当前 60 个测试覆盖编码 / 握手 / 表 / keil-tree，缺 `enable` / `refresh` 的端到端。补：临时 git 仓 + 真实 filter，跑一次 `enable` 断言工作区变 UTF-8、`status` 干净；`disable` 侧已有两条端到端测试，enable 侧补齐。

### 阶段 1：抽出「工作区物化」单一模块（解决 B1、B3）
统一三件事：按 kind 列出目标文件、批量 `cat-file` 读 blob、按方向写字节 + `git add` 刷新 stat。

- 合并 `resmudgeStale`（扫表段）/ `listMappedRels` / `listEncodingMismatches` 为一个 `scanMapped(repoRoot, { kinds, needSmudge })`。
- `enable` 去掉 `checkout-index -f -a`，改为：`buildTable → installGitConfig/Hooks → resmudgeStale（in-process smudge 写 UTF-8）→ 仅对非库源码检测 unstable`。启用与关闭对称，都不再全树 checkout。
- `unstable` 检测改轻量：对 resmudge 写过的文件用 `hash-object --path` 与 index 比对，取代 `add --renormalize . + status + reset HEAD` 全树三连。

风险：中。`enable` 是核心路径，靠阶段 0 测试护航。收益：启用 / 刷新明显变快，三段重复逻辑归一。

### 阶段 2：删除 skip-worktree 死代码（解决 B2）
- 删 `config_freeze.js` 的 `applySkipWorktree` / `clearSkipWorktree` / `skipWorktreeStampPath` 依赖；`disable` 里的 `clearSkipWorktree` 一并移除。
- 移除 `paths.js` 的 `skipWorktreeStampPath` 导出与 `RUN_FILE_NAMES` 中的 `skip-worktree-stamp.json`。
- 删掉 `extension.activate`、`bootstrap.refresh`、`silentRefresh` 里对应调用。
- `config_freeze.js` 只剩 `loadConfigPaths` / `saveConfigPaths` / `isForbiddenStage` / `matchesPrefix`（precommit 与 overlay 仍用），可改名为 `config_paths.js`。

风险：低。这些调用当前无实际效果，删除是纯减负。已核对 precommit 与 overlay 只依赖保留的四个函数。

### 阶段 3：清理边角（B4–B8）
- `countByKind` 先 `parseMapped(v).kind` 再计数，合并 crlf 变体；若确认无人消费则删掉该字段。
- 删 `hooks.installOne` 的恒等 `replace`。
- `verifyGitConfig` 内 `nodeBin()` 求值一次复用。
- `attributesBody` 改用 `libTops`（磁盘实际存在）而非 `libTopNames`，去掉 `output.hex/**` 噪音；同步更新 `verifyGitConfig` 的 body 比较基准与相关测试。
- `loadMeta` 复用 `loadTable` 缓存，或让 `loadTable` 一次返回 `{ files, meta }`。

风险：低。B7 会改动 `.git/info/attributes` 文本，须同时更新 `verifyGitConfig` 比较逻辑与「library attributes cancel -text」测试，否则每次 activate 都会误判 stale 而重写。

### 阶段 4（可选）稳健性
- B9：给 `parseNameStatusZ` 增加针对 `-z` 真实输出的显式测试（M/A/D/R/C 各一），或改为只按 git 文档的 `-z` 语义解析、去掉双重兜底。
- B10：`filter_process` 在每次 `handleOne` 前用 `tablePath` 的 mtime 判断是否需要 `loadTable`（`enc_table` 已有 mtime 缓存，改动很小）。

## 四、执行顺序与验收

按 0 → 1 → 2 → 3 → 4。阶段 1、2 是主干（性能 + 删死代码），阶段 3 低风险清理，阶段 4 按需。

每阶段验收：
1. `node test/run.js` 全绿。
2. 在 `E:\work\b_01_zkz_2` 手测一轮 enable / disable，确认耗时和 `git status` 干净、无空修改。
3. 版本从 0.0.40 递增，重新打包 vsix 安装后生效（当前运行的仍是旧逻辑）。
