# 实例维护者指南

实例维护者负责运行 ImageShow 的主机、容器、网络和持久化数据，不是 PostgreSQL 中的一种
后台角色。个人部署中同一个人可以同时是实例维护者和超级管理员，但两种职责仍应分开。

## 部署与升级职责

- 准备单个 Compose 项目、一个 ImageShow 应用、一个 PostgreSQL 和一个 Redis。
- 管理 `.env`、宿主环境与 Compose 环境映射、`data/` bind mount、PostgreSQL volume 与尽力保留临时态的 Redis volume。
- 配置唯一可信反向代理、HTTPS、Host 与转发头覆盖，并阻止公网直连应用端口。
- 拉取或构建镜像，原位停止和启动应用，检查 `/livez`、`/readyz` 与三个容器健康状态。
- 在部署前确认数据库 additions、备份与隔离恢复路径，不跳过承载当前增量的发布。
- 在后台不可登录时使用独立密码恢复入口，并核对 PostgreSQL / Redis 可用性。

首次安装从[快速开始](../getting-started.md)开始；生产拓扑、Nginx、停机与健康检查见
[生产部署](../deployment.md)。配置来源和环境变量见[配置说明](../configuration.md)，数据库
基线与安全新增边界见[数据库结构](../database.md#启动与结构契约)。

## 数据安全边界

- PostgreSQL 是业务真相源；Redis 是必需的 operational datastore，只保存可重建投影、会话和
  运行时状态。空库冷启动受支持，但运行中清空或局部删 key 不受支持。
- 不使用 `docker compose down -v` 作为普通升级步骤，不清空 `data/`、数据库或存储桶。
- 应用只支持单实例原位升级，不支持两个应用同时连接同一数据库、滚动升级或自动接管。
- 存储对象删除和数据库破坏性结构变更必须先明确范围、停机条件、备份与恢复方案。
- 升级到 5.4.2 前必须停止旧应用并完成 PostgreSQL 备份；启动事务会接管可解释的旧 purge 删除
  意图并删除旧四列、旧 CHECK 与旧索引，畸形或部分旧结构会整体回滚并拒绝启动。

组件所有权与运行期交接见[架构总览](../architecture.md)，源码开发与发布门禁见
[项目结构](../project-structure.md)。
