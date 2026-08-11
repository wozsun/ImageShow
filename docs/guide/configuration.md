# 配置说明

ImageShow 的配置按生效边界分为三类：部署环境变量、`/app/data/config.json`、
PostgreSQL。排查配置时先确认“这项配置由谁管理”，再判断修改后是否需要热加载
或重启。

## 配置来源

| 来源 | 保存内容 | 修改方式 |
| --- | --- | --- |
| 环境变量 | PostgreSQL / Redis 连接、宿主机端口映射，以及首次管理员凭据；也可在首次生成 `config.json` 时播种应用配置。 | 修改 `.env`、Compose 或 Secret 后重建 / 重启。部署字段在每次进程启动时读取，不写入 `config.json`。 |
| `/app/data/config.json` | 站点、上传 / 导入、图片处理、安全和日志等应用运行策略。 | 后台设置页，或直接编辑文件后在后台「设置 → 读取配置文件」。上传文件大小、上传长边校验和服务端全局导入并发只通过配置文件维护。 |
| PostgreSQL | 管理员账号及界面偏好；本地 / S3 存储后端注册表；S3 endpoint、region、bucket、access key、secret key、根目录、public URL 与连接 / 空闲 / 总时限等实例化数据。 | 后台设置页或对应管理界面。secret key 只保存，不返回给前端。 |

完整应用字段清单、默认值和中英文注释见仓库根目录的
`config.example.jsonc`；部署字段见 `.env.example`。实际运行配置文件是纯 JSON，
不支持注释。启动和手动重载时会按当前 schema 归一化：缺少且有默认值的字段
自动补齐，未知字段递归删除，已有有效值保留；归一化发生变化时写入同目录临时文件，
同步文件内容后原子替换完整配置，并在支持目录同步的平台持久化该 rename。只有已知
字段值不符合自身规定的合法范围时才会失败。PostgreSQL 与 Redis 连接值必须由环境
变量提供。归一化是长期的结构校验与自愈能力，不是版本兼容层：已删除字段或别名与其他
未知项一样被删除，对应现行字段按默认值补齐，不执行字段重命名迁移。

运行时配置模块本身不读取或写入文件。主进程在装配 HTTP 路由、注册配置变更监听器
和启动 Worker 前显式初始化进程内快照；初始化失败时不会继续连接数据库或监听端口。
Docker healthcheck 只读取并在内存中归一化已经存在的 `config.json`，缺失或非法时
直接失败并等待主进程恢复，不负责首次生成或写回。管理员密码恢复只依赖 PostgreSQL
和 Redis 部署配置，不初始化运行时配置。由此，单纯导入配置或 HTTP 应用模块不会
创建目录、写文件或启动服务。

管理端 `GET /api/admin/settings` 只返回设置页和图片工作流实际读取的最小字段集。
除设置页可编辑字段外，仅保留上传数量 / 文件大小、统一链接导入数量和页面
commit 并发等前端预检所需的只读值；不会返回部署配置、完整 `appConfig`、
服务端全局并发、外链抓取超时或其他内部默认值。`POST /api/admin/settings`
同样只接受设置页公开的可编辑字段，并以嵌套 patch 合并，未公开配置不会因保存
设置页而被默认值覆盖。`embed` 不进入普通后台设置的读取或保存 DTO，只通过
`data/config.json` 维护；公开站点配置仅返回前端路由实际消费的有效嵌入开关，
不返回来源列表。`site.domain`、`site.icon_url` 与
`site.home.enabled` 保留在运行时配置中，但不进入普通设置页及其读写 DTO；
`site.home.tagline` 同样只用于 HTML `description`。这些字段都需要通过配置文件
或高级配置维护。

设置页的「读取配置文件」与「保存应用配置」直接在各自按钮内显示进行中、成功或失败，
并预留最长状态文案宽度。进行态至少展示 500ms，结果保留三秒；成功状态不会阻止再次
点击。原始错误详情写入应用日志，页面只保留简短中文结果。

## 热加载边界

`config.json` 中的应用配置可在后台点击「读取配置文件」后生效。部署配置只在
进程启动时读取：`DATABASE_*` 和 `REDIS_*`。修改后需要重新创建或重启
应用容器；后台不会读取、展示或保存这些连接值。

应用在代码中固定监听容器内 `5518`，Docker healthcheck 与主进程共享该代码
常量，并从现有配置快照取得请求所需的站点 Host。宿主机映射端口只由
`HOST_PORT` 控制，不改变容器内监听端口。
自定义镜像如需改变内部端口，应修改 `appConfig.applicationPort`，并同步
Dockerfile 的 `EXPOSE` 与 Compose 目标端口；回归测试会校验三者保持一致。

`ADMIN_USERNAME` / `ADMIN_PASSWORD` 只在数据库没有 super 管理员时创建首个账号，最终写入 PostgreSQL 的 `admin_account` 表，不进入 `config.json`。初始化会先取得数据库 advisory lock 并检查已有 super，只有确实缺失时才要求这两个值；已有 super 时不会再读取环境变量覆盖账号或密码。

## 常用配置组

| 配置路径 | 用途 |
| --- | --- |
| `site.name` | 站点名称，也会写入 SPA HTML 的 `<title>`；可在普通站点配置页维护。 |
| `site.domain` / `site.icon_url` | 主域名和图标；域名仅允许 DNS 名称（开发环境可带端口），图标仅允许站内绝对路径或 HTTPS。两项只通过配置文件、高级配置或首次启动环境变量维护，不进入普通站点配置页及其读写 DTO。 |
| `site.version.enabled` / `site.version.link_enabled` | 是否显示后台版本卡片、是否链接到对应的 GitHub Release，默认均为 `true`。关闭链接后仍显示版本；两项只通过配置文件、高级配置或首次启动环境变量维护，不进入站点配置页，也不进入公开站点配置投影，只随已认证的会话探针返回。 |
| `site.root_redirect` | 根路径直接显示的页面：`home` 或 `gallery`；`/home`、`/gallery` 固定路径仍可单独访问。 |
| `site.home.enabled` | 是否启用公共首页 `/home`，默认 `true`。关闭后 `/home` 重定向到画廊，导航不再显示首页入口，根路径固定显示画廊；只通过配置文件、高级配置或首次启动环境变量维护。 |
| `site.home.tagline` | 站点描述，仅写入 SPA HTML 的 `description`，不在首页正文或普通站点配置页显示，只能通过配置文件、高级配置或首次启动环境变量维护。首页全屏背景固定使用站点自身的随机图 API。 |
| `site.gallery.default_limit` / `site.gallery.order` | 画廊默认分页数量与排序。 |
| `site.random_default_method` | `/random` 默认返回方式：`redirect`、`proxy` 或 `json`；默认 JSON 模式省略 `n` 时返回一项数组，批量仍须显式使用 `m=json&n=...`。 |
| `site.random_subdomain` / `site.static_subdomain` / `site.link_subdomain` | 保留子域名前缀。 |
| `site.robots_enabled` | 是否提供 `robots.txt`，默认 `false`。开启后主站首页可抓取，资源域禁抓。 |
| `embed.enabled` | 是否开放无主导航的 `/embed/home` 与 `/embed/gallery`，默认 `false`。启用后会根据当前 `site.domain` 隐式允许站点自身 HTTPS origin 及其任意层级的现有和未来子域，因此只应在这些子域均可信时开启；若站点域名带非默认端口，两项都只允许该端口。派生来源不写回配置文件。仅在 `data/config.json` 中维护。 |
| `embed.allowed_origins` | 除站点隐式来源外额外允许嵌入页面的 HTTPS 来源列表，可填写精确 origin 或形如 `https://*.example.com` 的子域通配符，最多 32 项且规范化后总长不超过 4096 字符；可以留空，重复隐式或显式来源会去除。通配符只允许出现在最左侧且不包含根域名，根域名须另列。拒绝 HTTP、IP 地址、路径、参数、凭据、裸 `*`、中间通配符和过宽的单标签后缀。通配符只能用于全部现有及未来子域均可信的自有父域；校验不内置 Public Suffix List，不得配置 `*.github.io` 等公共托管后缀。仅在 `data/config.json` 中维护。 |
| `upload.*` | 本地文件单次选择软上限、上传文件大小、图片长边限制、上传列表分页、单客户端上传队列并发，以及服务端 materialize / prepare 分阶段复用的全局并发；其中 `upload.max_items`、`upload.max_file_size_mb`、`upload.max_long_edge` 和 `upload.global_concurrency` 只在配置文件中维护。 |
| `upload.max_items` | 本地文件单次选择软上限，默认 200，可配置范围为 1–1000；只由前端限制，服务端仍逐文件创建会话，没有本地批次条目数硬上限。 |
| `link_image.fill_original_url` | URL 下载导入是否自动把输入 URL 填入「原图 URL」字段；不做可直达探测。 |
| `link_image.auto_import` | 链接、JSONL 清单或微博解析出有效图片且没有任何问题项时，是否省略二次确认并直接建立导入队列，默认 `true`；出现问题项时始终停留在解析结果页，由管理员确认是否导入有效部分。 |
| `link_image.concurrency` | 单客户端 URL 下载导入队列并发数。 |
| `link_image.global_concurrency` | 服务端 URL materialize 与 prepare 分阶段复用的全局并发数；只在配置文件中维护。 |
| `link_image.fetch_timeout_seconds` | 外链图片请求超时，单位秒；只覆盖 download 素材化的外部请求。 |
| `link_image.max_items` | URL 列表、JSONL 清单的单次条目软上限，默认 200；不在设置页展示，管理端只读返回该值供导入窗口预检，修改需编辑配置文件，可配置范围为 1–1000。微博导入不使用该限制。 |
| `weibo.max_items` | 微博链接单次输入软上限，默认 20；不在设置页展示，管理端只读返回该值供导入窗口预检，可配置范围为 1–50。 |
| `weibo.concurrency` | 服务端同时请求和解析的微博帖子数，默认 2，可配置范围为 1–16；空闲 worker 会持续补位，只在配置文件中维护。 |
| `weibo.global_concurrency` | 单个服务端进程共享的微博上游请求并发数，默认 5，可配置范围为 1–32；访客身份和帖子详情请求共用，只在配置文件中维护。 |
| `weibo.author_slugs` | 微博用户 ID 到作者 slug 的映射表。键必须是纯数字用户 ID，值必须是合法的小写 slug；微博导入只有命中映射时才填写作者。 |
| `normalize.*` | 本地上传与下载导入共用的最终入库文件标准化策略。 |
| `thumbnail.*` | 缩略图长边和压缩质量，只影响此后新生成的缩略图。 |
| `import.commit_concurrency` | 单个管理页面同时执行的 commit 数，默认 5；只在配置文件中维护，管理端只读返回。 |
| `import.global_commit_concurrency` | 单个服务端进程同时执行的 commit 数，默认 10；所有客户端和直接 API 请求共享，只在配置文件中维护。 |
| `import.global_commit_byte_budget_mb` | 单个服务端进程中处于 commit 的 prepared 图片与缩略图总字节预算，默认 512 MiB；与数量并发限制同时生效，只在配置文件中维护。 |
| `image_detail.title_opens_image` | 图片详情弹窗标题是否链接到图片直链。 |
| `admin.login_background` | 后台登录页背景，仅允许站内绝对路径或 HTTPS；留空时使用站点自身随机图。未认证登录页继承公开页面固定暗色上下文，不读取管理员外观偏好；登录成功并进入后台后才应用账号偏好。表单内容保持完全不透明，只有表面使用 alpha 0.20 的 `blur(6px) saturate(110%)` 毛玻璃，系统要求减少透明效果时回退为暗色实底。背景层固定于当前动态视口且完全不滚动，独立定位的卡片按 visual viewport 可见中线放置，在工具栏或软键盘压缩可见高度时通过快速过渡整体上移。 |
| `admin.image_page_size` / `admin.recent_uploads` / `admin.show_unset_theme_card` | 后台图片分页、概览最近上传数量、主题页「未设置」占位卡片开关。 |
| `background_job.*` | 后台任务并发：移动清理、删除主题时图片搬运、批量迁移存储拷贝。默认各 5。 |
| `security.*` | 登录会话有效期和登录限流阈值；ALTCHA 挑战签发复用两组时间窗口，单 IP 使用登录阈值的三倍，全局使用登录阈值的五倍。 |
| `altcha.*` | 自托管 ALTCHA 登录安全验证开关、挑战有效期和 PBKDF2 确定性工作量参数。 |
| `log.*` | 日志级别、单文件大小上限和轮转文件保留数量。日志写入 `data/log/app.log`，并同时输出到容器 stdout / stderr；超级管理员可在后台「日志」页实时调整 `log.level` 并查看最近日志。日志文件在列举或读取时消失会按轮转中的缺失处理，权限、I/O 等其他错误会明确返回失败，不伪装成空日志。后台非 GET 写操作会记录操作者、路径、状态、耗时和 IP，不记录请求体。 |

## 数值配置范围

除 `upload.max_file_size_mb` 和 `log.max_size_mb` 可使用小数外，下列数值字段都必须是整数。这里的默认值用于首次生成配置，并在启动或手动重载时补齐 `config.json` 中缺失的字段，不会覆盖已有有效值；高级配置编辑器和配置包仍要求提交当前完整 schema。

| 配置路径 | 默认值 | 合法范围 |
| --- | ---: | ---: |
| `site.gallery.default_limit` | 60 | 1–200 |
| `upload.max_items` | 200 | 1–1000 |
| `upload.max_file_size_mb` | 100 | 大于 0，最大 200 MiB |
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
| `import.global_commit_byte_budget_mb` | 512 | 16–4096 MiB |
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
与孤儿 raw 临时文件的安全清理年龄使用同一有效期，避免活跃会话被提前回收。取消
标记会在同代际执行者收口或会话删除时主动清除，该 TTL 只用于进程异常或 Redis
清理失败后的有界兜底。

后台 Worker 的 5 秒 tick、每种任务类型单次最多 50 项 / 2 秒的公平时间片、15 分钟
任务执行期限、10 秒停机排空期限、僵尸任务恢复周期和历史保留周期同样是应用生命周期
常量，不属于 `config.json`。停机排空的 10 秒是领取、handler、续租收口、终态写入和
当前 tick 共用的总期限，不会按任务或阶段重复计算。
`background_job.*` 只调整具体任务的并发 lane 数，不会取消时间片预算或让某一队列
长期独占 worker。

## 入库图片标准化

本地上传与 URL 下载共用顶层 `normalize` 配置。两者分别由浏览器上传和服务器下载完成 materialize，原始文件原子落到容器本地 `data/tmp` 后，prepare 才执行校验、缩略图和最终入库文件处理，并把候选文件写入选定存储后端。

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
    "auto_import": true,
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

输入本身是 WebP、体积小于 `normalize.skip_webp_under_kb` 且长边已经达标时，原字节直接成为最终候选文件；服务端仍会执行解码校验、标准缩略图生成和最终 MD5 计算。`upload.concurrency` / `link_image.concurrency` 只约束单个后台页面自己的 lane 数；任务进入 materialize 槽时才逐项创建服务端会话，队尾尚未进入 lane 的任务没有会话。每条 lane 在服务端权威状态确认当前项进入 `preparing` 后最多提前素材化一项，因此每条 lane 最多同时存在当前执行项和一个已启动的前瞻项，不会让长队列在处理前消耗 30 分钟会话租期。`upload.global_concurrency` / `link_image.global_concurrency` 分别由对应模式的 materialize 与 prepare 两个服务端阶段复用，每个阶段都有独立许可池。即使调用方绕过前端队列直接打接口，进程内也会排队并支持取消等待中的任务。

commit 使用独立的 `import.commit_concurrency` / `import.global_commit_concurrency`。前者限制单个后台页面，后者在取得会话 advisory lock、存储共享锁和数据库事务连接之前限制整个服务端进程。服务端还按 `import.global_commit_byte_budget_mb` 对 prepared 图片与缩略图大小做 FIFO 加权限流；活动权重始终按任务真实字节累计，不会在运行中随动态预算截断。超过预算的单个合法对象只能在当前没有其他 commit 占用时独立运行；预算升降后仍按真实活动总量决定是否放行队首。数量许可与字节许可都覆盖正式对象复制、数据库事务、暂存清理和缓存更新，而不只是 `INSERT`。PostgreSQL 主查询连接池上限为 30；长生命周期 advisory lock 使用另一个上限同为 30 的专用连接池，避免下载、转码和存储 I/O 持锁期间占满查询连接。commit 的存储共享锁、排序后的主题 / 作者 / 最终标签共享关联租约、会话锁和单图锁由同一专用连接按固定顺序取得，不会在锁池内嵌套等待第二条连接；同 slug commit 可以并行并在共享租约内幂等确保词表项存在，显式词表管理和删除使用的独占锁仍会等待全部关联租约退出。锁连接丢失会中止工作，导入发布另以数据库 execution token 栅栏旧执行者。公开 PostgreSQL 回源在主池内最多占 12 条连接，不再建立取消连接池；当前单应用实例最多保留 60 条应用连接，数据库 `max_connections` 应为该边界和运维连接留足空间。

URL 输入窗口、JSONL 解析和微博解析共享 3600 项通用安全边界；JSONL 与微博还在
服务端重复执行该边界。三者同时满足各自的可配置软上限：URL 与 JSONL 由
`link_image.max_items` 限制，最高 1000 项；
微博链接条数由 `weibo.max_items` 限制，最高 50 条。微博解析后的图片数不受
`link_image.max_items` 影响；按单条微博最多 18 张图片计算，合法配置最多产生
900 张图片，服务端另保留不可配置的 1000 张安全上限。输入或解析结果超过限制时
会在生成任务前明确拒绝，不自动拆成多个 `batch_time`。URL、JSONL 与微博都先在
浏览器形成有序任务，随后随 lane 推进逐项调用同一个会话创建接口；服务端不提供
批量会话创建入口。本地文件仅按 `upload.max_items` 做单次选择前端软限制；服务端
同样逐文件创建会话，不维护本地选择批次，因此没有对应的服务端条目数硬上限。

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

完整配置的格式化和重新读取直接显示在对应按钮内；校验成功由下一步确认窗口表示，
失败留在保存按钮。确认保存、配置包导出和配置包导入成功后关闭对应窗口，失败留在
确认按钮供重试。编辑器卡片头部的稳定区域只承载没有可见按钮时的首次读取或外部刷新
失败，不会压缩代码编辑区。字段级 slug 冲突与重命名校验仍紧邻对应输入框。

精准 schema 的完整说明不再占用编辑器卡片中的独立文案行，鼠标悬停“完整
config.json”标题时可查看；移动端同时隐藏页面头部的重复功能概述，为编辑器和操作按钮
保留稳定空间。操作失败仅显示简短中文提示，完整异常写入后台应用日志。

保存使用同目录临时文件；临时文件完成 `fsync` 后原子重命名，并在支持目录同步的
平台同步父目录，再替换内存配置并通知热加载监听器。这会同时防止进程中断造成半写
文件，并尽量保证突然掉电后仍保留已发布的新版本；最终持久性仍受底层文件系统和存储
硬件保证约束。`site.domain` 变化会提示当前访问地址可能失效。完整配置接口和响应均
禁止缓存，且仅允许 super 管理员访问。

### 版本化配置包

super 管理员可在「设置 → 高级配置」导出或导入版本化 JSON 配置包。当前
格式为 `imageshow-config` 版本 3，`application_version` 仅用于识别导出来源；
导入只接受格式、版本和完整 schema 均匹配的当前配置包。配置包最大 1 MiB，单包最多
包含 100 个自定义存储后端。

版本 3 的预览和正式导入共用同一个严格解析入口。缺少字段、未知字段、类型错误和
越界值均会拒绝；导出的结构始终包含当前完整字段。

配置包用于把可迁移的站点行为和存储连接复制到新实例：

- `config` 包含站点展示、上传 / 导入、图片处理、后台、安全验证和日志
  等运行时配置，但排除 `site.domain`。监听端口由目标版本的代码固定，
  PostgreSQL / Redis 连接由目标实例自己的环境变量提供；三者均不进入配置包。
- `storage_backends` 包含自定义 S3 后端的显示名、slug、启停状态、
  默认状态、顺序和完整连接配置。内置 `local` 不导出。
- 管理员账号、图片及其标签 / 主题 / 作者、导入会话、后台任务和 Redis
  缓存不属于配置包。
- ALTCHA 的 HMAC 主密钥在首次签发挑战时随机生成并仅驻留进程内存，不属于配置项
  或配置包；应用重启后，重启前尚未提交的证明需要重新验证。
  当前单应用实例在每次重启后生成新的主密钥，因此重启前的未提交证明自然失效。

导出的 S3 Secret Key 是恢复连接所必需的，因此会以明文
出现在文件中。点击导出按钮后必须先确认敏感凭据提示；导出响应禁止缓存，但
下载后的文件仍应按敏感凭据保管，使用后及时移出共享下载目录。导入按钮选择
文件并完成服务端预检后，会在模态窗口中展示摘要、待新增后端和 slug 重命名。

导入前会先进行只读预检。不存在的 slug 会新增；若某个 slug 已存在，必须为
导入后端指定新的合法 slug。系统不会覆盖、合并或跳过同名后端，改名后的 slug
也不能是 `local`、现有 slug 或同一批中的另一个目标。应用时再次检查当前注册表，
以防预检之后发生竞态。全部存储后端在同一数据库事务内写入，该事务与导入 advisory
lock 使用同一 PostgreSQL 会话。进程内所有运行时配置写入共用一条写租约；配置包导入
会持有租约直到数据库结果确认与补偿结束，普通错误会回滚数据库事务，并以本次写入的
精确 revision 恢复旧快照。提交回包不确定时会用事务自身的 xid8 receipt 查询
PostgreSQL 提交状态，不根据可能已被后继修改的业务行猜测；无法确认则保留候选配置
供管理员核对。

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
| `REDIS_HOST` / `REDIS_PORT` / `REDIS_DB` / `REDIS_PASSWORD` | 每次启动时建立 Redis 8 连接，并检查运行所需命令；内置 Redis 不设置密码，只有连接启用了认证的外部 Redis 时才填写可选密码。 |
| `SITE_DOMAIN` | 首次生成配置文件时播种 `site.domain`，默认 `example.com`。 |
| `HOST_PORT` | 映射到容器内固定 `5518` 的宿主机端口，默认 `5518`。 |
| `TZ` | 无偏移本地图片时间的解析时区，默认 `UTC`。 |

本地开发或自动化测试可用 `IMAGESHOW_DEVELOPMENT_DATA_DIRECTORY` 将配置、存储、
临时文件和日志整体指向一次性隔离目录，避免测试触碰仓库的真实 `data/`。该变量在
`NODE_ENV=production` 时被忽略，生产容器的数据目录仍固定为 `/app/data`。

除上述部署字段外，支持环境变量播种的应用配置统一按完整路径转成大写下划线，
例如：

| 配置字段 | 环境变量 |
| --- | --- |
| `site.domain` | `SITE_DOMAIN` |
| `site.version.enabled` | `SITE_VERSION_ENABLED` |
| `site.version.link_enabled` | `SITE_VERSION_LINK_ENABLED` |
| `site.robots_enabled` | `SITE_ROBOTS_ENABLED` |
| `site.home.enabled` | `SITE_HOME_ENABLED` |
| `site.home.tagline` | `SITE_HOME_TAGLINE` |
| `admin.login_background` | `ADMIN_LOGIN_BACKGROUND` |
| `normalize.quality_step` | `NORMALIZE_QUALITY_STEP` |
| `thumbnail.long_edge` | `THUMBNAIL_LONG_EDGE` |
| `thumbnail.quality` | `THUMBNAIL_QUALITY` |
| `import.commit_concurrency` | `IMPORT_COMMIT_CONCURRENCY` |
| `import.global_commit_concurrency` | `IMPORT_GLOBAL_COMMIT_CONCURRENCY` |
| `import.global_commit_byte_budget_mb` | `IMPORT_GLOBAL_COMMIT_BYTE_BUDGET_MB` |
| `upload.max_items` | `UPLOAD_MAX_ITEMS` |
| `upload.max_file_size_mb` | `UPLOAD_MAX_FILE_SIZE_MB` |
| `upload.max_long_edge` | `UPLOAD_MAX_LONG_EDGE` |
| `upload.concurrency` | `UPLOAD_CONCURRENCY` |
| `upload.global_concurrency` | `UPLOAD_GLOBAL_CONCURRENCY` |
| `link_image.concurrency` | `LINK_IMAGE_CONCURRENCY` |
| `link_image.auto_import` | `LINK_IMAGE_AUTO_IMPORT` |
| `link_image.global_concurrency` | `LINK_IMAGE_GLOBAL_CONCURRENCY` |
| `link_image.fetch_timeout_seconds` | `LINK_IMAGE_FETCH_TIMEOUT_SECONDS` |
| `link_image.max_items` | `LINK_IMAGE_MAX_ITEMS` |
| `weibo.max_items` | `WEIBO_MAX_ITEMS` |
| `weibo.concurrency` | `WEIBO_CONCURRENCY` |
| `weibo.global_concurrency` | `WEIBO_GLOBAL_CONCURRENCY` |

部署字段在每次进程启动时读取；缺失必需的数据库环境变量会直接拒绝启动。
应用配置的环境变量仍只在首次生成 `config.json` 时播种，文件存在后不会覆盖已有
值，请直接修改 `config.json` 并热加载。
