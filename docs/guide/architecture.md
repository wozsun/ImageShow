# 架构总览

ImageShow 使用 npm workspaces 管理 Server、Web 和 Shared。生产镜像由一个 Hono 应用提供
React SPA、API 和图片资源，只支持单应用实例。本文说明组件职责和数据所有权；具体源码入口见
[项目结构](project-structure.md)，端到端行为见[功能与流程](flows.md)。

## 整体结构

![ImageShow 架构图：客户端经反向代理访问 Hono，应用连接 PostgreSQL、Redis 和 local / S3，Worker 消费持久任务与接入状态](assets/architecture.svg)

PostgreSQL、Redis 可以独立部署，但应用只使用明确配置的单一连接目标。
部署、反向代理与停止宽限见[生产部署](../DEPLOY.md)。

## 请求与主机边界

| 入口 | 提供的能力 |
| --- | --- |
| 主站 Host | SPA、公开 / 管理 API、健康检查、`/random` 和 `/images` |
| 本地图片公开 Host | 固定读取 local 的完整图和缩略图，保留配置的路径前缀 |
| 静态资源公开 Host | 只提供前端 assets，保留配置的路径前缀 |

配置显式域名时，其余 Host 返回 404；域名为空或为 `example.com` 时使用合法访问 Host，
图片地址使用同源路径。资源 Host 不开放后台或 SPA。
代理覆盖 Host、单值协议和单值客户端 IP，应用端口只对可信代理可达。
嵌入页由配置与 CSP 限定父页面，不扩大 API 跨源权限。
详见[主机与图片资源](image-resources.md)和[安全](security.md)。

## 代码分层

```text
packages/server ──► packages/shared
packages/web ─────► packages/shared
```

- Shared 保存共同 DTO、常量、配置默认值和纯规则；浏览器入口不包含 Node.js 或运行时秘密。
- Server 由 HTTP 边界调用领域，领域调用基础设施。事务、锁、缓存与资源的所有权留在领域内。
  `core` 不持有图片筛选、词表或管理员业务规则。
- Web 由页面编排组件、Hook 和无界面库。页面专属的接入队列、上传和导入模型就近维护，
  跨页面模块不反向依赖页面。

目录、状态所有者和按需加载边界见[项目结构](project-structure.md)。

## 数据所有权

| 数据 | 唯一权威 | 生命周期 |
| --- | --- | --- |
| 正式图片、词表、账号、存储注册表、后台任务 | PostgreSQL | 持久化；图片在事务提交后才正式入库 |
| 图片读模型、查询缓存、随机历史 | Redis | 派生或临时；图片投影由协调器重建 |
| 登录会话与限流 | Redis | 有期限；账号角色与密码仍逐请求核对 PostgreSQL |
| Upload / Import 未完成状态与紧凑完成回执 | Redis Ingestion canonical | 在队列期限内恢复，Redis 丢失后允许消失 |
| 原始接入文件、处理结果与缩略图候选 | `data/temp` | 临时字节，不构成第二套任务恢复来源 |
| 正式完整图与缩略图 | local / S3 | 位置由 PostgreSQL 记录，物理键独立于可编辑分类 |
| 当前文档的占位、草稿与 Blob | 对应 Web 队列 owner | 随页面生命周期释放，不覆盖服务端完成事实 |

### PostgreSQL

空数据库在同一事务中执行完整 `schema.sql` 与只读 readiness；非空数据库只做当前最小结构的
只读检查。既有结构由维护者明确维护，应用不会自动补表、回填或对齐完整 schema。
额外表、未消费列和索引不进入业务检查。表、约束与连接预算见[数据库结构](database.md)。

### Redis

所有 ready 图片使用同一核心投影与 revision。设备、明暗、主题、标签、作者及组合筛选是有界
派生结果；缺失或过期不被当作空图库。核心投影损坏、revision 不一致或 Redis 连接变化时，
协调器关闭读取门并以同一活动任务校验 / 重建。公共读取通过受限 PostgreSQL reader scope 回源，
后台在 Redis 不可用时明确返回 `503 redis_unavailable`。`/random` 在选图前按 IP 与是否带
`limit` 分档计数；白名单 Referer 豁免，非白名单计数失败也返回 503。应用图片入口的轻量
Referer 校验允许空值与同一白名单，具体规则见[安全说明](security.md)。

协调器只有 `unavailable`、`rebuilding`、`ready`、`stopped` 四态。图片事务推进 PostgreSQL
revision，在写栅栏内完成精确同步；超过精确同步预算时只安排一次完整重建。Redis 同步失败
不回滚已经提交的图片。词表修改无论正常返回还是写回执丢失，都在所属写入边界内使词表和列表
缓存失效，后续读取以数据库为准。

Ingestion 的 pair、version 与 execution token 隔离执行、重试和取消；队列 snapshot、SSE 与
批量动作使用同一 canonical。completed 回执需由 PostgreSQL 水合。浏览器只保留当前文档
拥有的卡片与有界 Server 页，不建立全队列 DTO 副本。协议见[队列分页与状态同步](ingestion.md#队列分页与状态同步)。

Redis 命令、投影和查询限制见[项目结构](project-structure.md)、[随机图 API](random-api.md)
与[数据库运行边界](database.md#运行期连接与公开回源)。检查页的深检和概览的即时内存测量
各有独立查询 owner，不把最近一次重建快照冒充当前占用。

### 图片字节

完整图键为 `full/<UUID 尾两位>/<UUID>.<ext>`，缩略图使用对应的 `thumbs` 键。
分类编辑只改 metadata 和必要投影；接入、迁移、删除与显式维护负责对象写入。
外部原图代理和随机图代理只返回字节，不创建图片记录。对象与临时素材协议见[存储](storage.md)。

## 一致性边界

- 图片位置操作先取得存储位置维护锁和单图锁，锁内重新读取 PostgreSQL。
  候选按冻结摘要验证，位置通过 CAS 提交，数据库确认后才清理源对象。
- Ingestion 写入正式候选前登记持久清理 guard。清理任务在同一单图锁内重新核对引用，
  结果未知时保留可核查的候选；不能根据页面报错判断事务回滚。
- 检查页显式维护取得独占位置锁并重新扫描。只读预览不作为删除依据；取消时先收口已经
  开始的工作，再释放锁。成功图片读取只读，缺失缩略图由维护入口补建。
- 已开始的 PostgreSQL 提交不因 Redis 断线或停机主动撤销。请求取消、worker 执行取消与
  不可逆事务结算由各自所有者处理，不借用超时或前端卡片推断完成。

具体交接见[图片接入](ingestion.md)、[存储](storage.md)和[后台任务](database.md)。

## 后台 Worker

| 持久任务 | 所属领域 | 工作 |
| --- | --- | --- |
| `move.cleanup` | storage | 删除确认未引用的候选或旧位置对象 |
| `trash.purge` | images | 按 `target_id` 处理单张回收站图片的彻底删除 |
| `cache.rebuild` | images/ready-cache | 重建图片核心投影 |

通用 jobs 层只拥有领取、execution token、续租、重试、公平调度与历史裁剪，各领域拥有 handler
和结果语义。不同类型分别取得有界时间片，慢任务不阻塞其他类型。handler 的不可逆工作在取得
所需锁后必须完成结算，停机等待实际工作与发现任务收尾。

永久删除在事务内为精确图片集合建立逐图意图；请求断开不撤销任务。目标仍存在的任务不能被
历史裁剪，检查页按数据库真值诊断并恢复异常任务。状态与保留规则见[数据库结构](database.md)。

Ingestion 另有一个单实例 Redis worker，不把会话复制进通用任务表。preparation、Normalize
和 commit 分别使用全进程中央准入，commit 同时受数量与固定字节预算限制。Import / Upload
保留各自有界 dispatch slot，通过 frozen-tail 游标补位。Redis 恢复后先恢复 canonical，
再领取新工作；独立孤儿清理周期在 Redis 不可用时停止删除素材。
执行时序与并发边界见[接管、prepare 与 commit](ingestion.md#接管prepare-与-commit)。

## 进程生命周期

启动依次装配部署与运行配置、初始化空库或核对非空库、初始化管理员与必要投影、启动 HTTP
和 Redis 监测。Redis 通过能力校验后才开放业务门并启动协调器及 Worker；CLI 不会因导入
HTTP 应用而启动主服务。

停机先停止接收请求和领取任务，再在统一期限内排空 HTTP、Worker、存储 driver、Redis 和
PostgreSQL；重复信号复用同一次收口。RuntimeConfig 的文件持久化和内存发布有唯一写入
所有者，详见[配置、缓存与 Worker 的交接](flows.md#配置缓存与-worker-的交接)。
