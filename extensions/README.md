# zkz 独立扩展

当前目录中的包是构建来源。版本号见各包 `package.json`。

| 包 | 命令前缀 | 做什么 |
| --- | --- | --- |
| [`zkz-native`](zkz-native/README.md) | `zkz-native.*` | 真源 clean/smudge、编码表、编烧树 |
| [`zkz-code`](zkz-code/README.md) | `zkz-code.*` | 全量宏表、`#if` 折叠、clangd、FFFD |
| [`zkz-keil`](zkz-keil/README.md) | `zkz-keil.*` | UV4 编译、J-Link 烧录、Cortex-Debug 准备 |

运行时不调用本工具箱的 `scripts/`。

## 互相怎么调

工程根目录、Keil 布局、过滤器是否启用、设置读写都在 `extensions/shared/`，三个扩展直接 `require`，不再互相回退。打包时 `require('../../shared/<名>')` 改写成 `require('./shared/<名>')`，并把对应文件拷进 vsix。

设置写在仓库 `.zkz/settings.json`（`native` / `keil` / `code`）。没有文件时按默认值补齐，已有的键不覆盖。空字符串按未设置处理，继续走环境变量。这份文件不进 git。

- `zkz-keil` 编烧前：过滤器已启用则调用 `zkz-native.syncKeilTree`，命令不在就失败；未启用则编真源
- `zkz-keil` 调试：按布局把 `output.axf` 拷到 `.zkz/output.axf`；gdb map 在过滤器启用时用 `substitute-path` 把编烧树指回真源
- `zkz-code` 自己监视 `HEAD`，刷新宏和 `compile_commands`
- Git 操作后的 `refreshStatus`：宏徽章会刷

切分支只刷编码表，不在 hook 里同步编烧树。

## 构建

```powershell
python .\extensions\package_zkz_code.py
python .\extensions\package_zkz_keil.py
python .\extensions\package_zkz_native.py
```

打包按各包白名单拷 `src/`，写出 `extensions/<包>-<版本>.vsix`。新 JS/JSON 必须写进对应 `package_zkz_*.py`。用编辑器安装 `.vsix` 后 **Reload Window**。
