# ImageShow

[![Publish Release](https://github.com/wozsun/ImageShow/actions/workflows/publish-release.yml/badge.svg)](https://github.com/wozsun/ImageShow/actions/workflows/publish-release.yml)

ImageShow 是面向个人服务器的自托管图片画廊、随机图 API 与轻量后台管理服务。项目由
Node.js 26 / Hono、React 19、PostgreSQL、Redis 8 和 Docker 构成。

## 功能

- 公开首页、瀑布流画廊、图片详情与可选无导航嵌入页；画廊卡片使用标题或 UUID 短标识，
  并直接展示服务端返回的主题 / 标签显示名副标题；长画廊使用有界 DTO / DOM 窗口，远页按
  keyset cursor 恢复。移动端首页目录显示约 8 行半主题、7 行半标签和 6 行半作者选项，以
  露出的半行提示还可继续滚动；桌面端目录尺寸保持不变。后台图库、无主题与回收站则由
  服务端按数字页直达，不在浏览器补齐前序 cursor 边界。公开与后台详情中的当前展示图保留
  浏览器原生右键与长按保存能力；公开详情可选“原图”按钮只打开另行登记的独立原图，两者
  互不替代。
- 主站 `/random` 随机图 API，以及集中承载本地媒体、缩略图和外链原图直连决策 / 代理的
  `static.*` 资源子域；已解析随机池在一次只读 Redis 原子调用内完成校验、抽样和 rich item
  读取，近期去重与最终排序仍由应用负责；不提供随机、外链或主题专用子域。
- 后台图片上传、URL / JSONL / 微博导入、编辑、分类、回收站、日志与运行状态检查；本地上传
  使用一次有界 Upload intent POST 加逐文件 raw PUT，Import 来源一次批量 accept 后由单实例 Redis
  worker 接管。页面上传窗口、Server raw、Upload / Import 共用的 prepare / staging、全部 Sharp
  normalize 与最终 commit 各有唯一准入 owner；prepare / staging 和 Import 后继窗口均由 normalize
  容量派生，前者限制持有处理后 Buffer 直至 `_uploads` 和 ready 发布，后者只预取下一批 raw。
  微博帖子元数据请求全进程串行，复用一个访客身份并在相邻请求间随机等待 2–5 秒，解析后的图片
  进入同一后继窗口。
  `import.keep_original_link` 可分别决定 URL、JSONL 与微博导入是否把下载 URL 保留为公开原图链接，
  `weibo.source_enabled` 独立决定新解析的微博图片是否填写帖子来源页；两项都不影响素材下载与入库。
  Upload、Import 与直接 API 共用 `ingestion.*` 的原图体积、长边和队列分页边界，页面预检不替代
  Server 权威校验。Upload / Import 的默认标签和逐图标签都使用固定单行可视窗口；按需覆盖的
  22px 圆角边缘按钮、标签框内独占的鼠标滚轮、触控板原生横向手势和移动端拖动可浏览全部已选
  标签，不改变工作流纵向布局。逐图原图 / 来源 URL 只在失焦时执行共享的 HTTPS 格式解析；
  无效编辑不进入草稿同步，也不显示界面提示或状态，真正的远端图片下载与外链代理继续由
  Server 独立安全校验。
  异步提交只冻结意图并以 PostgreSQL 图片行
  确认完成；相同最终内容在提交边界
  串行确认，单项重复冲突不会中断同一批的其他图片，确认后复用该项已锁定的提交意图继续；
  Upload / Import 队列按当前管理员分别用一个 SSE 和有界分页快照同步；展示保持新批次置顶、
  同批来源顺序 1→N，并在窗口重开和跨页后保持稳定。重连只废止旧动作权威，当前页继续稳定
  展示直至新快照原位替换；实时 completed 直接复用提交事务生成的 PostgreSQL 投影，窗口恢复时
  再按页批量水合；全队列提交、默认值和清理
  使用预冻结签名 watermark 与有界 continuation，HTTP 接管到状态通道之间以独立 revision
  围栏和点击时精确 pair 集合关闭动作缺口；当前文档在窗口生命周期内保留新建批次的来源
  顺序，业务权威仍逐项立即转交 Server，窗口重开后才完全使用 Server display；重复详情按
  当前页 MD5 批量读取 PostgreSQL；单项取消以 `discarded` 的精确队列 revision 立即释放卡片和
  统计，页界收缩时先原子夹紧当前页，再用一次权威快照证明，旧分页基线不会把已移除项重新
  插回列表；另一窗口已经退休的当前文档 pair 会在快照中精确返回 stale，缺失 canonical 的
  有界集合只批量反查一次 display 投影，不随 stale 数量重复扫描整条队列；
  “导入图片”主按钮与下拉按钮共享内容接入工作流和来源输入模块的意图预载，成功启动后保持
  页面交互锁直到工作流关闭，避免来源弹窗开启时背景状态闪烁；完成事件按提交批次合并刷新
  图库投影，关闭窗口默认只清理当时已经完成的卡片与 Redis 回执，未完成任务继续保留。
- local 与多个 S3 兼容对象存储后端并存；支持单图、批量和整后端迁移，以及检查页显式
  预览、确认后执行的存储维修与孤儿清理。单实例后台还会按固定周期回收超过保守年龄门槛、
  且不再被 Redis canonical 精确引用的 raw、`.part` 与 `_uploads` generation；Redis 异常、
  存储列表不完整或键代际无法解析时保守保留。正式候选在复制前登记持久清理 guard，只有
  PostgreSQL 未引用时才会回收。业务清理与永久删除统一使用 provider 中性 1…N 契约；S3 / COS 原生
  `DeleteObjects` 每批最多 1000 个 key，业务清理与永久删除生产者固定共享一个活动调用，
  并逐对象确认结果。
- 成功提交的图片以正式缩略图为不变量；正常读取严格只读，缺图显示统一损坏图标并由
  检查页“存储维护”显式修复。数据库已记录有效缩略图时，维修会先确认现有对象；记录为
  未采用时直接校验原图并生成，再在发布前复核当前位置和缩略图，避免无消费者的远端探测。
- PostgreSQL 保存全部业务真值，Redis 只承载会话、限流、统一就绪图片投影与可重建缓存。
- 后台概览只对固定核心图片投影键执行准确内存测量，不扫描键空间；卡片可见副标题只保留
  占用大小与同步状态，来源和测量时间留在 hover 详情。检查页先以固定成本展示图片投影
  数量、revision 与重建时间，再自动执行一次有界 Redis 深检，扫描当前 ImageShow 键空间
  并汇总核心 / 派生占用；手动 Redis 检查复用同一查询。
- 图片管理员与超级管理员使用集中权限矩阵；高风险接口在服务端独立鉴权。
- 管理员偏好跨端同步，公开页面固定暗色，后台可选亮色、暗色或跟随设备。
- 超级管理员可导出固定格式的完整配置包；导入时由目标版本逐项采用可识别值，缺失或错误值
  使用当前默认值，未知字段与无法安全识别的存储后端独立跳过，不维护跨版本迁移链。
- 单应用实例、可信反向代理和容器健康检查组成当前生产边界。

完整行为见[维护文档](docs/README.md)，随机接口见
[随机图 API 指南](docs/guide/random-api.md)。

## 快速开始

仓库根目录的 `compose.yaml` 用于本地体验、开发和干净安装验证，包含 PostgreSQL 与
Redis。Docker 部署不需要宿主机安装 Node.js；只有源码开发时需要 Node.js
`>=26.3.0 <27`。

### 配置

默认 `compose.yaml` 不提供数据库密码或首个 super 管理员密码。首次启动前先复制环境变量
模板，并为 `DATABASE_PASSWORD` 与 `ADMIN_PASSWORD` 分别设置非空密码；任一变量未设置或
为空时，Compose 会在展开阶段直接失败：

```bash
cp .env.example .env
```

`.env.example` 是完整环境变量目录，但 `.env` 只作为 Compose 插值来源。默认
`compose.yaml` 的 ImageShow 环境前部只保留空数据启动必要值：与 PostgreSQL 共享的数据库
名、用户名和密码，以及首次管理员用户名和密码，共五项。其他部署覆盖和全部 RuntimeConfig
seed 均不会因出现在 `.env` 而自动进入容器。需要填写的前五项为：

```ini
DATABASE_NAME=imageshow
DATABASE_USER=imageshow
DATABASE_PASSWORD=
ADMIN_USERNAME=admin
ADMIN_PASSWORD=                   # 8–128 位且同时包含字母和数字
```

两个密码没有默认值，应使用不同的随机强密码。`ADMIN_*` 只在数据库尚无 super 管理员时使用，
不会覆盖已有账号。数据库身份每次启动都由默认 Compose 注入；内置拓扑的数据库 host / port、
Redis 连接和时区使用代码默认值。外部拓扑需要在 Compose override 中逐项映射对应变量。其他
应用配置保存在 `data/config.json`，完整字段见
[配置说明](docs/guide/configuration.md#runtimeconfig-参数目录)。当前根页面字段为
`site.root`，对应首次播种变量 `SITE_ROOT`；`SITE_DOMAIN`、`SITE_DESCRIPTION` 和其他 seed 一样，
只有显式扩展 `services.imageshow.environment` 后才参与空目录首次生成。
配置包的导出、目标版本宽松识别、敏感凭据与冲突重命名边界见
[配置说明中的配置包章节](docs/guide/configuration.md#配置包)。

### 启动

```bash
docker compose pull
docker compose up -d
```

首次登录后台时，用户名默认为 `admin`，密码使用 `.env` 中设置的 `ADMIN_PASSWORD`。

Linux bind mount 用户应先确保镜像用户 UID/GID `1000` 可写数据目录：

```bash
sudo install -d -o 1000 -g 1000 data
```

默认 Compose 固定把 `127.0.0.1:5518` 映射到容器内 `5518`；需要其他宿主端口或绑定地址时
使用 `compose.override.yaml`、其他部署清单或 `docker run -p [host-ip:]<host-port>:5518`。
配置域名后可访问：

- `https://img.example.com/home`
- `https://img.example.com/gallery`
- `https://img.example.com/admin`
- `https://img.example.com/random`

本地正式图片和配置位于 `./data`，PostgreSQL 和 Redis 使用各自 Docker volume。Redis volume
只提供尽力而为的重启保留，不承诺未完全入库内容不可丢失；派生状态可从 PostgreSQL 重建。
内置 PostgreSQL 默认不向宿主发布端口；需要直连时使用：

```bash
docker compose exec postgresql sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
```

## 数据库基线

`schema.sql` 完整定义当前干净安装的单一基线；镜像仍保留
`schema-additions.sql` 作为当前发布周期的注释占位，并为以后经明确审查的受限增量或一次性
数据变化保留固定入口。空数据库在同一事务中执行基线与占位文件，非空数据库执行占位文件后
进入只读 readiness；当前结构完全由基线定义，readiness 只核对运行时实际依赖的最小契约。
`metadata.created_by TEXT NOT NULL` 已直接属于干净安装基线。additions 只承载一个发布周期：
全部受控非空数据库应用其中增量并通过 readiness 后，下一发布移除一次性语句并恢复注释占位。
部署和备份恢复按相邻发布顺序应用 additions；破坏性结构整理由维护者在停机、备份和恢复验证后
单独执行。应用的自动结构职责限定为干净初始化、单周期 additions 和最小 readiness。精确契约见
[数据库结构](docs/guide/database.md#启动与结构契约)。

Redis 是必需的 operational datastore，但不是业务真相源；服务 unavailable 或命令 OOM 时，
Ingestion 会话、写入和 worker 均 fail closed，不回退到 PostgreSQL 或进程内队列。停应用后把
已确认专供 ImageShow 的 logical database 清为空库是受支持冷启动：管理员重新登录，未完成
内容接入任务允许消失，派生状态从 PostgreSQL 重建。运行中清空或局部缺失 canonical / owner /
metadata 结构不受支持，受影响队列会 fail closed 并要求停机处理。连接必须支持 Redis 8 以及
项目使用的
`INCREX`、`ARRING`、`ARLASTITEMS`、`SET ... IFEQ ... KEEPTTL` 与
`DELEX ... IFEQ` 能力；应用启动时会实际验证成功、条件失败、缺失、TTL 语义和 ACL 权限。

## 生产部署

当前生产拓扑只支持一个 ImageShow 应用实例；Compose 或部署平台必须保证不会并行启动第二个
连接同一数据库的应用进程，应用不实现多实例互斥、接管或跨进程一致性。应用应只监听回环或
私有网络，由可信反向代理终止 HTTPS，并覆盖客户端传入的 `Host`、`X-Real-IP`、
`X-Forwarded-For` 与 `X-Forwarded-Proto`；应用不解析转发 Host 或多级 IP 链。
产品无关的代理要求与唯一一份可替换的 Nginx 最简示例见[部署指南](docs/guide/deployment.md#反向代理与-https)。

反向代理请求体上限不得低于应用配置。仓库示例使用 `client_max_body_size 256m`，覆盖
最高可配置的 200 MiB 单图上限并留出代理层余量。完整 Docker、健康检查、停机、密码恢复及
Nginx 配置见[生产部署指南](docs/guide/deployment.md)。

## 开发与验证

```bash
npm ci
npm run check
npm run build
npm run knip
npm run verify:release
```

`verify:release` 是完整本地发布门禁，依次覆盖源码契约、生产构建、最终测试和隔离生产
镜像。门禁实现和 benchmarks 位于本地、Git 忽略的 `tests/`；上传后的 GitHub Actions
只负责生产容器构建、镜像发布和 GitHub Release，不代替本地验收。

常用独立门禁：

- `npm run verify:source`：只读源码、依赖方向和静态契约。
- `npm run verify:build`：生产构建及产物边界。
- `npm run verify:runtime`：最终测试及隔离镜像运行验收。
- `npm run test:final:web`：当前 Web 最终测试。

## 文档索引

按身份进入：

- [普通用户](docs/guide/roles/ordinary-user.md)
- [图片管理员](docs/guide/roles/image-admin.md)
- [超级管理员](docs/guide/roles/super-admin.md)
- [实例维护者](docs/guide/roles/instance-maintainer.md)

技术参考：

- [架构总览](docs/guide/architecture.md)、[项目结构](docs/guide/project-structure.md)
- [配置说明](docs/guide/configuration.md)、[数据库结构](docs/guide/database.md)、
  [存储](docs/guide/storage.md)、[安全](docs/guide/security.md)
- [功能与流程](docs/guide/flows.md)、[随机图 API](docs/guide/random-api.md)、
  [生产部署](docs/guide/deployment.md)

完整导航见[文档首页](docs/README.md)。

## 许可

见 [LICENSE](LICENSE)。
