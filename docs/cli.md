# 命令行工具

所有命令从工具箱根目录 `zkz` 执行。PowerShell 示例适用于 Windows PowerShell 5.1 及更新版本。

## `init_terminal_utf8.ps1`

初始化当前 PowerShell 会话的 UTF-8 输入、输出和 Python 环境变量：

```powershell
.\scripts\init_terminal_utf8.ps1
```

它设置代码页 65001、`Console` 编解码、`$OutputEncoding`、`PYTHONIOENCODING` 和 `PYTHONUTF8`。编辑器终端配置已经会自动调用它时，不需要重复执行。

## `run_ps.ps1`

统一调用另一个 PowerShell 脚本，并先初始化 UTF-8 控制台：

```powershell
.\scripts\run_ps.ps1 .\some-script.ps1 -Force
.\scripts\run_ps.ps1 .\some-script.ps1 -ProjectRoot 'E:\work\b_01_zkz_1'
```

脚本参数必须写在目标脚本之后。带值参数会转换为命名参数，开关参数（如 `-Force`）会转换为 `$true`。当前目录中没有额外的日常 PowerShell 业务脚本；扩展功能请使用编辑器命令。

## `source_rw.py`

用于需要明确区分 UTF-8 和 GBK 的源文件读写：

```powershell
python .\scripts\source_rw.py detect E:\work\b_01_zkz_1\User\main.c
python .\scripts\source_rw.py read E:\work\b_01_zkz_1\User\main.c --start 1 --lines 80
python .\scripts\source_rw.py replace-str E:\work\b_01_zkz_1\User\main.c `
  --old-str '旧文本' --new-str '新文本'
python .\scripts\source_rw.py check-fffd E:\work\b_01_zkz_1\User\main.c
```

支持的子命令：

| 子命令 | 作用 |
| --- | --- |
| `detect` | 检测编码、重解析路径和 U+FFFD |
| `read` | 按检测到的编码读取并以 UTF-8 输出 |
| `write` | 从 UTF-8 文件或 stdin 写回原文件编码 |
| `replace-str` | 直接按字符串替换，避免临时文件 |
| `replace-stdin` | 从 stdin 接收 `---OLD---` / `---NEW---` |
| `replace` | 使用两个 UTF-8 文件进行替换，旧接口 |
| `check-fffd` | 检查替换字符 U+FFFD |

检测默认为 `auto`。需要覆盖检测结果时，在子命令前传 `--encoding utf-8`、`--encoding gbk` 或 `--encoding utf-8-sig`。

## `getcompile_commands.py`

在真源工程中调用 YTSwarm，生成并规范化 `compile_commands.json`：

```powershell
python .\scripts\getcompile_commands.py E:\work\b_01_zkz_1
```

不传项目路径时，脚本会尝试通过 `project_paths.py`、`B01_PROJECT_ROOT`、Git 根目录或当前目录向上查找项目。F429 使用 `Project/MDK-ARM(uV4)`；H750 使用带 H750 工程布局。

要求目标工程中存在对应的 `YTSwarm.exe` 和 Keil 工程文件。生成后写入真源 MDK 目录与根目录；若并列 `*U` 沙箱存在，再改写路径后拷一份过去（`Project` 仍指向真源）。传入沙箱路径时会先解析真源再生成。

## 工具箱环境变量

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `ZKZ_INSTALL` | 未设置 | 未设置时安装；设为 `0` 时只构建 `.vsix` |
| `ZKZ_EXTENSIONS` | 三个扩展 | 逗号分隔的包名，例如 `zkz-code` |
| `ZKZ_CURSOR` | 自动查找 | 覆盖 Cursor CLI 路径 |
| `ZKZ_VSCODE` | 自动查找 | 覆盖 VS Code CLI 路径 |
| `B01_PROJECT_ROOT` | 未设置 | 为路径解析工具指定项目根目录 |

J-Link、Keil 和 H750 FLM 的环境变量属于 `zkz-keil` 所服务的具体项目，见 [`f429-boot-jlink.md`](f429-boot-jlink.md)。
