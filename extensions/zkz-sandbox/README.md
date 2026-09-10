# zkz Sandbox（zkz-sandbox）

真源 Git 侧栏、状态栏、以及 真源 ↔ UTF-8 沙箱同步。命令使用 `zkz-sandbox.*`。

不包含宏折叠（`zkz-code`）和 Keil（`zkz-keil`）。签出时可选调用 `zkz-code.*`（宏基线），没装就跳过。

## 状态栏

| 项 | 作用 |
| --- | --- |
| 分支 | 本源当前分支、脏/*、超前/落后；点击 `pickBranch` |
| 同步 | `LibsOK` / `LibsSEED` / `ToGb?` / `ToUtf?` / `SYNC...`；黄底表示该同步。点击打开同步菜单 |

刷新：Git 操作、保存沙箱业务文件、窗口获焦（30s）、本源 `vscode.git` 状态变化。约 250ms 合并。真源工作区只显示状态，不打开同步菜单。

## 同步

| 命令 | 说明 |
| --- | --- |
| `zkz-sandbox.toUtf` | 真源 → 沙箱（stamp） |
| `zkz-sandbox.toGb` | 沙箱 → 真源（stamp）。`{ silent: true }` 不弹完成提示，失败仍抛 |
| `zkz-sandbox.copyDebugAxf` | 拷真源 `output.axf` → 两边 `.zkz/output.axf`（实体文件）。keil 调试准备调用；命令不存在则跳过 gdb map 并继续调试 |
| `zkz-sandbox.toUtfAll` / `toGbAll` | 不预过滤 / 全文核对 |
| `zkz-sandbox.toUtfLibs` / `toGbLibs` | 仅库 |
| `zkz-sandbox.toUtfFull` | 清空后全量 |
| `zkz-sandbox.syncMenu` | 分类菜单（含仪表盘、reset 沙箱） |
| `zkz-sandbox.syncFrom` / `pullSandbox` | 同 ToGb / ToUtf |

上述命令仅在打开 `*U` 沙箱时可用（菜单、命令面板、快捷键均禁用）。打开真源时运行会提示改到沙箱。

`.zkz/sync.jsonc`：`syncAll` 日常含库仍走 stamp；`verifyAll` 则 ToGb 全文核对。

`.zkz/workspace_lists.json`（也可 `.jsonc`）：同步跳过目录/库目录/转码后缀等。只读沙箱此文件（mtime 变了就重读，不读真源）；没有时若沙箱已有 `.zkz/` 会从扩展模板拷一份出去。改这个文件不用重装扩展。

## 对比

| 命令 | 快捷键 |
| --- | --- |
| `zkz-sandbox.diffSandboxW1` | Ctrl+Alt+D |
| `zkz-sandbox.diffSandboxW1Batch` | Ctrl+Alt+Shift+D |

## Context

| 键 | 含义 |
| --- | --- |
| `zkzSandbox.paired` | 已解析真源↔沙箱 |
| `zkzSandbox.gitManage` | 打开的是沙箱，允许管本源 Git |
| `zkzSandbox.sandbox` | 当前是 `*U` |
| `zkzSandbox.syncing` | 同步中，禁用部分 Git 写 |

打开 `*U` 沙箱才能执行同步/对比；打开真源时命令与菜单禁用（Keil 编烧仍可从沙箱调 `toGb`）。侧栏 Git 管理同样以沙箱为主。

## 安装

见 [`../README.md`](../README.md)。改源后必须把新文件列入 `install_zkz_extensions.ps1` 的 `$sandboxFiles`。
