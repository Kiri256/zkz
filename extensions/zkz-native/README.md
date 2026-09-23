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

编码表在本机 `.zkz/.workspace_source_encodings.json`（不进仓库），按路径决定每个文件怎么转。新文件默认按 UTF-8/ASCII 入库，不强转 GBK。

## 命令

| 命令 | 说明 |
| --- | --- |
| `zkz-native.enable` | 建表、装本地 filter/hook、`checkout` 成 UTF-8、renormalize 自检 |
| `zkz-native.disable` | 卸 filter，按仓库原编码重新检出 |
| `zkz-native.refreshTable` | 按 HEAD 刷新编码表；重命名/新增后应刷 |
| `zkz-native.checkRoundtrip` | 检查当前 GBK 文件能否无损编回 cp936 |
| `zkz-native.status` | 状态摘要（状态栏点击弹出命令列表） |
| `zkz-native.syncKeilTree` | 把工作区 clean 到 `.zkz/keil-native/` |
| `zkz-native.copyDebugAxf` | 把调试 axf 拷到 `.zkz/output.axf` |
| `zkz-native.saveConfigOverlay` | 把 `config_paths.json` 里列出的本机配置存成权威副本（切分支后提示是否还原） |
| `zkz-native.restoreConfigOverlay` | 立刻从权威副本还原上述全部路径；目录会先删除再写回，不留多余文件 |

`.zkz/config_paths.json` 的 `paths` 只给手动的 overlay 保存/还原用（旧的 `skipWorktree` / `overlay` / `forbidStage` 会合并进这份名单）。这些文件按普通 Git 路径显示在更改里，不再 skip-worktree，也不禁止暂存。`.zkz/` 内部文件不进 overlay。

`zkz-native.isEnabled` / `zkz-native.resolveRoot` 给其它扩展调用，不出现在命令面板。

启用要求工作区干净。本地配置写在 `.git/info/attributes` 和 `.git/config`，不进仓库。filter 为 `required=true`：起不来时 git 会失败，这是为了避免把错误编码写进仓库。

git hook 只保留 `pre-commit` / `pre-push`（挡坏提交/推送）。过滤器启用时，切分支后监测 `.git/HEAD`，弹出通知并刷新编码表，同时询问是否从权威副本还原本地配置。过滤器关闭后不再监视分支、不刷表、不提示还原，其它命令也不会执行，直到再次 Enable。不再走 `post-checkout` 等 hook。失败另有警告。已有的 skip-worktree 会在启用期间的启动时清掉。

过滤器异常时运行 **zkz-native.disable** 即可卸掉（只改 `.git/config` 与 attributes，不依赖 filter 进程）。

往返失败会记入 `.zkz/roundtrip-failures.json` 并在状态栏标出。`pre-commit` / `pre-push` 会拦编码不对的 blob。握手被拒时写 `.zkz/handshake-reject.json`（含首包 hex）。

`ZKZ_NATIVE_LOG=1` 时写 `.zkz/zkz-native.log`。

## 编烧 / 调试

`zkz-keil` 在真源且 native 已启用时：

1. 同步编烧树（未改文件可跳过，改过的走 clean）
2. 编 `.zkz/keil-native` 下的工程
3. 把 hex/axf 拷回真源 `Project` 产物路径
4. gdb map 用 `substitute-path 编烧树 → 真源`

库目录在编烧树里是 junction，axf 里若已是真源路径则不要误 substitute。

## 限制

- 换机器 / CI 没装本地 filter 时，检出的是原始 GBK，通常无所谓。
- 非 `.c/.h`（如 `.uvproj`）保持原字节，工具可能乱码。
- VS Code 内置内联 diff 左侧对 GBK blob 仍可能乱码；CLI `git diff` 有 textconv。
- 重命名 GBK 文件后必须先刷新编码表，否则会按新文件写成 UTF-8。
- 库目录不过滤，编码没有 clean 兜底；编烧树里仍是 junction。改过的库 `.c/.h` 会在同步编烧树、提交和推送时巡检：HEAD 为 GBK 而当前变成 UTF-8，或出现 U+FFFD，会写入 `.zkz/lib-encoding-warnings.json` 并告警，不改文件、不拦编译。要提交时拦住，设 `git config --local zkz.libEncodingStrict true`。
