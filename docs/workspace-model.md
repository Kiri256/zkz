# 工作区模型

## 真源与沙箱

每个项目通常有一对目录：

| 目录 | 常见特征 | 编码 | 用途 |
| --- | --- | --- | --- |
| 真源 | 原项目目录或带 `_1` 的副本 | GBK/GB2312 | Git、正式提交、Keil 工具链 |
| 沙箱 | 真源路径后缀为 `*U` | UTF-8 | Cursor/VS Code 编辑、宏折叠、clangd |

`zkz-sandbox` 在沙箱打开时解析这对目录，并把沙箱作为编辑和同步入口。真源工作区主要用于提交和编译结果落盘。

## 推荐流程

1. 打开 `*U` 沙箱，在其中修改代码。
2. 使用 `zkz-code` 检查宏表、`#if` 折叠和 U+FFFD。
3. 使用 `zkz-keil.keilBuild` 或任务面板编译。沙箱编译会先调用 `zkz-sandbox.toGb`。
4. 在 `zkz-sandbox` 的真源 Git 视图中检查、暂存和提交。
5. 需要调试时运行 `Prepare Cortex Debug`，再启动调试。

直接打开真源编译时会跳过 `ToGb`，避免把沙箱内容覆盖到真源。

## 同步边界

常用命令：

| 命令 | 方向 | 适用场景 |
| --- | --- | --- |
| `zkz-sandbox.toUtf` | 真源 → 沙箱 | 获取真源变更，使用 stamp 差异 |
| `zkz-sandbox.toGb` | 沙箱 → 真源 | 编译前回写真源 |
| `zkz-sandbox.toUtfAll` / `toGbAll` | 对应方向 | 不预过滤，做全文核对 |
| `zkz-sandbox.toUtfLibs` / `toGbLibs` | 对应方向 | 只处理库目录 |
| `zkz-sandbox.toUtfFull` | 真源 → 沙箱 | 清空后重新生成沙箱 |
| `zkz-sandbox.diffSandboxW1` | 对比 | 查看当前文件的真源/沙箱差异 |

这些命令只应在沙箱工作区使用。同步规则来自沙箱 `.zkz/sync.jsonc` 和 `.zkz/workspace_lists.json`；修改列表文件不需要重装扩展。

## 编码规则

| 范围 | 编码 |
| --- | --- |
| 本工具箱文档、脚本、`*U` 业务文件 | UTF-8 |
| 真源中文业务源码 | GBK/GB2312 |
| PowerShell 控制台 | 通过 `init_terminal_utf8.ps1` 设置为 UTF-8 |

不要用默认编码不明确的编辑器批量改写 `User/`、`core/` 等真源目录。使用 `source_rw.py` 的 `read`、`write` 或 `replace-str`，它会按文件编码读写并报告 U+FFFD。

## 编译与扩展边界

- `zkz-code` 不依赖 `zkz-sandbox`，打开 `.c/.cpp` 时只应用已有宏表，不会每次重新解析。
- `zkz-keil` 不直接依赖 Git 源码；如果存在 `zkz-sandbox.toGb`，沙箱编译前调用它。
- `zkz-keil.prepareCortexDebug` 会尝试通过 `zkz-sandbox.copyDebugAxf` 准备 `.zkz/output.axf` 和 `gdb_source_map.gdb`。
- 扩展安装脚本只按白名单打包各包 `src/`；新增源码文件后必须同步更新 `extensions/install_zkz_extensions.ps1`。
