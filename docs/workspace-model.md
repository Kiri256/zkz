# 工作区模型

## 只开真源（zkz-native）

`zkz-native` 用 git clean/smudge 让真源**工作区恒 UTF-8**，仓库 blob 仍按文件保留 GBK/ASCII/UTF-8。

1. 打开真源，命令面板 **zkz Native: Enable filter**（工作区须干净）。
2. 用 UTF-8 改 `.c/.h`，自带 Git 暂存/提交即可；clean 会编回原编码。
3. `zkz-keil` 先同步 `.zkz/keil-native/` 再编 Keil；调试 map 把编烧树 substitute 回真源。
4. 重命名/切分支后若编码表过期，跑 **Refresh encoding table**。

本地 filter 配置在 `.git/info` / `.git/config`，不进仓库。

## 编码规则

| 范围 | 编码 |
| --- | --- |
| 本工具箱文档、脚本 | UTF-8 |
| 真源工作区 `.c/.h`（native 已启用） | UTF-8 |
| 真源仓库 blob / 编烧树 | 按文件：GBK、ASCII、UTF-8 |
| 未启用 native 的真源、库 Junction | 仓库原字节（多为 GBK） |

启用 native 后可直接用编辑器/Agent 改真源 `.c/.h`。未启用时不要当 UTF-8 批量改真源或未转码 Junction。

## 编译与扩展边界

- `zkz-code` 打开 `.c/.cpp` 时只应用已有宏表，不会每次重新解析。
- `zkz-keil` 在真源+native 下编编烧树，并写 `substitute-path`。
- `zkz-keil.prepareCortexDebug` 优先 `zkz-native.copyDebugAxf`，否则本包拷真源 axf。
- 打包脚本按白名单拷各包 `src/`；新增源码文件后必须同步更新对应 `package_zkz_*.py`。
