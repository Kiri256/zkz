# 命令行工具

所有命令从工具箱根目录 `zkz` 执行。PowerShell 示例适用于 Windows PowerShell 5.1 及更新版本。日常编译、烧录用扩展。

## `getcompile_commands.py`

在真源工程中调用 YTSwarm，生成并规范化 `compile_commands.json`：

```powershell
python .\scripts\getcompile_commands.py E:\work\b_01_zkz_1
```

不传项目路径时，脚本会尝试通过 `project_paths.py`、`B01_PROJECT_ROOT`、Git 根目录或当前目录向上查找项目。F429 使用 `Project/MDK-ARM(uV4)`；H750 使用带 H750 工程布局。

要求目标工程中存在对应的 `YTSwarm.exe` 和 Keil 工程文件。生成后写入真源 MDK 目录与根目录。

## `clean_keil_project.py`

清理真源 `Project/MDK-ARM(uV4)`（以及 H750 对应目录）里的本机垃圾：Keil 界面残留、`Flash/Obj` 中间文件、`Flash/List`、J-Link/编译日志、`.cache`。

不删 `uvproj`/`uvopt`、`output.sct`、`output.hex`/`output.axf`、`YTSwarm.exe`、`compile_commands.json`。不碰 `.zkz/keil-native`。

```powershell
python .\scripts\clean_keil_project.py E:\work\b_01_zkz_1
python .\scripts\clean_keil_project.py E:\work\b_01_zkz_1 --dry-run
```

不传路径时，按 `project_paths.py` / `B01_PROJECT_ROOT` / 当前 Git 根解析工程。

## 工具箱环境变量

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `B01_PROJECT_ROOT` | 未设置 | 为路径解析工具指定项目根目录 |

J-Link、Keil 和 H750 FLM 的环境变量属于 `zkz-keil` 所服务的具体项目，见 [`f429-boot-jlink.md`](f429-boot-jlink.md)。
