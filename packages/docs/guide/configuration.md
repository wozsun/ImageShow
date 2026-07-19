# 配置说明

ImageShow 的配置按生效边界分为三类：部署环境变量、`/app/data/config.json`、
PostgreSQL。排查配置时先确认“这项配置由谁管理”，再判断修改后是否需要热加载
或重启。

## 配置来源

| 来源 | 保存内容 | 修改方式 |
| --- | --- | --- |
| 环境变量 | PostgreSQL / Redis 连接、宿主机端口映射，以及首次管理员凭据；也可在首次生成 `config.json` 时播种应用配置。 | 修改 `.env`、Compose 或 Secret 后重建 / 重启。部署字段在每次进程启动时读取，不写入 `config.json`。 |
| `/app/data/config.json` | 站点、上传 / 导入、图片处理、安全和日志等应用运行策略。 | 后台设置页，或直接编辑文件后在后台「设置 → 读取配置文件」。上传文件大小、上传长边校验和服务端全局导入并发只通过配置文件维护。 |
| PostgreSQL | 管理员账号；本地 / S3 / WebDAV 存储后端注册表；S3 endpoint、region、bucket、access key、secret key、根目录、public URL 等敏感或实例化数据。 | 后台设置页。secret key 只保存，不返回给前端。 |

完整应用字段清单、默认值和中英文注释见仓库根目录的
`config.example.jsonc`；部署字段见 `.env.example`。实际运行配置文件是纯 JSON，
不支持注释。启动和手动重载时会按当前 schema 归一化：缺少且有默认值的字段
自动补齐，未知字段递归删除，已有有效值保留；归一化发生变化时原子写回完整
配置。PostgreSQL 与 Redis 连接值必须由环境变量提供。

管理端 `GET /api/admin/settings` 只返回设置页和图片工作流实际读取的最小字段集。
除设置页可编辑字段外，仅保留上传数量 / 文件大小、统一链接导入数量和页面
commit 并发等前端预检所需的只读值；不会返回部署配置、完整 `appConfig`、
服务端全局并发、外链抓取超时或其他内部默认值。`POST /api/admin/settings`
同样只接受设置页公开的可编辑字段，并以嵌套 patch 合并，未公开配置不会因保存
设置页而被默认值覆盖。

## 热加载边界

`config.json` 中的应用配置可在后台点击「读取配置文件」后生效。部署配置只在
进程启动时读取：`DATABASE_*` 和 `REDIS_*`。修改后需要重新创建或重启
应用容器；后台不会读取、展示或保存这些连接值。

应用在代码中固定监听容器内 `5518`，Docker healthcheck 与主进程共享该代码
常量。宿主机映射端口只由 `HOST_PORT` 控制，不改变容器内监听端口。
自定义镜像如需改变内部端口，应修改 `appConfig.applicationPort`，并同步
Dockerfile 的 `EXPOSE` 与 Compose 目标端口；回归测试会校验三者保持一致。

`ADMIN_USERNAME` / `ADMIN_PASSWORD` 只在数据库没有 super 管理员时创建首个账号，最终写入 PostgreSQL 的 `admin_account` 表，不进入 `config.json`。初始化会先取得数据库 advisory lock 并检查已有 super，只有确实缺失时才要求这两个值；已有 super 时不会再读取环境变量覆盖账号或密码。

## 常用配置组

| 配置路径 | 用途 |
| --- | --- |
| `site.name` / `site.domain` / `site.icon_url` | 站点名称、主域名和图标；域名仅允许 DNS 名称（开发环境可带端口），图标仅允许站内绝对路径或 HTTPS，`site.name` 也会写入 SPA HTML 的 `<title>`。 |
| `site.root_redirect` | 根路径直接显示的页面：`home` 或 `gallery`；`/home`、`/gallery` 固定路径仍可单独访问。 |
| `site.home.enabled` | 是否启用公共首页 `/home`，默认 `true`。关闭后 `/home` 重定向到画廊，导航不再显示首页入口，根路径固定显示画廊。 |
| `site.home.tagline` / `site.home.hero_background` / `site.home.preview_delay_ms` | 站点描述、首页 hero 背景与随机预览切换延迟；背景仅允许站内绝对路径或 HTTPS，`site.home.tagline` 也会写入 SPA HTML 的 description。 |
| `site.gallery.default_limit` / `site.gallery.order` | 画廊默认分页数量与排序。 |
| `site.random_default_method` | `/random` 默认返回方式：`redirect` 或 `proxy`。 |
| `site.random_subdomain` / `site.static_subdomain` / `site.docs_subdomain` / `site.link_subdomain` | 保留子域名前缀。 |
| `site.docs_enabled` | 是否启用 `docs.<域名>` 文档站，默认 `true`。关闭后该主机返回 404，但前缀仍保留，主题不可占用。 |
| `site.robots_enabled` | 是否提供 `robots.txt`，默认 `false`。开启后主站首页与文档站可抓取，资源域和主题域禁抓。 |
| `upload.*` | 本地文件单次选择软上限、上传文件大小、图片长边限制、上传列表分页、单客户端上传队列并发与服务端全局上传 prepare 并发；其中 `upload.max_items`、`upload.max_file_size_mb`、`upload.max_long_edge` 和 `upload.global_concurrency` 只在配置文件中维护。 |
| `upload.max_items` | 本地文件单次选择软上限，默认 200，可配置范围为 1–1000；只由前端限制，服务端仍逐文件创建会话，没有本地批次条目数硬上限。 |
| `link_image.fill_original_url` | 两种链接导入模式是否自动把输入 URL 填入「原图 URL」字段；不做可直达探测。 |
| `link_image.concurrency` | 单客户端 URL 导入队列并发数，覆盖“下载保存”和“代理链接”。 |
| `link_image.global_concurrency` | 服务端 URL 导入 prepare 全局并发数，多个客户端共享；只在配置文件中维护。 |
| `link_image.fetch_timeout_seconds` | 外链图片请求超时，单位秒；只覆盖下载和代理准备阶段的外部请求。 |
| `link_image.max_items` | URL 列表、JSONL 清单的单次条目软上限，默认 200；不在设置页展示，管理端只读返回该值供导入窗口预检，修改需编辑配置文件，可配置范围为 1–1000。微博导入不使用该限制。 |
| `weibo.max_items` | 微博链接单次输入软上限，默认 20；不在设置页展示，管理端只读返回该值供导入窗口预检，可配置范围为 1–50。 |
| `weibo.concurrency` | 服务端同时请求和解析的微博帖子数，默认 2，可配置范围为 1–16；空闲 worker 会持续补位，只在配置文件中维护。 |
| `weibo.global_concurrency` | 单个服务端进程共享的微博上游请求并发数，默认 5，可配置范围为 1–32；访客身份和帖子详情请求共用，只在配置文件中维护。 |
| `weibo.author_slugs` | 微博用户 ID 到作者 slug 的映射表。键必须是纯数字用户 ID，值必须是合法的小写 slug；微博导入只有命中映射时才填写作者。 |
| `normalize.*` | 本地上传与下载导入共用的最终入库文件标准化策略。 |
| `thumbnail.*` | 缩略图长边和压缩质量，只影响此后新生成的缩略图。 |
| `import.commit_concurrency` | 单个管理页面同时执行的 commit 数，默认 5；只在配置文件中维护，管理端只读返回。 |
| `import.global_commit_concurrency` | 单个服务端进程同时执行的 commit 数，默认 10；所有客户端和直接 API 请求共享，只在配置文件中维护。 |
| `image_detail.title_opens_image` | 图片详情弹窗标题是否链接到图片直链。 |
| `admin.login_background` | 后台登录页背景，仅允许站内绝对路径或 HTTPS；留空时使用站点自身随机图。 |
| `admin.image_page_size` / `admin.recent_uploads` / `admin.show_unset_theme_card` | 后台图片分页、概览最近上传数量、主题页「未设置」占位卡片开关。 |
| `background_job.*` | 后台任务并发：移动清理、删除主题时图片搬运、批量迁移存储拷贝。默认各 5。 |
| `security.*` | 登录会话有效期和登录限流阈值；ALTCHA 挑战签发复用两组时间窗口，单 IP 使用登录阈值的三倍，全局使用登录阈值的五倍。 |
| `altcha.*` | 自托管 ALTCHA 登录安全验证开关、挑战有效期和 PBKDF2 确定性工作量参数。 |
| `log.*` | 日志级别、单文件大小上限和轮转文件保留数量。日志写入 `data/log/app.log`，并同时输出到容器 stdout / stderr；超级管理员可在后台「日志」页实时调整 `log.level` 并查看最近日志。后台非 GET 写操作会记录操作者、路径、状态、耗时和 IP，不记录请求体。 |

## 数值配置范围

除 `upload.max_file_size_mb` 和 `log.max_size_mb` 可使用小数外，下列数值字段都必须是整数。这里的默认值用于首次生成配置或补齐缺失字段，不会覆盖已有配置文件中的有效值。

| 配置路径 | 默认值 | 合法范围 |
| --- | ---: | ---: |
| `site.home.preview_delay_ms` | 1000 | 0–10000 ms |
| `site.gallery.default_limit` | 60 | 1–200 |
| `upload.max_items` | 200 | 1–1000 |
| `upload.max_file_size_mb` | 100 | 大于 0，最大 500 MiB |
| `upload.max_long_edge` | 32000 | 512–32768 px |
| `upload.list_page_size` | 20 | 1–100 |
| `upload.concurrency` | 2 | 1–128 |
| `upload.global_concurrency` | 5 | 1–512 |
| `link_image.concurrency` | 2 | 1–128 |
| `link_image.global_concurrency` | 5 | 1–512 |
| `link_image.fetch_timeout_seconds` | 30 | 5–300 秒 |
| `link_image.max_items` | 200 | 1–1000 |
| `weibo.max_items` | 20 | 1–50 |
| `weibo.concurrency` | 2 | 1–16 |
| `weibo.global_concurrency` | 5 | 1–32 |
| `normalize.quality` | 80 | 1–100 |
| `normalize.quality_step` | 5 | 1–50 |
| `normalize.min_quality` | 20 | 1–100，且不能高于 `quality` |
| `normalize.max_long_edge` | 4500 | 512–32768 px |
| `normalize.max_size_kb` | 500 | 50–102400 KiB |
| `normalize.skip_webp_under_kb` | 700 | 0–102400 KiB |
| `thumbnail.long_edge` | 512 | 64–4096 px |
| `thumbnail.quality` | 75 | 1–100 |
| `import.commit_concurrency` | 5 | 1–128 |
| `import.global_commit_concurrency` | 10 | 1–512 |
| `admin.image_page_size` | 60 | 10–200 |
| `admin.recent_uploads` | 12 | 1–50 |
| `background_job.move_cleanup_concurrency` | 5 | 1–512 |
| `background_job.theme_reassign_concurrency` | 5 | 1–512 |
| `background_job.migrate_concurrency` | 5 | 1–512 |
| `security.session_ttl_seconds` | 604800 | 300–31536000 秒 |
| `security.login_failure_window_seconds` | 60 | 30–300 秒 |
| `security.login_max_failures` | 5 | 3–500 |
| `security.login_global_window_seconds` | 180 | 60–600 秒 |
| `security.login_global_max_attempts` | 10 | 5–1000 |
| `altcha.ttl_seconds` | 300 | 90–3600 秒 |
| `altcha.cost` | 5000 | 1000–100000 |
| `altcha.counter_min` | 2000 | 100–100000，且不能高于 `counter_max` |
| `altcha.counter_max` | 5000 | 100–100000，且 `cost × counter_max` 不能超过 100000000 |
| `log.max_size_mb` | 10 | 大于 0，最大 1024 MiB |
| `log.max_files` | 5 | 1–100 |

导入会话的空闲有效期固定为 30 分钟，是应用代码生命周期常量，不属于
`config.json`。创建会话后，接收、排队、prepare 和 commit 会持续续租；取消标记
与孤儿 raw 临时文件的安全清理年龄使用同一有效期，避免活跃会话被提前回收。

## 入库图片标准化

本地上传与「下载图片」共用顶层 `normalize` 配置。原始文件先落到容器本地 `data/tmp`，服务端完成校验、缩略图和最终入库文件处理后，才把候选文件写入选定存储后端。代理链接不保存原图，只保存缩略图与外部 URL。

```json
{
  "upload": {
    "max_items": 200,
    "max_file_size_mb": 100,
    "max_long_edge": 32000,
    "concurrency": 2,
    "global_concurrency": 5
  },
  "link_image": {
    "fill_original_url": false,
    "concurrency": 2,
    "global_concurrency": 5,
    "fetch_timeout_seconds": 30,
    "max_items": 200
  },
  "weibo": {
    "max_items": 20,
    "concurrency": 2,
    "global_concurrency": 5,
    "author_slugs": {
      "1234567890": "example-author"
    }
  },
  "normalize": {
    "quality": 80,
    "quality_step": 5,
    "min_quality": 20,
    "max_long_edge": 4500,
    "max_size_kb": 500,
    "skip_webp_under_kb": 700
  }
}
```

`normalize.quality` 是首次 WebP 编码质量。输出超过 `normalize.max_size_kb` 时，会按超限倍数放大 `normalize.quality_step` 降低质量，最大不超过 `3 * quality_step`。某轮达标后会按原步进向上回补探测，最多补回本轮跳过的质量档位，尽量避免一次跳过可用画质。最低降到 `normalize.min_quality`；到达最低质量后即使仍超出目标体积，也会直接入库。尺寸会按比例缩小到 `normalize.max_long_edge` 以内，不会放大。

输入本身是 WebP、体积小于 `normalize.skip_webp_under_kb` 且长边已经达标时，原字节直接成为最终候选文件；服务端仍会执行解码校验、标准缩略图生成和最终 MD5 计算。`upload.concurrency` / `link_image.concurrency` 只约束单个后台页面自己的队列；`upload.global_concurrency` / `link_image.global_concurrency` 约束服务端 prepare 全局并发，即使调用方绕过前端队列直接打接口，进程内也会排队并支持取消等待中的任务。

commit 使用独立的 `import.commit_concurrency` / `import.global_commit_concurrency`。前者限制单个后台页面，后者在取得会话 advisory lock、存储共享锁和数据库事务连接之前限制整个服务端进程。该许可覆盖正式对象复制、数据库事务、暂存清理和缓存更新，而不只是 `INSERT`。PostgreSQL 应用连接池上限为 30。

URL、JSONL 与微博的批量解析/会话创建接口有 3600 项服务端硬上限，并同时满足
各自的可配置软上限：URL 与 JSONL 由 `link_image.max_items` 限制，最高 1000 项；
微博链接条数由 `weibo.max_items` 限制，最高 50 条。微博解析后的图片数不受
`link_image.max_items` 影响；按单条微博最多 18 张图片计算，合法配置最多产生
900 张图片，服务端另保留不可配置的 1000 张安全上限。超过限制会在创建会话前
明确拒绝，不自动拆成多个 `batch_time`。本地文件仅按 `upload.max_items` 做单次选择前端软限制；
服务端逐文件创建会话，不维护本地选择批次，因此没有对应的服务端条目数硬上限。

## 高级配置

### 完整配置编辑

super 管理员可在「设置 → 高级配置」直接查看和编辑当前实例的完整
`data/config.json`。编辑器只包含应用运行策略，不包含代码中固定的监听端口或
由环境变量管理的 PostgreSQL / Redis 连接值；它与下方用于跨实例迁移的配置包范围仍有
`site.domain` 等差异。

“格式化”只在浏览器内重新缩进 JSON；“重新读取”会在存在未保存修改时要求确认；
“保存配置”先由服务端按完整运行时 schema 严格预检，再显示实际风险并要求确认。
完整编辑采用精准 schema，缺少字段、未知字段、类型错误或越界值都会拒绝保存，
不会执行启动时的默认值补齐或未知字段删除。

保存使用临时文件和原子重命名，写入成功后替换内存配置并通知热加载
监听器。`site.domain` 变化会提示当前访问地址可能失效。完整配置接口和响应均
禁止缓存，且仅允许 super 管理员访问。

### 版本化配置包

super 管理员可在「设置 → 高级配置」导出或导入版本化 JSON 配置包。当前
格式为 `imageshow-config` 版本 2，`application_version` 仅用于识别导出来源；
是否兼容由包格式及其版本决定。配置包最大 1 MiB，单包最多包含 100 个
自定义存储后端。

配置包用于把可迁移的站点行为和存储连接复制到新实例：

- `config` 包含站点展示、上传 / 导入、图片处理、后台、安全验证和日志
  等运行时配置，但排除 `site.domain`。监听端口由目标版本的代码固定，
  PostgreSQL / Redis 连接由目标实例自己的环境变量提供；三者均不进入配置包。
- `storage_backends` 包含自定义 S3 / WebDAV 后端的显示名、slug、启停状态、
  默认状态、顺序和完整连接配置。内置 `local` 不导出。
- 管理员账号、图片及其标签 / 主题 / 作者、导入会话、后台任务和 Redis
  缓存不属于配置包。
- ALTCHA 的 HMAC 主密钥在首次签发挑战时随机生成并仅驻留进程内存，不属于配置项
  或配置包；应用重启后，重启前尚未提交的证明需要重新验证。
  当前生产边界为单应用实例；不同实例会生成不同主密钥，因此在提供共享部署
  Secret 前不能让多个应用副本共同承接登录请求。

导出的 S3 Secret Key 和 WebDAV 密码是可恢复连接所必需的，因此会以明文
出现在文件中。点击导出按钮后必须先确认敏感凭据提示；导出响应禁止缓存，但
下载后的文件仍应按敏感凭据保管，使用后及时移出共享下载目录。导入按钮选择
文件并完成服务端预检后，会在模态窗口中展示摘要、待新增后端和 slug 重命名。

导入前会先进行只读预检。不存在的 slug 会新增；若某个 slug 已存在，必须为
导入后端指定新的合法 slug。系统不会覆盖、合并或跳过同名后端，改名后的 slug
也不能是 `local`、现有 slug 或同一批中的另一个目标。应用时再次检查当前注册表，
以防预检之后发生竞态。全部存储后端在同一数据库事务内写入。普通配置文件写入、
数据库查询或事务提交错误会恢复导入前的运行时配置，并回滚数据库事务。

配置文件与 PostgreSQL 是两个独立资源，无法组成真正的跨资源原子事务。若在配置
文件写入后遭遇 SIGKILL、容器崩溃或主机断电，仍存在配置已更新而数据库事务已回滚
的极小不一致窗口。此时需人工恢复导入前的 `config.json`，或确认当前后端注册表后
重新导入配置包。

## 环境变量

`compose.yaml` 默认使用或向容器注入以下变量：

| 环境变量 | 用途 |
| --- | --- |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | 数据库没有 super 时初始化首个管理员账号。 |
| `DATABASE_HOST` / `DATABASE_PORT` / `DATABASE_NAME` / `DATABASE_USER` / `DATABASE_PASSWORD` | 每次启动时建立 PostgreSQL 连接；Compose 同时用 name、user、password 初始化 PostgreSQL 容器。 |
| `REDIS_HOST` / `REDIS_PORT` / `REDIS_DB` / `REDIS_PASSWORD` | 每次启动时建立 Redis 连接；内置 Redis 不设置密码，只有连接启用了认证的外部 Redis 时才填写可选密码。 |
| `SITE_DOMAIN` | 首次生成配置文件时播种 `site.domain`，默认 `example.com`。 |
| `HOST_PORT` | 映射到容器内固定 `5518` 的宿主机端口，默认 `5518`。 |
| `TZ` | 无偏移本地图片时间的解析时区，默认 `UTC`。 |

除上述部署字段外，支持环境变量播种的应用配置统一按完整路径转成大写下划线，
例如：

| 配置字段 | 环境变量 |
| --- | --- |
| `site.domain` | `SITE_DOMAIN` |
| `site.docs_enabled` | `SITE_DOCS_ENABLED` |
| `site.robots_enabled` | `SITE_ROBOTS_ENABLED` |
| `site.home.tagline` | `SITE_HOME_TAGLINE` |
| `site.home.preview_delay_ms` | `SITE_HOME_PREVIEW_DELAY_MS` |
| `admin.login_background` | `ADMIN_LOGIN_BACKGROUND` |
| `normalize.quality_step` | `NORMALIZE_QUALITY_STEP` |
| `thumbnail.long_edge` | `THUMBNAIL_LONG_EDGE` |
| `thumbnail.quality` | `THUMBNAIL_QUALITY` |
| `import.commit_concurrency` | `IMPORT_COMMIT_CONCURRENCY` |
| `import.global_commit_concurrency` | `IMPORT_GLOBAL_COMMIT_CONCURRENCY` |
| `upload.max_items` | `UPLOAD_MAX_ITEMS` |
| `upload.max_file_size_mb` | `UPLOAD_MAX_FILE_SIZE_MB` |
| `upload.max_long_edge` | `UPLOAD_MAX_LONG_EDGE` |
| `upload.concurrency` | `UPLOAD_CONCURRENCY` |
| `upload.global_concurrency` | `UPLOAD_GLOBAL_CONCURRENCY` |
| `link_image.concurrency` | `LINK_IMAGE_CONCURRENCY` |
| `link_image.global_concurrency` | `LINK_IMAGE_GLOBAL_CONCURRENCY` |
| `link_image.fetch_timeout_seconds` | `LINK_IMAGE_FETCH_TIMEOUT_SECONDS` |
| `link_image.max_items` | `LINK_IMAGE_MAX_ITEMS` |
| `weibo.max_items` | `WEIBO_MAX_ITEMS` |
| `weibo.concurrency` | `WEIBO_CONCURRENCY` |
| `weibo.global_concurrency` | `WEIBO_GLOBAL_CONCURRENCY` |

部署字段在每次进程启动时读取；缺失必需的数据库环境变量会直接拒绝启动。
应用配置的环境变量仍只在首次生成 `config.json` 时播种，文件存在后不会覆盖已有
值，请直接修改 `config.json` 并热加载。
