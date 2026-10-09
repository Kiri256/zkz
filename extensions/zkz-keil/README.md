# zkz Keil

UV4 编译 / 重建、J-Link 烧录、Cortex-Debug 准备。只开真源。

打开真源且已启用 `zkz-native`：先同步 `.zkz/keil-native/`（工作区 UTF-8 经 clean 落成仓库编码），再编编烧树工程，hex/axf 拷回真源 `Project`。未启用 native 时就地编真源。

## 工程

| 机型 | 工程 | 烧录注意 |
| --- | --- | --- |
| F429 | `Project/MDK-ARM(uV4)` | 只擦应用扇区，不动 boot（`0x08000000`–`0x0800BFFF`） |
| H750 | `.zkz/settings.json` 里 `keil.flavor` 为 `h750` 时用 `H750/Projects/MDK-ARM/H750_N.uvprojx` | 核 QSPI hex；J-Link + W25Q32 FLM |

UV4 / J-Link / FLM / 设备名 / 速度 / QSPI 窗口写在 `.zkz/settings.json` 的 `keil`（空则环境变量，再试常见安装路径）。

调试准备：按当前机型把真源 `output.axf` 拷到 `.zkz/output.axf`，并写 `gdb_source_map.gdb`（过滤器启用时 `substitute-path` 从编烧树指回真源）。没有 axf 则跳过 map，Prepare 仍成功。

`launch.json` 的 `serverpath` 写 `${command:zkz-keil.jlinkGdbServerPath}`。启动调试时按 `keil.flavor` 取 GDB Server：F429 用 `f429.jlinkPath`（空则 `ZKZ_JLINK_502`，再试 `JLink_V502c`）同目录的 `JLinkGDBServerCL.exe`；H750 用 `h750.jlinkPath`（空则 `ZKZ_JLINK_698`，再试 `SEGGER\JLink`）。路径本身若已是 `JLinkGDBServer*.exe` 则直接用。

## 命令

| 命令 | 说明 |
| --- | --- |
| `zkz-keil.keilBuild` | 增量编译 |
| `zkz-keil.keilRebuild` | 重新编译 |
| `zkz-keil.keilFlash` | J-Link 烧录 |
| `zkz-keil.prepareCortexDebug` | 准备 axf / gdb map |
| `zkz-keil.configureLaunch` | 按当前机型写 `.vscode/launch.json` |

打开真源工程时，状态栏有 `zkz-keil`，点击弹出上述命令。

`配置调试` 写入「编译调试」和「调试」两条。`device`、`svdFile`、`gdbPath`、调试速度取当前机型：`keil.f429` / `keil.h750` 的 `device` 与 `svdFile`，`keil.gdbPath`（空则 `ZKZ_ARM_GDB`，再试 `D:\ruanjian\arm-gnu-toolchain-*\bin\arm-none-eabi-gdb.exe`），速度是 `keil.debugSpeedKHz`（默认 4000）。SVD 为空时会在 Keil Pack 里找 `STM32F429x.svd` 或 `STM32H750x.svd`。同名配置会覆盖，其它配置保留。换机型后需要再执行一次。`serverpath` 仍在每次调试时按机型解析。

`zkz-keil.resolveLayout` 返回当前工程布局，不出现在命令面板。`zkz-code` 使用同一布局模块，不调用此命令。

`launch.json` 的 `preLaunchTask`（`Keil Build`、`J-Link Flash`、`Prepare Cortex Debug` 等）由本包 TaskProvider 提供。工作区 `.vscode/tasks.json` 若还有同名 shell 任务会抢走名字，删掉即可。

调试用工程目录 `.zkz/gdb_source_map.gdb`。
