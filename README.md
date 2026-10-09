# zkz 工具箱

面向 b_01 系列嵌入式项目的本地工具箱：用三个 VS Code/Cursor 扩展管理真源 UTF-8 工作区（`zkz-native`）、C/C++ 编辑体验和 Keil 工作流。

## 快速开始

按扩展单独打包：

```powershell
python .\extensions\package_zkz_code.py
python .\extensions\package_zkz_keil.py
python .\extensions\package_zkz_native.py
```

生成的 `.vsix` 在 `extensions/`。装到编辑器后执行 **Developer: Reload Window**。

## 文档导航

| 需要了解什么 | 文档 |
| --- | --- |
| 真源、`zkz-native`、编码和日常协作边界 | [`docs/workspace-model.md`](docs/workspace-model.md) |
| PowerShell/Python 工具的用途和参数 | [`docs/cli.md`](docs/cli.md) |
| F429 Boot、J-Link 和恢复顺序 | [`docs/f429-boot-jlink.md`](docs/f429-boot-jlink.md) |
| 扩展打包和扩展间调用 | [`extensions/README.md`](extensions/README.md) |
| 真源 UTF-8 过滤器、编烧树 | [`extensions/zkz-native/README.md`](extensions/zkz-native/README.md) |
| 宏表、`#if` 折叠、clangd、FFFD | [`extensions/zkz-code/README.md`](extensions/zkz-code/README.md) |
| Keil 编译、烧录和调试准备 | [`extensions/zkz-keil/README.md`](extensions/zkz-keil/README.md) |

## 工作区结构

```text
zkz/
├─ README.md
├─ docs/                         主题文档
├─ extensions/
│  ├─ zkz-native/                真源 clean/smudge、编码表、编烧树
│  ├─ zkz-code/                  宏表、#if 折叠、clangd、FFFD
│  └─ zkz-keil/                  UV4、J-Link、Cortex-Debug
├─ scripts/
│  ├─ do_nothing.js              launch.json 占位
│  ├─ clean_keil_project.py      清理真源 Project 本机垃圾
│  └─ lib/
│     └─ getcompile_commands.py  从 YTSwarm 生成 compile_commands
├─ project_paths.py               多项目路径解析辅助
├─ cache/                         本地缓存和测试记录
└─ .vscode/                       当前工具箱的编辑器设置
```

`node_modules/`、缓存、临时脚本和 `.vsix` 是构建或运行产物，不是日常文档入口。扩展源码以各包的 `src/` 为准。

## 三个扩展

| 包 | 命令前缀 | 职责 |
| --- | --- | --- |
| `zkz-native` | `zkz-native.*` | 真源 clean/smudge、编码表、编烧树 |
| `zkz-code` | `zkz-code.*` | `yt_version.h` 宏表、未激活 `#if` 折叠、clangd、U+FFFD 检查 |
| `zkz-keil` | `zkz-keil.*` | Keil UV4 编译/重建、J-Link 烧录、Cortex-Debug 准备 |

各包彼此独立，通过少量公开命令协作；运行时不依赖本目录的 Python 工具。

## 最重要的安全规则

- 打开真源并启用 `zkz-native`：工作区 UTF-8，提交写回仓库原编码；Keil 编 `.zkz/keil-native/`。
- 未启用 native 时不要当 UTF-8 写真源/Junction。
- F429 烧录不要使用 J-Link Commander 的整片 `erase`；Boot 不在应用 `output.hex` 中。

环境变量、脚本参数和编码约定见 [`docs/workspace-model.md`](docs/workspace-model.md) 与 [`docs/cli.md`](docs/cli.md)。
