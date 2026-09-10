# zkz 工具箱

面向 b_01 系列嵌入式项目的本地工具箱：用三个 VS Code/Cursor 扩展管理真源 Git、UTF-8 沙箱、C/C++ 编辑体验和 Keil 工作流。

## 快速开始

在 PowerShell 中进入本目录，构建并安装三个扩展：

```powershell
powershell -ExecutionPolicy Bypass -File .\extensions\install_zkz_extensions.ps1
```

脚本默认同时安装到 Cursor 和 VS Code。只构建 `.vsix`、不安装到编辑器：

```powershell
$env:ZKZ_INSTALL = '0'
powershell -ExecutionPolicy Bypass -File .\extensions\install_zkz_extensions.ps1
```

安装完成后，在编辑器中执行 **Developer: Reload Window**。

## 文档导航

| 需要了解什么 | 文档 |
| --- | --- |
| 真源、`*U` 沙箱、编码和日常协作边界 | [`docs/workspace-model.md`](docs/workspace-model.md) |
| PowerShell/Python 工具的用途和参数 | [`docs/cli.md`](docs/cli.md) |
| F429 Boot、J-Link 和恢复顺序 | [`docs/f429-boot-jlink.md`](docs/f429-boot-jlink.md) |
| 扩展安装、打包和扩展间调用 | [`extensions/README.md`](extensions/README.md) |
| Git、同步、对比 | [`extensions/zkz-sandbox/README.md`](extensions/zkz-sandbox/README.md) |
| 宏表、`#if` 折叠、clangd、FFFD | [`extensions/zkz-code/README.md`](extensions/zkz-code/README.md) |
| Keil 编译、烧录和调试准备 | [`extensions/zkz-keil/README.md`](extensions/zkz-keil/README.md) |

## 工作区结构

```text
zkz/
├─ README.md
├─ docs/                         主题文档
├─ extensions/
│  ├─ install_zkz_extensions.ps1
│  ├─ zkz-sandbox/               真源 Git、同步、对比
│  ├─ zkz-code/                  宏表、#if 折叠、clangd、FFFD
│  └─ zkz-keil/                  UV4、J-Link、Cortex-Debug
├─ scripts/
│  ├─ run_ps.ps1                 PowerShell 统一入口
│  ├─ init_terminal_utf8.ps1     UTF-8 终端初始化
│  ├─ source_rw.py               按编码读写源文件
│  └─ getcompile_commands.py     从 YTSwarm 生成 compile_commands
├─ project_paths.py               多项目路径解析辅助
├─ cache/                         本地缓存和测试记录
└─ .vscode/                       当前工具箱的编辑器设置
```

`node_modules/`、缓存、临时脚本和 `.vsix` 是构建或运行产物，不是日常文档入口。扩展源码以各包的 `src/` 为准。

## 三个扩展

| 包 | 命令前缀 | 职责 |
| --- | --- | --- |
| `zkz-sandbox` | `zkz-sandbox.*` | 真源 Git 侧栏、状态栏、真源 ↔ `*U` 同步、差异和仪表盘 |
| `zkz-code` | `zkz-code.*` | `yt_version.h` 宏表、未激活 `#if` 折叠、clangd、U+FFFD 检查 |
| `zkz-keil` | `zkz-keil.*` | Keil UV4 编译/重建、J-Link 烧录、Cortex-Debug 准备 |

三个包彼此独立，通过少量公开命令协作；运行时不依赖本目录的 Python 工具。

## 最重要的安全规则

- 在 `*U` 沙箱中编辑 UTF-8 文件；真源通常是 GBK/936。
- 从沙箱编译前由 `zkz-keil` 回写真源；真源打开时不会自动回写。
- F429 烧录不要使用 J-Link Commander 的整片 `erase`；Boot 不在应用 `output.hex` 中。
- 含中文的真源文件使用 [`scripts/source_rw.py`](scripts/source_rw.py) 读写，完成后检查 U+FFFD。

环境变量、脚本参数和编码约定见 [`docs/workspace-model.md`](docs/workspace-model.md) 与 [`docs/cli.md`](docs/cli.md)。
