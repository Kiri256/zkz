# zkz Keil

UV4 编译 / 重建、J-Link 烧录、Cortex-Debug 准备。不 `require` zkz-sandbox 源码。

从沙箱（`*U`）编：先 `zkz-sandbox.toGb`（`{ silent: true }`），再 UV4。命令不存在则打日志并继续编。已打开真源 时跳过 ToGb。

## 工程

| 机型 | 工程 | 烧录注意 |
| --- | --- | --- |
| F429 | `Project/MDK-ARM(uV4)` | 只擦应用扇区，不动 boot（`0x08000000`–`0x0800BFFF`） |
| H750 | 工作区名含 H750 且有 `uvprojx` | 核 QSPI hex；J-Link 6.98 + W25Q32 FLM |

调试准备：有 `zkz-sandbox.copyDebugAxf` 则拷 `.zkz/output.axf` 并写 `gdb_source_map.gdb`。命令不存在则跳过 map（写成空 stub，避免旧 substitute-path 被 gdb source），Prepare 成功，调试照常启动。拷贝命令在但执行失败（例如没有 axf）仍中止。

## 命令

| 命令 | 说明 |
| --- | --- |
| `zkz-keil.keilBuild` | 增量编译 |
| `zkz-keil.keilRebuild` | 重新编译 |
| `zkz-keil.keilFlash` | J-Link 烧录 |
| `zkz-keil.prepareCortexDebug` | 准备 axf / gdb map |

`launch.json` 的 `preLaunchTask`（`Keil Build`、`J-Link Flash`、`Prepare Cortex Debug` 等）由本包 TaskProvider 提供。工作区 `.vscode/tasks.json` 若还有同名 shell 任务会抢走名字，删掉即可。

本工具箱当前没有独立的 Keil 命令行烧录脚本，日常请使用本扩展提供的命令和任务。

调试用工程目录 `.zkz/gdb_source_map.gdb`，不写 `zkz/cache/gdb_maps`。
