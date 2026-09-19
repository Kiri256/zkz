# zkz 独立扩展

当前目录中的包是构建来源。

| 包 | 版本 | 命令前缀 | 做什么 |
| --- | --- | --- | --- |
| [`zkz-native`](zkz-native/README.md) | 1.0.0 | `zkz-native.*` | 真源 clean/smudge、编码表、编烧树 |
| [`zkz-code`](zkz-code/README.md) | 1.0.0 | `zkz-code.*` | 全量宏表、`#if` 折叠、clangd、FFFD |
| [`zkz-keil`](zkz-keil/README.md) | 1.0.0 | `zkz-keil.*` | UV4 编译、J-Link 烧录、Cortex-Debug 准备 |

运行时不调用本工具箱的 `scripts/`。

## 互相怎么调

跨包只 `executeCommand`，对方未装时本包用当前工作区回退。

- `zkz-native.resolveRoot` → `{ root }`；`zkz-native.isEnabled`
- `zkz-keil.resolveLayout` → 工程/产物路径
- `zkz-keil` 编烧前：`zkz-native.syncKeilTree`，再编 `.zkz/keil-native`，hex/axf 拷回真源
- `zkz-keil` 调试：优先 `zkz-native.copyDebugAxf`；gdb map 用 `substitute-path` 编烧树→真源
- Git 操作后的 `refreshStatus`：宏徽章会刷

切分支只刷编码表，不在 hook 里同步编烧树。

## 构建

```powershell
python .\extensions\package_zkz_code.py
python .\extensions\package_zkz_keil.py
python .\extensions\package_zkz_native.py
```

打包按各包白名单拷 `src/`，写出 `extensions/<包>-<版本>.vsix`。新 JS/JSON 必须写进对应 `package_zkz_*.py`。用编辑器安装 `.vsix` 后 **Reload Window**。
