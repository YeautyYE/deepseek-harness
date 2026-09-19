# Agent Note: 按读取方生命周期限制历史数据保留

Status: implemented

[English](2026-09-19-history-reader-retention.md) | 中文

## 问题

浏览历史 Session 会产生三类独立的解码数据所有者：可复用的 Host observation 缓存、实时 follow 流的首屏读取，以及浏览器中单个聊天节点的数据源。显示页较小并不限制这些所有者保留的对象。条目数限制仍允许日志无限增大；挂起的生成器可能保留已完成首屏读取的局部变量；强引用的按键数据源表会在窗口替换后继续保留节点。

## 决策

[Observation 读取器](../../../../packages/session-query/session-query/src/observation.ts) 同时应用现有的五条目限制和可配置的 32 MiB 解码日志权重预算。它估算 UTF-16 字符串、对象和引用槽位，对共享对象去重，且在条目超过预算时停止，不序列化日志。默认值保留小历史供复用，同时避免五个大历史同时驻留。活动租约计入两项限制，但在释放前受到保护，不参与淘汰。字节预算为零时，最后一份租约释放后即停止保留。修订替换和实时来源优先会移除旧缓存权重，已有租约仍然有效；首次投影失败时不发布缓存条目。

[历史控制器](../../../../packages/api/session-controller/src/history.ts) 把首屏读取委托给短生命周期生成器。该生成器拥有 observation、完整事件数组、分页构建、snapshot 产出和 promotion 交接。在首屏生成器完成后，实时 follower 只保留 cursor 和 assistant-stream 切面。Promotion 独立持有租约。监听器安装和缓冲仍然先于 observation，维持 snapshot 在先且事件连续的交付顺序。

[聊天数据源注册表](../../../../packages/client/ui-chat/src/client/conversation-nodes/chat-snapshot-builder.ts) 通过 `WeakRef` 保存按键数据源。消费者持有的数据源会在窗口替换和节点重新出现后保持身份。活动订阅还会强持有数据源直到最后一次退订，包括调用方既未保留数据源也未保留退订函数的情况。终结回调只移除匹配的弱条目，因此旧数据源回收不会移除其替代者。

[Observation 架构](../architecture/2026-08-25-session-observations-and-projection-owned-client-state.zh.md) 和[历史传输决策](../architecture/2026-08-18-session-history-and-event-transport.zh.md) 继续有效：本决策补充保留对象的所有权，不替换其来源、投影、流或 promotion 语义。[只读迁移准备](../architecture/2026-09-05-read-only-session-migration-preparation.zh.md) 继续拥有持久化层共享与发布规则。没有活动决策被完全取代。

## 本地证据

编译后的生产路径在普通 Node 下运行，采用固定合成输入和显式垃圾回收。每项诊断都保留其预期读取器或 follower 终点对象。这些测量覆盖导航或首屏读取后的可达堆内存，不代表峰值内存、浏览器渲染成本或远程 Windows 进程的最终内存。

| 诊断与可达终点 | 原实现 | 修复后 |
|---|---:|---:|
| Observation 读取器依次读取 10 个 Session，每个含 512 条消息、每条 16 KiB 文本 | 41.14 MiB | 8.46 MiB |
| 六个等待中的 follower，各自从 3,000 个事件、每个 6,144 个文本字符打开 | 111.657 MiB；六个完整数组 | 0.1517 MiB；零个完整数组 |
| 聊天存储依次替换 20 个窗口，每个创建 2,000 对节点与过程数据源 | 46,127,088 字节 | 244,912 字节 |

Observation 测量使用 macOS arm64 / Node 24.5.0，以三次样本的保留堆中位数比较。移除字节限制后恢复到 41.17 MiB。原聊天缓存超过诊断中的 4 MiB 检查值；替换实现保留数据源身份，并为持有对象和仅有订阅的读取方保留全部 40 次通知。包内[缓存](../../../../packages/session-query/session-query/tests/prepared-cache.perf.ts)和 [follow](../../../../packages/api/session-controller/tests/history-retention.perf.ts) 诊断保留合成复现路径；fixture 不含私人 Session 内容。功能测试覆盖字节淘汰、租约释放、替换、投影失败、首屏取消、交接、数据源复用和通知所有权。

## 已考虑的替代方案

**把缓存缩减为一个条目。** 单个解码历史仍可能任意增大。数量和字节双重限制既保留有用的小历史，也按体积限制已释放数据的保留量。

**在实时生成器内部的块中释放首屏 observation。** 释放会解除缓存固定，但测得的工作负载中，挂起的生成器帧仍保留首屏数组。完成的首屏生成器会移除这个所有者。

**节点离开当前窗口时删除所有浏览器数据源。** 消费者可能仍持有或订阅该数据源。替换它会破坏节点重新出现时的身份和通知。弱引用查找配合订阅所有权可维持这些义务。

## 影响

再次访问已淘汰的历史会重新读取并校验。字节估算限制缓存复用量，而非进程 RSS；活动读取、实时 Session 和投影状态各自保留其内存。弱数据源由 JavaScript 回收器决定回收时机，订阅需要显式清理。持久历史、迁移发布、分页和消息内容保持完整。这些诊断不添加未经校准的 CI 时间预算。
