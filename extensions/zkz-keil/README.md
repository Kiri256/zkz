# zkz Keil

UV4 编译 / 重建、J-Link 烧录、Cortex-Debug 准备。只开真源。

打开真源且已启用 `zkz-native`：先同步 `.zkz/keil-native/`（工作区 UTF-8 经 clean 落成仓库编码），再编编烧树工程，hex/axf 拷回真源 `Project`。未启用 native 时就地编真源。

## 工程

| 机型 | 工程 | 烧录注意 |
| --- | --- | --- |
| F429 | `Project/MDK-ARM(uV4)` | 只擦应用扇区，不动 boot（`0x08000000`–`0x0800BFFF`） |
| H750 | `.zkz/settings.json` 里 `keil.flavor` 为 `h750` 时用 `H750/Projects/MDK-ARM/H750_N.uvprojx` | 核 QSPI hex；J-Link + W25Q32 FLM |

UV4 / J-Link / FLM / GDB / SVD / 设备名 / 速度 / QSPI 窗口的默认值在 `extensions/shared/zkz_settings.js`。工作区第一次生成 `.zkz/settings.json` 时写入 `keil`。之后只读工作区文件，路径为空就报错。

调试准备：按当前机型把真源 `output.axf` 拷到 `.zkz/output.axf`，并写 `gdb_source_map.gdb`（过滤器启用时 `substitute-path` 从编烧树指回真源）。没有 axf 则跳过 map，Prepare 仍成功。

`launch.json` 的 `serverpath` 写 `${command:zkz-keil.jlinkGdbServerPath}`。启动调试时按 `keil.flavor` 读取当前机型的 `jlinkGdbServerPath`。该项为空时，用同机型 `jlinkPath` 旁边的 `JLinkGDBServerCL.exe`；`jlinkPath` 本身若已是 `JLinkGDBServer*.exe` 则直接用。

## 命令

| 命令 | 说明 |
| --- | --- |
| `zkz-keil.keilBuild` | 增量编译 |
| `zkz-keil.keilRebuild` | 重新编译 |
| `zkz-keil.keilFlash` | J-Link 烧录 |
| `zkz-keil.prepareCortexDebug` | 准备 axf / gdb map |
| `zkz-keil.configureLaunch` | 配置调试，仅写入 `.vscode/launch.json` |

打开真源工程时，状态栏有 `zkz-keil`，点击弹出上述命令。

`配置调试` 写入「编译调试」和「调试」两条。`device`、`svdFile`、`serverpath`、`gdbPath` 使用命令变量，在启动调试时从 `.zkz/settings.json` 读取；`device` 与 `svdFile` 按当前 `keil.flavor` 选择，`gdbPath` 用 `keil.gdbPath`。调试速度在生成时写入，取 `keil.debugSpeedKHz`（默认 4000）。`svdFile` 为空时，只在 `keil.packRoot` 下找 `STM32F429x.svd` / `STM32F429.svd` 或 `STM32H750.svd` / `STM32H750x.svd`。切换机型后无需重新生成 `launch.json`。

路径写在 `.zkz/settings.json`：`keil.uv4Path`、`keil.gdbPath`、`keil.packRoot`，以及当前机型的 `jlinkPath`、`jlinkGdbServerPath`、`svdFile`（H750 另有 `flmPath`）。执行 `zkz-keil.configureLaunch` 只生成或更新 `launch.json`，不会写入设置文件。

`zkz-keil.resolveLayout` 返回当前工程布局，不出现在命令面板。`zkz-code` 使用同一布局模块，不调用此命令。

`launch.json` 的 `preLaunchTask`（`Keil Build`、`J-Link Flash`、`Prepare Cortex Debug` 等）由本包 TaskProvider 提供。工作区 `.vscode/tasks.json` 若还有同名 shell 任务会抢走名字，删掉即可。

调试用工程目录 `.zkz/gdb_source_map.gdb`。
