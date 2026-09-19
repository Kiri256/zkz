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
| `zkz-native.status` | 状态栏摘要 |
| `zkz-native.syncKeilTree` | 把工作区 clean 到 `.zkz/keil-native/` |

启用要求工作区干净。本地配置写在 `.git/info/attributes` 和 `.git/config`，不进仓库。

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
