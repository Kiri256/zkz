# 重点做fpga驱动，在linux简单验证 ，列出学习项

> 重点做fpga驱动，在linux简单验证 ，列出学习项

<details><summary>4 previous messages</summary>

> 我先快速看一下当前工程的目录和已有 FPGA/Linux 相关代码，再按“驱动开发为主、Linux 验证从简”的目标整理一份贴合项目的学习清单。
>
> <details><summary>Ran a command</summary>
>
> - Ran `Get-ChildItem -Force | Select-Object Mode,Length,LastWriteTime,Name; rg -n -i "fpga|linux|driver|spi|i2c|dma|irq|interrupt|mmap|ioctl|device tree|dts" . -g "!*.o" -g "!*.a" -g "!*.elf" -g "!*.bin" -g "!*.map"`
>
> </details>
>
> 从工程信息看，目标平台是 STM32MP157（Cortex-A7/OpenSTLinux），上层已有 Qt/QML 的 `FpgaWorker`，但当前目录主要是构建产物。接下来我再确认用户态目前通过什么设备节点/接口访问 FPGA，这会决定驱动学习的优先级。
>
> <details><summary>Ran 2 commands</summary>
>
> - Ran `rg -a -n -i --max-count 100 "/dev/|/sys/|mmap|ioctl|open\(|read\(|write\(|fmc|gpmc|spi|gpio|uio|fpga" mp157_fpga_test FpgaWorker.o; git status --short; git ls-files`
> - Ran `Get-ChildItem .. -Force | Select-Object Mode,Name; Get-ChildItem ..\..\..\..\project\yuntu_mp157_test\mp157_fpga_test -Force | Select-Object Mode,Length,Name`
>
> </details>
</details>

建议按“FPGA 侧 70% + 接口联调 20% + Linux 验证 10%”安排。当前工程的 `FpgaWorker` 是通过 `/dev/mem + mmap` 直接访问 FPGA 寄存器，适合作为第一阶段的简单验证，但还不属于正式 Linux 内核驱动。

## 1. FPGA 基础

- Verilog/SystemVerilog 基础语法
- 组合逻辑、时序逻辑
- 阻塞与非阻塞赋值
- 有限状态机 FSM
- 时钟、复位、使能设计
- 仿真 Testbench
- 时序约束、建立/保持时间
- 综合、布局布线、时序报告
- 在线逻辑分析工具：ILA/SignalTap

目标：独立完成 GPIO 输入输出、计数器、PWM 等模块，并通过仿真和板上测试。

## 2. FPGA 驱动与接口设计（重点）

### 寄存器接口

- 地址译码
- 可读、可写、只读寄存器
- 位操作：置位、清零、写 1 清零
- 状态寄存器和控制寄存器
- 版本号、设备 ID、复位值
- 寄存器读写时序
- 非法地址处理
- 寄存器表文档编写

建议先定义：

- `ID_VERSION`
- `CONTROL`
- `STATUS`
- `OUTPUT`
- `INPUT`
- `IRQ_STATUS`
- `IRQ_ENABLE`
- `IRQ_CLEAR`

### STM32MP157 与 FPGA 总线

如果硬件采用 FMC/并行总线，重点学习：

- FMC NOR/SRAM 模式
- 地址线、数据线、片选、读写使能
- 异步读写时序
- FPGA 地址锁存和数据输出控制
- 数据总线三态控制
- 总线宽度：8/16/32 位
- 字节序和地址对齐
- Linux 物理地址与 FPGA 寄存器地址的对应关系
- 时序裕量和总线波形分析

如果采用 SPI，则替换为：

- SPI Mode 0～3
- 片选和帧格式
- 命令、地址、数据协议
- CRC、超时和错误响应

### 中断

- FPGA 中断产生条件
- 中断状态锁存
- 中断使能与屏蔽
- 中断清除机制
- 电平中断与边沿中断
- 多中断源合并
- STM32MP157 GPIO/EXTI 中断连接
- 防止中断风暴

### 数据通道

第二阶段再学习：

- FIFO
- 双口 RAM
- 跨时钟域 CDC
- 异步 FIFO
- 流控和溢出处理
- 批量数据搬运
- DMA
- 缓存一致性

简单寄存器控制项目暂时不用急着上 DMA。

## 3. FPGA 设计可靠性

- 两级同步器
- 跨时钟域脉冲同步
- 异步复位、同步释放
- 按键/外部信号消抖
- 亚稳态
- 看门狗与超时
- 上电默认状态
- FPGA 未配置、重新配置时的安全状态
- 输入输出电平标准
- 错误计数和调试寄存器

## 4. Linux 简单验证

第一阶段继续采用 `/dev/mem + mmap` 即可，重点掌握：

- `open("/dev/mem")`
- 页大小和页对齐
- `mmap()` 与 `munmap()`
- `volatile` 寄存器访问
- 8/16/32 位访问宽度
- 地址边界检查
- 大小端
- 读回校验
- `devmem` 命令
- `dmesg` 查看异常
- `/proc/iomem` 确认地址是否冲突

建议编写一个独立的命令行测试程序，不依赖 Qt：

```text
fpga_test id
fpga_test read  0x00
fpga_test write 0x0c 0x55
fpga_test loop
```

验证内容：

- 读取固定设备 ID 和版本号
- 输出寄存器写入后读回
- FPGA 输入状态读取
- walking-1：`01、02、04、08...`
- `00/FF/55/AA` 数据模式
- 连续读写稳定性
- 越界地址保护
- 复位后默认值

注意：`/dev/mem` 需要 root 权限，也缺少资源保护，只适合板级调试。

## 5. Linux 内核驱动（后续完善）

简单验证稳定后再学习：

- Linux 内核模块基本结构
- platform driver
- 设备树 `compatible/reg/interrupts`
- `probe()`、`remove()`
- `devm_ioremap_resource()`
- `readl()`、`writel()`
- 字符设备或 miscdevice
- `open/read/write/ioctl/poll`
- `request_irq()` 与中断处理
- 等待队列
- 并发、互斥锁、自旋锁
- `sysfs` 和 `debugfs`
- 用户态 `mmap`
- 驱动错误码和日志

对于当前这种少量输入输出寄存器，推荐最终结构：

```text
Qt/QML应用
    ↓ read/write/ioctl
/dev/fpga0
    ↓
platform FPGA驱动
    ↓ readl/writel
FMC/存储器映射寄存器
    ↓
FPGA RTL
```

## 6. 推荐实践顺序

1. FPGA 实现设备 ID、版本号和一组输入输出寄存器。
2. 编写 Testbench 验证寄存器读写时序。
3. 使用逻辑分析仪/ILA 检查总线波形。
4. Linux 使用 `devmem` 读取设备 ID。
5. 编写最小 C 程序，通过 `/dev/mem + mmap` 测试。
6. 完成 `00/FF/55/AA` 和 walking-1 压力测试。
7. 增加 FPGA 中断并在 Linux 简单验证。
8. 最后将 `/dev/mem` 替换成设备树加 platform 驱动。
9. Qt 的 `FpgaWorker` 攓为访问 `/dev/fpga0`。

首个可交付目标应是：Linux 能稳定读取 FPGA ID、控制 8 路输出、读取 8 路输入，并连续循环测试无错误。
