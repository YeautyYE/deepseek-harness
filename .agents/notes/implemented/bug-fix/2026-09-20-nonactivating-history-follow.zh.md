# Agent Note: 保持历史 Session 浏览不激活 Agent

Status: implemented

[English](2026-09-20-nonactivating-history-follow.md) | 中文

## 问题

普通冷 Session 的 follow 在打开快照后会在后台恢复 Agent。浏览器关闭 follow 后，Agent 生命周期仍保留完整 Session。因此，查看更多历史 Session 会累积实时 Agent 和日志，独立于准备缓存预算与首屏读取方生命周期。

## 决策

`session.follow` 和 `session.page` 只观察历史。监听器先于首屏读取安装，因此后续显式激活仍可连续交付新事件，不出现订阅缺口。首屏生成器在等待事件前释放完整 observation。Prompt、queue、model、rename、文件引用操作，以及 Agent 范围的 Remote lookup 保留现有显式激活策略。浏览器命令目录预加载使用已记录 preset 的常驻 scope，无需在线 Agent。Goal 激活查询只查找已有 Agent；冷 Session 中持久化的 active goal 展示为 disarmed。

Web Host 挂载纯 `tool-todo/projection` 和 `plan-mode/projection` 插件，使冷快照在任何 Agent preset 启动前保留 Todo 与计划控件。面向模型的工具与计划运行时复用这些定义；注册 Host fold 不添加工具、命令或提示词。

本决策仅取代[历史传输](../architecture/2026-08-18-session-history-and-event-transport.zh.md)与 [Session observation](../architecture/2026-08-25-session-observations-and-projection-owned-client-state.zh.md) 中的 follow 自动 promotion。两份记录仍保留独立的传输与投影依据。[有界读取方保留](2026-09-19-history-reader-retention.zh.md) 对冷读取、长生命周期 follower 和浏览器节点数据源仍然必要。没有记录被完全取代。

打开或重连冷历史 Session 不会恢复其 Agent 插件或提醒运行时。排队输入保持持久化，直到显式操作处理它。需要 Agent 的操作会按现有生命周期规则恢复它。已经在线的 Agent 及其后台工作仍由该生命周期拥有；浏览器导航既不释放它们，也不取消其工作。

## 已考虑的替代方案

**保留快照后的后台 promotion。** 这能在首个命令前准备好 Agent 能力，并把激活移出首屏渲染路径，但每份查看过的历史都会变成常驻 Agent，且没有由浏览行为拥有的退出点。有界读取缓存并不限制这个所有者。

**最后一个 follower 关闭时释放空闲 Agent。** 空闲状态不代表 Agent 没有提醒、待处理输入或后台工作。浏览器 follower 不拥有这些生命周期，关闭它也不应终止它们。

**仅提升投影显示有待处理工作的历史。** 在历史传输中加入领域判断会将其耦合到可选插件，且仍会遗漏其他激活效果。需要 Agent 的操作拥有激活权限。

## 影响

浏览多个冷历史时，可复用读取只在配置的缓存限制与活动读取方生命周期内保留。后续首个命令承担 Agent 恢复成本。显式激活的 Agent 仍保留自身 Session；本变更不引入通用的空闲 Agent 淘汰策略或进程 RSS 上限。

真实 AgentLoop 与 JSONL 回归打开并关闭三份历史，检查实时注册表，再通过显式 prompt 恢复，并检查持久输出与 follow 连续性。自动 promotion 的负对照依次累积一个、两个、三个实时根 Agent。组合后的 cold-history 浏览器场景验证三份冷 Session 的 Todo 与计划控件，且只在点击计划控件时激活所选 Session。组合后的 seeded-history 浏览器场景在显式激活前检查冷态注册表，并通过已有 follow 渲染后续实时事件。
