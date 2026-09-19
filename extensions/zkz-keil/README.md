# zkz Keil

UV4 编译 / 重建、J-Link 烧录、Cortex-Debug 准备。只开真源。

打开真源且已启用 `zkz-native`：先同步 `.zkz/keil-native/`（工作区 UTF-8 经 clean 落成仓库编码），再编编烧树工程，hex/axf 拷回真源 `Project`。未启用 native 时就地编真源。

## 工程

| 机型 | 工程 | 烧录注意 |
| --- | --- | --- |
| F429 | `Project/MDK-ARM(uV4)` | 只擦应用扇区，不动 boot（`0x08000000`–`0x0800BFFF`） |
| H750 | 工作区名含 H750 且有 `uvprojx` | 核 QSPI hex；J-Link 6.98 + W25Q32 FLM |

调试准备：优先 `zkz-native.copyDebugAxf`，否则本包把真源 `output.axf` 拷到 `.zkz/output.axf`，并写 `gdb_source_map.gdb`（编烧树 `substitute-path` 回真源）。没有 axf 则跳过 map，Prepare 仍成功。

## 命令

| 命令 | 说明 |
| --- | --- |
| `zkz-keil.keilBuild` | 增量编译 |
| `zkz-keil.keilRebuild` | 重新编译 |
| `zkz-keil.keilFlash` | J-Link 烧录 |
| `zkz-keil.prepareCortexDebug` | 准备 axf / gdb map |

`launch.json` 的 `preLaunchTask`（`Keil Build`、`J-Link Flash`、`Prepare Cortex Debug` 等）由本包 TaskProvider 提供。工作区 `.vscode/tasks.json` 若还有同名 shell 任务会抢走名字，删掉即可。

调试用工程目录 `.zkz/gdb_source_map.gdb`。
