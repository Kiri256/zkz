# zkz 独立扩展

当前目录中的包是构建来源。版本号见各包 `package.json`。

| 包 | 命令前缀 | 做什么 |
| --- | --- | --- |
| [`zkz-native`](zkz-native/README.md) | `zkz-native.*` | 真源 clean/smudge、编码表、编烧树 |
| [`zkz-code`](zkz-code/README.md) | `zkz-code.*` | 全量宏表、`#if` 折叠、clangd |
| [`zkz-keil`](zkz-keil/README.md) | `zkz-keil.*` | UV4 编译、J-Link 烧录、Cortex-Debug 准备 |

运行时不调用本工具箱的 `scripts/`。

完整检查流程见 [三个扩展验收指南](validation.md)，包含自动测试、所有公开命令、自动触发事件、缓存性能及编译/烧录/调试联动。

## 互相怎么调

工程根目录、Keil 布局、过滤器是否启用、设置读写都在 `extensions/shared/`，三个扩展直接 `require`，不再互相回退。打包时 `require('../../shared/<名>')` 改写成 `require('./shared/<名>')`，并把对应文件拷进 vsix。

设置写在仓库 `.zkz/settings.json`（`native` / `keil` / `code`）。默认值在 `extensions/shared/zkz_settings.js`。工作区没有设置文件时按这些默认值生成，已有的键不覆盖。空字符串按未设置处理。这份文件不进 git。

- `zkz-keil` 编烧前：过滤器已启用则调用 `zkz-native.syncKeilTree`，命令不在就失败；未启用则编真源
- `zkz-keil` 调试：按布局把 `output.axf` 拷到 `.zkz/output.axf`；gdb map 在过滤器启用时用 `substitute-path` 把编烧树指回真源
- `zkz-code` 自己监视 `HEAD`，刷新宏和 `compile_commands`
- 换分支后 `zkz-code` 自己刷宏徽章和 `compile_commands`

切分支只刷编码表，不在 hook 里同步编烧树。

## 内存与缓存

三个扩展的共享设置模块按 `settings.json` 的 mtime、ctime、大小缓存解析结果，最多保留 8 个工程；每次读取仍检查文件状态，写入、删除或解析失败时失效。返回的对象是副本，避免修改设置对象污染缓存。各扩展宿主/打包模块拥有自己的缓存，不共享跨进程内存。

`zkz-code` 的宏表与折叠分析已有内存缓存。编译数据库每次刷新都重新解析工程 XML，不再另存解析结果。

`zkz-native` 的过滤进程编码表、库目录快照、协议缓冲区与编烧树增量缓存详见 [native 缓存说明](zkz-native/README.md#内存与缓存优化)。`zkz-keil` 复用共享设置缓存；编译结果、烧录结果与硬件状态不缓存，仍实时执行外部工具。

编译数据库生成后会比较目标文件的实际内容，相同时保留文件及时间戳，避免无效写入；缺失或被覆盖的文件仍会恢复。共享性能日志达到 5 MiB 后轮转为 `performance.jsonl.1`，只保留一份备份；多进程竞争或 I/O 失败时日志为尽力记录，不影响实际操作。

性能日志新记录的 `at` 使用可读北京时间，例如 `2026-10-10 11:28:30.532 +0800`，保留毫秒精度；旧 UTC 记录保持原样。`ms` 是操作耗时（毫秒），不属于日期时间。

## 构建

```powershell
python .\extensions\package_zkz_code.py
python .\extensions\package_zkz_keil.py
python .\extensions\package_zkz_native.py
```

打包按各包白名单拷 `src/`，写出 `extensions/<包>-<版本>.vsix`。新 JS/JSON 必须写进对应 `package_zkz_*.py`。用编辑器安装 `.vsix` 后 **Reload Window**。
