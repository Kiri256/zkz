# F429 Boot / J-Link 烧录

本文记录 STM32F429BI（本项目 `b_01_zkz_1`）的 Boot 布局、烧录边界和一次恢复事故。记录日期：2026-09-05。

## Flash 布局

```text
0x08000000 ─┬─ Sector0 16KB ─┐
0x08004000 ─┼─ Sector1 16KB ─┼─ Boot，共 48KB（0xC000）
0x08008000 ─┼─ Sector2 16KB ─┘
0x0800C000 ─┴─ 应用，scatter / output.hex 从这里起
```

- scatter：`LR_IROM1 0x0800C000 0x001F4000`
- 应用启动必须设置 `NVIC_SetVectorTable(NVIC_VectTab_FLASH, 0xC000)`。
- Keil 按 `output.hex` 下载时只会影响应用范围，不会包含 Boot。
- J-Link Commander 的 `erase` 会整片擦除内部 Flash，不能用于普通 F429 应用更新。

## 文件判别

| 文件 | 内容 | 地址 | 用途 |
| --- | --- | --- | --- |
| `boot.hex` | 真 Boot | `0x08000000` 至 `< 0x0800C000` | 只写 Boot 区 |
| `output.hex` | 本工程应用 | 从 `0x0800C000` 起 | 只写应用区 |
| `boot.arm` | U 盘升级包（应用 bin 加末 4 字节校验） | 应用地址 | 由已有 Boot 处理，不是 Boot 镜像 |

正确 Boot 的向量表指纹：

```text
0x08000000 = 2000E290
0x08000004 = 080001C1
```

判断关键是 Reset 向量必须落在 48KB Boot 区内。H750 的 `boot.hex` 属于另一套片内 Flash + QSPI 布局，不能下载到 F429。

## 正确恢复顺序

连接 J-Link，确认 VTarget 约 3.3V。**不要执行 `erase`。**

```text
# 只写 Boot
loadfile boot.hex

# 只写应用
loadfile output.hex

# 502 Commander 拉复位脚
RSetType 2
rx 200
```

写完核对：

```text
mem32 0x08000000 2    # 期望 2000E290 080001C1
mem32 0x0800C000 2    # 期望应用向量表，以当前工程为准
```

从同型号正常板备份 Boot：

```text
savebin f429_boot.bin 0x08000000 0xC000
```

## J-Link 版本与配置

| 用途 | 版本 | 路径 |
| --- | --- | --- |
| F429 烧录/调试 | 5.02c | `C:\Program Files (x86)\SEGGER\JLink_V502c\` |
| H750 烧录/拉复位脚 | 6.98c | `C:\Program Files (x86)\SEGGER\JLink\` |

F429 的 Keil `JL2CM3` 实际参数包括 SWD 5000 kHz、`-RST0`、`-FO15` 和 `STM32F4xx_2048`。不要为切换 Commander 版本改动 Keil 全局 `JLinkARM.dll`。

F429 使用 5.02c 时，Commander 是带窗口的 `JLink.exe`，脚本需要隐藏窗口；拉复位脚使用 `RSetType 2` 加 `rx`。H750 使用 6.98c 和 `STM32H750_W25Q32.FLM`，应用位于 QSPI `0x90000000`。

## 故障判断

| 现象 | 判断 |
| --- | --- |
| `0x08000000` 全为 `FF`，PC=`FFFFFFFE` | Boot 被擦除 |
| PC 在 `0x08000xxx`，Reset=`080001C1` | 真 Boot 正在运行 |
| PC=`0x08000C3C`，指令 `E7FE`，IPSR=HardFault | Boot 的 HardFault 死循环，继续看异常栈 |
| 异常栈 PC 在 `0x0816xxxx` 且该处为 `FF` | 应用尾部没有烧全 |
| PC 在 `0x0800Cxxx`/`0x0803xxxx` 且 IPSR=0 | 应用已运行 |

读取异常状态：

```text
mem32 0xE000ED28 4    # CFSR / HFSR
```

异常栈中 `MSP + 0x18` 是出错 PC。此前事故的 CFSR=`00010000`（UNDEFINSTR），HFSR=`40000000`（FORCED），出错地址约为 `0x08169084`。

## 事故结论

曾经使用 502 Commander 执行 `erase` 后只加载 `output.hex`，导致 Boot 消失。恢复 Boot 后又把 `boot.arm` 当成完整应用烧录，应用尾部缺失，启动复制 RW 初始化数据时执行了空 Flash，最终进入 HardFault。

以后遵守三条：

1. F429 不做整片 `erase`。
2. `boot.arm` 不当 Boot，也不当完整 `output.hex`。
3. 中文真源文件保持 GBK/936，不能用默认 UTF-8 写回。
