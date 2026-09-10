# zkz 独立扩展

旧单体扩展已经拆成三个独立包。当前目录中的三个包是构建和安装的来源。

| 包 | 版本 | 命令前缀 | 做什么 |
| --- | --- | --- | --- |
| [`zkz-sandbox`](zkz-sandbox/README.md) | 1.0.0 | `zkz-sandbox.*` | 真源 侧栏 Git、状态栏、ToUtf/ToGb、对比、仪表盘 |
| [`zkz-code`](zkz-code/README.md) | 1.0.0 | `zkz-code.*` | 全量宏表、`#if` 折叠、clangd、FFFD |
| [`zkz-keil`](zkz-keil/README.md) | 1.0.0 | `zkz-keil.*` | UV4 编译、J-Link 烧录、Cortex-Debug 准备 |

运行时不调用本工具箱的 `scripts/`。名单与同步逻辑已嵌在各包 `src/`。

## 互相怎么调

- `zkz-keil` 从沙箱编：`zkz-sandbox.toGb`。命令不存在则跳过并打日志，继续编。
- `zkz-keil` 调试准备：有 `zkz-sandbox.copyDebugAxf` 则拷 axf 并写 gdb map。命令不存在则跳过 map，Prepare 成功并继续调试。
- `zkz-sandbox` 签出：`zkz-code.beginYtMacroCheckoutGuard` / `syncYtVersionAfterCheckout`。没有 code 包只记日志。
- Git 操作后的 `refreshStatus`：同步条与宏徽章都会刷。

## 构建 / 安装

```powershell
powershell -ExecutionPolicy Bypass -File .\extensions\install_zkz_extensions.ps1
$env:ZKZ_INSTALL='0'
powershell -ExecutionPolicy Bypass -File .\extensions\install_zkz_extensions.ps1
```

脚本默认同时装三个包到 Cursor 与 VS Code（两个编辑器都要装到，缺 CLI 则报错），并卸载旧的 `zkz-git`、`zkz-w1-git`、`zkz-sync`、`zkz-git-core`。

只要某一个包：

```powershell
$env:ZKZ_EXTENSIONS='zkz-code'
powershell -ExecutionPolicy Bypass -File .\extensions\install_zkz_extensions.ps1
```

打包按各包白名单拷 `src/`。新 JS/JSON 必须写进 `install_zkz_extensions.ps1` 对应列表。只构建不安装时设置 `$env:ZKZ_INSTALL='0'`。装完 **Reload Window**。
