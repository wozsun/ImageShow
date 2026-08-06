# 多应用实例演进待办

当前生产边界是一台主机上的一个 ImageShow 应用容器；PostgreSQL 与 Redis 位于另一套
Compose，并各自只运行一个单机单容器。升级时停止对应容器、更新当前容器再启动。短期
不计划支持多个 ImageShow 实例。当前进程通过 PostgreSQL 生命周期 advisory lock 拒绝
同库第二实例，并在 lock session 丢失时安全退出；它没有 fencing token、跨实例缓存失效
或 writer 接管能力，只是误部署保护。只有未来部署前提真实改变时，才重新评估以下事项。

## v4 主动移除的旧能力

- 不恢复旧随机缓存的 generation 键、独立候选池及其 publish / sync / lifecycle 链路。
  统一 ready-image 读模型已经成为画廊、后台就绪列表和随机查询的唯一 Redis 投影。
- 不恢复分布式重建锁、续租心跳、跨进程 rebuild spool 或旧 writer 接管分支。当前重建
  coordinator 与读写栅栏只负责单个应用进程，升级会先停止该进程。
- 不为当前拓扑加入 outbox、logical decoding、Pub/Sub 协调或实例观察 revision。若未来
  需要多实例，必须作为完整一致性协议重新设计，不能把这些旧分支逐项加回。

## 图片缓存一致性

- 把当前进程内 ready-image 读写栅栏升级为跨实例协议。任何实例开始图片事务后，其他
  实例必须在提交 revision 与 Redis 精确发布完成前停止读取旧投影。
- 为 `ready_image_revision` 建立可靠变更投递。方案需要证明事务提交与事件不会出现双写
  缺口，可采用 PostgreSQL outbox / logical decoding；Redis Pub/Sub 只能作为低延迟通知，
  不能作为唯一可靠记录。
- 精确同步与全量重建必须有带 fencing token 的分布式所有权。失去租约的旧 writer 不得
  在新 writer 之后发布 meta revision、删除键或重新开放读门。
- 全量重建期间需要跨实例共享状态；所有实例都应回源 PostgreSQL，直到同一份完整性
  清单与目标 revision 已发布。还要验证进程崩溃、网络分区、Redis 主从切换和 COMMIT
  回包丢失。
- 管理端缓存状态必须展示全局 coordinator，而不是某个进程的局部状态；手动重建要能
  幂等合并，并能定位当前 owner、目标 revision 与最近失败。

## 配置、存储与任务

- 为运行时配置、管理员权限、存储后端注册表和 driver 生命周期建立跨实例失效通知；
  配置写入完成后，不能让其他实例继续使用旧 endpoint、凭据或默认后端。
- storage backend 注册表与 driver 缓存不能继续只依赖进程内刷新；应选择可验证的共享
  失效协议，但不能因此让每次对象访问都无条件查询 Redis。
- 审核现有 storage location / vocabulary / image advisory lock 的全局顺序，证明所有实例
  使用同一锁键和同一 PostgreSQL 会话边界，不出现锁顺序反转。
- Worker 领取已经依赖 PostgreSQL token，但还需验证多个 Worker 在续租丢失、僵尸恢复、
  停机和任务重排时不会重复执行不可逆存储删除。
- ALTCHA、登录限流、会话和随机最近历史已经在 Redis 中共享；若未来改用 Redis Cluster，
  仍需为当前多 key `EVAL` 限流脚本设计共同键槽，不能直接宣称兼容。
- 多个应用实例共同承接登录请求前，通过部署 Secret 注入共享 ALTCHA 挑战签名密钥，
  并明确密钥轮换时尚未提交挑战的失效语义；密钥不进入运行时配置或配置包。

## 发布与验证门槛

- 增加至少 3 个应用实例的隔离 Compose：并发导入、编辑、标签 / 作者级联、删除 / 恢复、
  存储迁移和缓存重建都必须覆盖。
- 增加故障注入：随机终止 writer、暂停网络、重启 Redis、切换 PostgreSQL 连接、延迟
  outbox 消费，并持续比较 Redis 投影、`ready_image_revision` 与 PostgreSQL 真值。
- 建立可观测指标：各实例已观察 revision、缓存回源率、重建 owner / 进度、事件积压、
  精确同步延迟和完整性失败；告警不能只依赖共享 Redis hit/miss 总计数。
- 完成上述工作后再修改[部署说明](./deployment.md)中的单实例限制，并单独进行容量与
  一致性协议评审。
