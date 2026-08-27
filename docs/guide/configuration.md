# 配置说明

ImageShow 的配置按生效边界分为三类：部署环境变量、`/app/data/config.json`、
PostgreSQL。排查配置时先确认“这项配置由谁管理”，再判断修改后是否需要热加载
或重启。

## 配置来源

| 来源 | 保存内容 | 修改方式 |
| --- | --- | --- |
| 环境变量 | PostgreSQL / Redis 连接、时区与首次管理员凭据；也可在首次生成 `config.json` 时播种应用配置。 | 修改 `.env`、宿主环境或 Compose 映射后重建 / 重启。`.env` 只是 Compose 插值来源，只有部署清单显式映射的值才会进入容器。部署字段在每次进程启动时读取，不写入 `config.json`。 |
| `/app/data/config.json` | 站点、上传 / 导入、图片处理、安全和日志等应用运行策略。 | 后台设置页，或直接编辑文件后在后台「设置 → 读取配置文件」。上传文件大小、上传长边校验和服务端全局导入并发只通过配置文件维护。 |
| PostgreSQL | 管理员账号及界面偏好；本地 / S3 存储后端注册表；S3 endpoint、region、bucket、access key、secret key、根目录、public URL 与连接 / 空闲 / 总时限等实例化数据。 | 后台设置页或对应管理界面。secret key 只保存，不返回给前端。 |

本页的 [RuntimeConfig 参数目录](#runtimeconfig-参数目录)是完整应用字段参考；仓库根目录
`.env.example` 同时列出部署变量与全部首次播种变量。实际运行配置文件是纯 JSON，不支持
注释。启动和手动重载时会按当前 schema 归一化：缺少且有默认值的字段
自动补齐，未知字段递归删除，已有有效值保留；归一化发生变化时写入同目录临时文件，
同步文件内容后原子替换完整配置，并在支持目录同步的平台持久化该 rename。只有已知
字段值不符合自身规定的合法范围时才会失败。PostgreSQL 与 Redis 连接值必须由环境
变量提供。归一化是长期的结构校验与自愈能力，不是版本迁移框架。其中一项有界投影会把
`link_image` 远程来源段投影到 `import`，把含 commit 字段的 `import` 段投影到
`ingestion`；目标分组已经存在时以目标值为准，归一化结果只写回现行结构。其他未知项按普通
结构投影删除，对应现行字段按默认值补齐，不推测字段含义。

### 从 5.1.2 升级

5.2.0 把 `site.root_redirect` 改为 `site.root`，不迁移旧值，也没有别名、双读或版本投影。
旧字段会按未知字段删除；缺少合法 `site.root` 时补当前默认值 `home`。新旧字段同时存在时
只保留合法的新字段。升级前若要继续以画廊作为根页面，应先把配置改为
`"site": { "root": "gallery" }`；`/home`、`/gallery` 与 `site.home.enabled` 的职责不变。
同时移除 `image_detail.title_opens_image` 与 `IMAGE_DETAIL_TITLE_OPENS_IMAGE`；旧配置分组
按未知字段删除，图片详情标题固定打开该图片的直链。
`site.random_default_method` 不再接受 `json`，升级前应改为 `proxy` 或 `redirect`；JSON 返回
仍可通过显式 `/random?m=json` 使用。`site.home.banner_title` 上限由 160 收紧为 80 字符，
超长现有值需先缩短。
首次播种布尔环境值仅接受 `true` / `false`，不再接受 `1` / `0`。
`upload.max_long_edge` 的合法范围由 512–32768 px 调整为 300–32000 px；现行默认值
`32000` 不变，超过新上限的现有值需先收紧。

运行时配置模块本身不读取或写入文件。主进程在装配 HTTP 路由、注册配置变更监听器
和启动 Worker 前显式初始化进程内快照；初始化失败时不会继续连接数据库或监听端口。
Docker healthcheck 只读取并在内存中归一化已经存在的 `config.json`，缺失或非法时
直接失败并等待主进程恢复，不负责首次生成或写回。管理员密码恢复只依赖 PostgreSQL
和 Redis 部署配置，不初始化运行时配置。由此，单纯导入配置或 HTTP 应用模块不会
创建目录、写文件或启动服务。

管理端 `GET /api/admin/settings` 只返回设置页和图片工作流实际读取的最小字段集。
除设置页可编辑字段外，仅保留上传数量 / 文件大小、Import 数量和页面
commit 并发等前端预检所需的只读值；不会返回部署配置、完整 `appConfig`、
服务端全局并发、外链抓取超时或其他内部默认值。`POST /api/admin/settings`
同样只接受设置页公开的可编辑字段，并以嵌套 patch 合并，未公开配置不会因保存
设置页而被默认值覆盖。`embed` 不进入普通后台设置的读取或保存 DTO，只通过
`data/config.json` 维护；公开站点配置仅返回前端路由实际消费的有效嵌入开关，
不返回来源列表，并额外返回由 `site.domain` 与 `site.static_subdomain` 派生的
`site.static_url`，供详情原图按钮直接进入资源域。`site.domain`、`site.description`、`site.icon_url` 与
`site.home.enabled` 保留在运行时配置中，但不进入普通设置页及其读写 DTO；
其中 `site.description` 只用于 HTML `description`。这些字段都需要通过配置文件
或高级配置维护；公开站点配置投影会返回描述，供 SPA 路由切换后维护同一 meta。

设置页的「读取配置文件」与「保存应用配置」直接在各自按钮内显示进行中、成功或失败，
并预留最长状态文案宽度。进行态至少展示 500ms，结果保留三秒；成功状态不会阻止再次
点击。原始错误详情写入应用日志，页面只保留简短中文结果。

## 热加载边界

`config.json` 中的应用配置可在后台点击「读取配置文件」后生效。部署配置只在
进程启动时读取：`DATABASE_*` 和 `REDIS_*`。修改后需要重新创建或重启
应用容器；后台不会读取、展示或保存这些连接值。

应用在代码中固定监听容器内 `5518`，Docker healthcheck 与主进程共享该代码
常量，并从现有配置快照取得请求所需的站点 Host。仓库 Compose 固定使用
`127.0.0.1:5518:5518`，不提供宿主端口环境变量；只有容器化代理或明确的同机私有网络
拓扑才应通过 `compose.override.yaml`、其他部署清单或
`docker run -p [host-ip:]<host-port>:5518` 覆盖映射，同时仍须阻止不可信客户端直达应用端口。
自定义镜像如需改变内部端口，应修改 `appConfig.applicationPort`，并同步
Dockerfile 的 `EXPOSE` 与 Compose 目标端口；回归测试会校验三者保持一致。

`ADMIN_USERNAME` / `ADMIN_PASSWORD` 只在数据库没有 super 管理员时创建首个账号，最终写入
PostgreSQL 的 `admin_account` 表，不进入 `config.json`。单应用进程初始化直接检查已有 super，
只有确实缺失时才要求这两个值；已有 super 时不会再读取环境变量覆盖账号或密码。顺序重启和
崩溃后的顺序恢复受支持，两个应用进程重叠播种不受支持。

后台配置写入由同一进程内的 FIFO 写租约串行化，包括配置包导入的长 I/O 和补偿窗口；配置包的
存储后端写入使用 PostgreSQL 事务、提交结果回执和运行时配置 revision 补偿。

## RuntimeConfig 参数目录

下表是 `data/config.json` 的完整叶子参数参考，也是 `.env.example` 的播种目录。环境变量仅在
文件不存在时参与一次完整配置生成；已有文件的启动、重启、普通设置、高级配置、配置包和手动
重载都不再读取或叠加 seed。默认 Compose 不注入任何 RuntimeConfig 变量；表内全部标为“显式
映射”，表示变量虽然列在 `.env.example`，但只有部署者扩展 Compose 后才会进入容器。所有现行配置都可
经高级配置保存或手动重载热生效；普通设置页只开放其中的非敏感常用子集。数值除明确注明外
均为整数，布尔环境值只接受 `true`、`false`。

### site

| 配置路径 / 环境变量 / 注入 | 类型、默认值与合法值 | 用途、运行阶段与生效 |
| --- | --- | --- |
| <!-- runtime-config:site.name --> `site.name` / `SITE_NAME` / 显式映射 | 字符串；默认 `"ImageShow"`；去空白后非空 | 页面标题、导航和后台站点名；普通设置或热加载后影响后续响应。 |
| <!-- runtime-config:site.domain --> `site.domain` / `SITE_DOMAIN` / 显式映射 | 字符串；默认 `"example.com"`；1–259 字符的 DNS 域名，可带 1–65535 端口 | 主站 Host 与资源域派生；首次播种或热加载后影响新请求，域名变化可能使当前地址失效。 |
| <!-- runtime-config:site.description --> `site.description` / `SITE_DESCRIPTION` / 显式映射 | 字符串；默认 `"画廊与随机图片API"`；去空白后 0–200 字符 | SPA `description`；空值回退到站点名，首次播种或热加载后影响新 HTML。 |
| <!-- runtime-config:site.icon_url --> `site.icon_url` / `SITE_ICON_URL` / 显式映射 | 字符串；默认 `"/assets/brand/favicon.svg"`；1–2048 字符的站内绝对路径或 HTTPS URL | 站点图标；首次播种或热加载后影响公开配置。 |
| <!-- runtime-config:site.version.enabled --> `site.version.enabled` / `SITE_VERSION_ENABLED` / 显式映射 | 布尔；默认 `true` | 控制后台版本卡片；首次播种或热加载后影响已认证会话探针。 |
| <!-- runtime-config:site.version.link_enabled --> `site.version.link_enabled` / `SITE_VERSION_LINK_ENABLED` / 显式映射 | 布尔；默认 `true` | 控制版本卡片是否链接 Release；首次播种或热加载后影响会话探针。 |
| <!-- runtime-config:site.root --> `site.root` / `SITE_ROOT` / 显式映射 | 枚举；默认 `"home"`；`home`、`gallery` | 选择 `/` 显示首页或画廊；`/home`、`/gallery` 固定路径不变，普通设置或热加载后影响导航。 |
| <!-- runtime-config:site.home.enabled --> `site.home.enabled` / `SITE_HOME_ENABLED` / 显式映射 | 布尔；默认 `true` | 关闭后 `/home` 与根入口都回退画廊；首次播种或热加载后影响新请求。 |
| <!-- runtime-config:site.home.background --> `site.home.background` / `SITE_HOME_BACKGROUND` / 显式映射 | 字符串；默认 `""`；空值或最长 2048 字符的站内绝对路径 / HTTPS URL | 首页背景；空值使用 `/random`，普通设置或热加载后生效。 |
| <!-- runtime-config:site.home.banner_label --> `site.home.banner_label` / `SITE_HOME_BANNER_LABEL` / 显式映射 | 字符串；默认 `"ImageShow · A FAN-MADE PHOTO HANDBOOK"`；1–160 字符 | 首页 Banner 标识；普通设置或热加载后生效。 |
| <!-- runtime-config:site.home.banner_title --> `site.home.banner_title` / `SITE_HOME_BANNER_TITLE` / 显式映射 | 字符串；默认 `"我们一起，\n收藏这些瞬间。"`；1–80 字符，可换行 | 首页 Banner 标题；普通设置或热加载后生效。 |
| <!-- runtime-config:site.gallery.default_limit --> `site.gallery.default_limit` / `SITE_GALLERY_DEFAULT_LIMIT` / 显式映射 | 整数；默认 `60`；1–200 项 | 公开画廊默认分页量；普通设置或热加载后影响新查询。 |
| <!-- runtime-config:site.gallery.order --> `site.gallery.order` / `SITE_GALLERY_ORDER` / 显式映射 | 枚举；默认 `"random"`；`latest`、`random` | 画廊默认排序；普通设置或热加载后影响新查询。 |
| <!-- runtime-config:site.random_default_method --> `site.random_default_method` / `SITE_RANDOM_DEFAULT_METHOD` / 显式映射 | 枚举；默认 `"redirect"`；`proxy`、`redirect` | `/random` 未指定模式时的图片返回方式；`json` 仅可作为显式 `m=json` 查询参数，普通设置或热加载后影响新请求。 |
| <!-- runtime-config:site.static_subdomain --> `site.static_subdomain` / `SITE_STATIC_SUBDOMAIN` / 显式映射 | 字符串；默认 `"static"`；1–63 字符的合法小写 DNS label | `/media`、`/thumbs`、`/link/original` 的资源子域；首次播种或热加载后影响 Host 路由。 |
| <!-- runtime-config:site.robots_enabled --> `site.robots_enabled` / `SITE_ROBOTS_ENABLED` / 显式映射 | 布尔；默认 `false` | 控制主站与资源域 `robots.txt`；首次播种或热加载后影响新请求。 |

### embed

| 配置路径 / 环境变量 / 注入 | 类型、默认值与合法值 | 用途、运行阶段与生效 |
| --- | --- | --- |
| <!-- runtime-config:embed.enabled --> `embed.enabled` / `EMBED_ENABLED` / 显式映射 | 布尔；默认 `false` | 开放 `/embed/home` 与 `/embed/gallery`，并隐式允许当前站点 HTTPS 来源；首次播种或热加载后生效。 |
| <!-- runtime-config:embed.allowed_origins --> `embed.allowed_origins` / `EMBED_ALLOWED_ORIGINS` / 显式映射 | 严格 JSON 数组；默认 `[]`；最多 32 个 HTTPS DNS origin，每项不超过 320 字符且总长不超过 4096 字符 | 增加精确来源或最左侧 `*.` 子域来源；规范化去重并拒绝 HTTP、IP、路径和凭据。schema 不含 Public Suffix List，部署者须避免为公共托管后缀配置通配，热加载后影响 CSP。 |

### ingestion

| 配置路径 / 环境变量 / 注入 | 类型、默认值与合法值 | 用途、运行阶段与生效 |
| --- | --- | --- |
| <!-- runtime-config:ingestion.commit_concurrency --> `ingestion.commit_concurrency` / `INGESTION_COMMIT_CONCURRENCY` / 显式映射 | 整数；默认 `5`；1–128 | 单页面 commit 并发；热加载后影响后续提交准入。 |
| <!-- runtime-config:ingestion.global_commit_concurrency --> `ingestion.global_commit_concurrency` / `INGESTION_GLOBAL_COMMIT_CONCURRENCY` / 显式映射 | 整数；默认 `10`；1–512 | 单进程 commit 数量准入；热加载后影响后续提交。 |
| <!-- runtime-config:ingestion.global_commit_byte_budget_mb --> `ingestion.global_commit_byte_budget_mb` / `INGESTION_GLOBAL_COMMIT_BYTE_BUDGET_MB` / 显式映射 | 整数；默认 `512`；16–4096 MiB | prepared 图片与缩略图的加权字节预算；热加载后按真实活动重量调整后续准入。 |

### upload、import 与 weibo

| 配置路径 / 环境变量 / 注入 | 类型、默认值与合法值 | 用途、运行阶段与生效 |
| --- | --- | --- |
| <!-- runtime-config:upload.max_items --> `upload.max_items` / `UPLOAD_MAX_ITEMS` / 显式映射 | 整数；默认 `200`；1–1000 项 | 文件选择与 intent 批次软上限；首次播种或热加载后影响新接入。 |
| <!-- runtime-config:upload.max_file_size_mb --> `upload.max_file_size_mb` / `UPLOAD_MAX_FILE_SIZE_MB` / 显式映射 | 数值；默认 `100`；大于 0 且不超过 200 MiB | 单个 raw 文件体积上限；首次播种或热加载后影响新上传。 |
| <!-- runtime-config:upload.max_long_edge --> `upload.max_long_edge` / `UPLOAD_MAX_LONG_EDGE` / 显式映射 | 整数；默认 `32000`；300–32000 px | 原图长边准入上限；首次播种或热加载后影响新上传。 |
| <!-- runtime-config:upload.list_page_size --> `upload.list_page_size` / `UPLOAD_LIST_PAGE_SIZE` / 显式映射 | 整数；默认 `20`；1–100 项 | 上传与批量编辑列表分页；普通设置或热加载后生效。 |
| <!-- runtime-config:upload.concurrency --> `upload.concurrency` / `UPLOAD_CONCURRENCY` / 显式映射 | 整数；默认 `2`；1–128 | 单页面 raw PUT 并发与 intent lane；普通设置或热加载后影响新调度。 |
| <!-- runtime-config:upload.global_concurrency --> `upload.global_concurrency` / `UPLOAD_GLOBAL_CONCURRENCY` / 显式映射 | 整数；默认 `5`；1–512 | 服务端 Upload materialize / prepare 全局基数；热加载后调整后续准入。 |
| <!-- runtime-config:import.fill_original_url --> `import.fill_original_url` / `IMPORT_FILL_ORIGINAL_URL` / 显式映射 | 布尔；默认 `true` | URL 导入是否填充原图 URL，不做可达探测；普通设置或热加载后影响新解析。 |
| <!-- runtime-config:import.auto_import --> `import.auto_import` / `IMPORT_AUTO_IMPORT` / 显式映射 | 布尔；默认 `true` | 无问题项时是否直接建立 Import 队列；普通设置或热加载后影响新解析。 |
| <!-- runtime-config:import.concurrency --> `import.concurrency` / `IMPORT_CONCURRENCY` / 显式映射 | 整数；默认 `2`；1–128 | 单页面 Import 来源队列并发；普通设置或热加载后影响新调度。 |
| <!-- runtime-config:import.global_concurrency --> `import.global_concurrency` / `IMPORT_GLOBAL_CONCURRENCY` / 显式映射 | 整数；默认 `5`；1–512 | 服务端 URL download 与 prepare 的全局基数；热加载后调整后续准入。 |
| <!-- runtime-config:import.fetch_timeout_seconds --> `import.fetch_timeout_seconds` / `IMPORT_FETCH_TIMEOUT_SECONDS` / 显式映射 | 整数；默认 `30`；5–300 秒 | 外链 download 请求期限；热加载后影响新请求。 |
| <!-- runtime-config:import.max_items --> `import.max_items` / `IMPORT_MAX_ITEMS` / 显式映射 | 整数；默认 `200`；1–1000 项 | URL / JSONL 单次软上限，不限制微博图片数；热加载后影响新解析。 |
| <!-- runtime-config:weibo.max_items --> `weibo.max_items` / `WEIBO_MAX_ITEMS` / 显式映射 | 整数；默认 `20`；1–50 条 | 单次微博链接软上限；热加载后影响新解析。 |
| <!-- runtime-config:weibo.concurrency --> `weibo.concurrency` / `WEIBO_CONCURRENCY` / 显式映射 | 整数；默认 `2`；1–16 | 同时请求和解析的微博数；热加载后影响后续补位。 |
| <!-- runtime-config:weibo.global_concurrency --> `weibo.global_concurrency` / `WEIBO_GLOBAL_CONCURRENCY` / 显式映射 | 整数；默认 `5`；1–32 | 单进程共享的微博上游请求并发；热加载后影响后续准入。 |
| <!-- runtime-config:weibo.author_slugs --> `weibo.author_slugs` / `WEIBO_AUTHOR_SLUGS` / 显式映射 | 严格 JSON 对象；默认 `{}`；键为 1–20 位非零开头数字 ID，值为 1–32 字符合法小写 slug | 命中时给微博图片填充作者；重复 JSON 键或非法成员直接拒绝首次生成，热加载后影响新解析。 |

### normalize 与 thumbnail

| 配置路径 / 环境变量 / 注入 | 类型、默认值与合法值 | 用途、运行阶段与生效 |
| --- | --- | --- |
| <!-- runtime-config:normalize.quality --> `normalize.quality` / `NORMALIZE_QUALITY` / 显式映射 | 整数；默认 `80`；1–100 | 新图片 WebP 首次编码质量；普通设置或热加载后影响新 prepare。 |
| <!-- runtime-config:normalize.quality_step --> `normalize.quality_step` / `NORMALIZE_QUALITY_STEP` / 显式映射 | 整数；默认 `5`；1–50 | 超体积后的质量递减步长；普通设置或热加载后影响新 prepare。 |
| <!-- runtime-config:normalize.min_quality --> `normalize.min_quality` / `NORMALIZE_MIN_QUALITY` / 显式映射 | 整数；默认 `20`；1–100，且不高于 `normalize.quality` | 转码最低质量；普通设置或热加载后影响新 prepare。 |
| <!-- runtime-config:normalize.max_long_edge --> `normalize.max_long_edge` / `NORMALIZE_MAX_LONG_EDGE` / 显式映射 | 整数；默认 `4500`；512–32768 px | 入库成品长边上限，不放大；普通设置或热加载后影响新 prepare。 |
| <!-- runtime-config:normalize.max_size_kb --> `normalize.max_size_kb` / `NORMALIZE_MAX_SIZE_KB` / 显式映射 | 整数；默认 `500`；50–102400 KiB | 入库成品目标体积；普通设置或热加载后影响新 prepare。 |
| <!-- runtime-config:normalize.skip_webp_under_kb --> `normalize.skip_webp_under_kb` / `NORMALIZE_SKIP_WEBP_UNDER_KB` / 显式映射 | 整数；默认 `700`；0–102400 KiB | 合法 WebP 原字节保留阈值；普通设置或热加载后影响新 prepare。 |
| <!-- runtime-config:thumbnail.long_edge --> `thumbnail.long_edge` / `THUMBNAIL_LONG_EDGE` / 显式映射 | 整数；默认 `512`；64–4096 px | 新缩略图长边；普通设置或热加载后影响新生成，不重做旧图。 |
| <!-- runtime-config:thumbnail.quality --> `thumbnail.quality` / `THUMBNAIL_QUALITY` / 显式映射 | 整数；默认 `75`；1–100 | 新缩略图质量；普通设置或热加载后影响新生成。 |

### admin、background_job、security、altcha 与 log

| 配置路径 / 环境变量 / 注入 | 类型、默认值与合法值 | 用途、运行阶段与生效 |
| --- | --- | --- |
| <!-- runtime-config:admin.login_background --> `admin.login_background` / `ADMIN_LOGIN_BACKGROUND` / 显式映射 | 字符串；默认 `""`；空值或最长 2048 字符的站内绝对路径 / HTTPS URL | 登录背景，空值使用站点 `/random`；普通设置或热加载后影响新登录页。 |
| <!-- runtime-config:admin.image_page_size --> `admin.image_page_size` / `ADMIN_IMAGE_PAGE_SIZE` / 显式映射 | 整数；默认 `60`；10–200 项 | 后台图片数字分页量；普通设置或热加载后影响新查询。 |
| <!-- runtime-config:admin.recent_uploads --> `admin.recent_uploads` / `ADMIN_RECENT_UPLOADS` / 显式映射 | 整数；默认 `12`；1–50 项 | 概览最近上传数量；普通设置或热加载后影响新查询。 |
| <!-- runtime-config:admin.show_unset_theme_card --> `admin.show_unset_theme_card` / `ADMIN_SHOW_UNSET_THEME_CARD` / 显式映射 | 布尔；默认 `true` | 主题页未设置卡片；普通设置或热加载后影响新渲染。 |
| <!-- runtime-config:background_job.move_cleanup_concurrency --> `background_job.move_cleanup_concurrency` / `BACKGROUND_JOB_MOVE_CLEANUP_CONCURRENCY` / 显式映射 | 整数；默认 `5`；1–512 | `move.cleanup` lane 并发；热加载后影响后续任务调度。 |
| <!-- runtime-config:background_job.theme_reassign_concurrency --> `background_job.theme_reassign_concurrency` / `BACKGROUND_JOB_THEME_REASSIGN_CONCURRENCY` / 显式映射 | 整数；默认 `5`；1–512 | 删除主题时重分配 lane；热加载后影响后续任务调度。 |
| <!-- runtime-config:background_job.migrate_concurrency --> `background_job.migrate_concurrency` / `BACKGROUND_JOB_MIGRATE_CONCURRENCY` / 显式映射 | 整数；默认 `5`；1–512 | 整后端迁移拷贝 lane；热加载后影响后续任务调度。 |
| <!-- runtime-config:security.session_ttl_seconds --> `security.session_ttl_seconds` / `SECURITY_SESSION_TTL_SECONDS` / 显式映射 | 整数；默认 `604800`；300–31536000 秒 | 新登录会话有效期；热加载后影响新建 / 续发会话。 |
| <!-- runtime-config:security.login_failure_window_seconds --> `security.login_failure_window_seconds` / `SECURITY_LOGIN_FAILURE_WINDOW_SECONDS` / 显式映射 | 整数；默认 `60`；30–300 秒 | 单来源失败统计窗口；热加载后影响后续登录与挑战。 |
| <!-- runtime-config:security.login_max_failures --> `security.login_max_failures` / `SECURITY_LOGIN_MAX_FAILURES` / 显式映射 | 整数；默认 `5`；3–500 次 | 单来源失败阈值；热加载后影响后续登录与挑战。 |
| <!-- runtime-config:security.login_global_window_seconds --> `security.login_global_window_seconds` / `SECURITY_LOGIN_GLOBAL_WINDOW_SECONDS` / 显式映射 | 整数；默认 `180`；60–600 秒 | 全局登录窗口；热加载后影响后续登录与挑战。 |
| <!-- runtime-config:security.login_global_max_attempts --> `security.login_global_max_attempts` / `SECURITY_LOGIN_GLOBAL_MAX_ATTEMPTS` / 显式映射 | 整数；默认 `10`；5–1000 次 | 全局尝试阈值；热加载后影响后续登录与挑战。 |
| <!-- runtime-config:altcha.enabled --> `altcha.enabled` / `ALTCHA_ENABLED` / 显式映射 | 布尔；默认 `true` | 自托管 ALTCHA 开关；热加载后影响新登录挑战。 |
| <!-- runtime-config:altcha.ttl_seconds --> `altcha.ttl_seconds` / `ALTCHA_TTL_SECONDS` / 显式映射 | 整数；默认 `300`；90–3600 秒 | 签名挑战有效期，覆盖 60 秒求解与 30 秒余量；热加载后影响新挑战。 |
| <!-- runtime-config:altcha.cost --> `altcha.cost` / `ALTCHA_COST` / 显式映射 | 整数；默认 `5000`；1000–100000 | PBKDF2 单次迭代成本；与 `counter_max` 的乘积不超过 100000000，热加载后影响新挑战。 |
| <!-- runtime-config:altcha.counter_min --> `altcha.counter_min` / `ALTCHA_COUNTER_MIN` / 显式映射 | 整数；默认 `2000`；100–100000，且不高于 `counter_max` | 工作量下界；热加载后影响新挑战。 |
| <!-- runtime-config:altcha.counter_max --> `altcha.counter_max` / `ALTCHA_COUNTER_MAX` / 显式映射 | 整数；默认 `5000`；100–100000，且与 `cost` 的乘积不超过 100000000 | 工作量上界；热加载后影响新挑战。 |
| <!-- runtime-config:log.level --> `log.level` / `LOG_LEVEL` / 显式映射 | 枚举；默认 `"WARN"`；`DEBUG`、`INFO`、`WARN`、`ERROR`、`OFF` | stdout / stderr 与文件日志级别；后台日志页或热加载后立即影响后续记录。 |
| <!-- runtime-config:log.max_size_mb --> `log.max_size_mb` / `LOG_MAX_SIZE_MB` / 显式映射 | 数值；默认 `10`；大于 0 且不超过 1024 MiB | 单日志文件轮转阈值；热加载后影响后续写入。 |
| <!-- runtime-config:log.max_files --> `log.max_files` / `LOG_MAX_FILES` / 显式映射 | 整数；默认 `5`；1–100 个文件 | 轮转文件保留数；热加载后影响后续轮转。 |

Ingestion 运行态期限是应用代码生命周期常量，不属于 `config.json`。Upload intent 与 credential
是创建后绝对 30 分钟，读取、重签或显示窗口都不续期；Upload canonical 的空闲期限为 2 小时，
Import canonical 为 24 小时。合法语义推进按新状态延长期限；长阶段内只有持有当前
execution token 的有效 heartbeat 才能续租。ready、可重试 failed 等空闲状态不会自行续租。
discarded / completed 紧凑回执沿用所属
队列的终态保留窗口，并由 expires scanner 删除，不依赖 Redis 原生 EXPIRE 或 keyspace event。

孤儿清理周期和安全余量均固定为 60 秒。无 canonical 引用的 raw 与 `_uploads` 使用
“24 小时 + 一个周期 + 安全余量”；旧 `.part` 使用上传 claim 失活期限 2 分钟与远端请求超时
两者较长者，再加周期与余量。所有年龄、批次和稳定读取边界都是代码常量，不能用运行配置
缩短为会误删活跃素材的值。

后台 Worker 的 5 秒 tick、每种任务类型单次最多 50 项 / 2 秒的公平时间片、15 分钟
任务执行期限、10 秒停机排空期限、僵尸任务恢复周期和历史保留周期同样是应用生命周期
常量，不属于 `config.json`。停机排空的 10 秒是领取、handler、续租收口、终态写入和
当前 tick 共用的总期限，不会按任务或阶段重复计算。
`background_job.*` 只调整具体任务的并发 lane 数，不会取消时间片预算或让某一队列
长期独占 worker。

## 入库图片标准化

本地上传与 URL 下载共用顶层 `normalize` 配置。两者分别由浏览器 raw PUT 和服务器安全下载
取得原始字节，attempt `.part` 完整校验后原子落到 `data/tmp/upload|import`；prepare 才执行
标准化、缩略图和最终入库文件处理，并把候选文件写入选定存储后端。

```json
{
  "ingestion": {
    "commit_concurrency": 5,
    "global_commit_concurrency": 10,
    "global_commit_byte_budget_mb": 512
  },
  "upload": {
    "max_items": 200,
    "max_file_size_mb": 100,
    "max_long_edge": 32000,
    "concurrency": 2,
    "global_concurrency": 5
  },
  "import": {
    "fill_original_url": true,
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

prepare 只接受 JPEG、PNG、WebP、GIF 与 AVIF；SVG、TIFF、HEIC 及其他 Sharp 虽能识别但不在白名单内的格式仍会拒绝。输入格式、原始尺寸和 EXIF 展示方向来自同一次 Sharp metadata，标准化后 WebP 的格式、尺寸与字节数来自最终编码结果，不二次解码候选文件。需要转码的 GIF、animated WebP 与 AVIF 使用 Sharp 默认的首帧处理语义；符合下述跳过条件的 animated WebP 则保留完整原字节。URL download 阶段执行的独立图片魔数检查仍是外部抓取安全边界，不由 prepare 的 Sharp 校验替代。

输入本身是 WebP、体积小于 `normalize.skip_webp_under_kb` 且长边已经达标时，原字节直接成为最终候选文件；服务端仍会执行解码校验、标准缩略图生成和最终 MD5 计算。`upload.concurrency` 既限制单个后台页面的 raw PUT 数，也限定一次预签 intent 批次为可以立即进入 lane 的文件；当前批结算后才为下一批签发，避免长队列预先消耗短 credential TTL。`import.concurrency` 约束浏览器来源队列，Import accept 后的下载由服务端 `import.global_concurrency` pool 接管；prepare 使用独立 pool，其容量取 Upload 与 Import 全局并发基数的较大值。即使调用方绕过前端队列，worker 仍有有界阶段准入并支持取消等待任务。

commit 使用独立的 `ingestion.commit_concurrency` / `ingestion.global_commit_concurrency`。前者限制单个后台页面，后者在取得会话 advisory lock、存储共享锁和数据库事务连接之前限制整个服务端进程。服务端还按 `ingestion.global_commit_byte_budget_mb` 对 prepared 图片与缩略图大小做 FIFO 加权限流；活动权重始终按任务真实字节累计，不会在运行中随动态预算截断。超过预算的单个合法对象只能在当前没有其他 commit 占用时独立运行；预算升降后仍按真实活动总量决定是否放行队首。数量许可与字节许可都覆盖正式对象复制、数据库事务、暂存清理和缓存更新，而不只是 `INSERT`。PostgreSQL 主查询连接池上限为 30；长生命周期 advisory lock 使用另一个上限同为 30 的专用连接池，避免下载、转码和存储 I/O 持锁期间占满查询连接。commit 的存储共享锁、排序后的主题 / 作者 / 最终标签共享关联租约、会话锁和单图锁由同一专用连接按固定顺序取得，不会在锁池内嵌套等待第二条连接；同 slug commit 可以并行并在共享租约内幂等确保词表项存在，显式词表管理和删除使用的独占锁仍会等待全部关联租约退出。锁连接丢失会中止工作，内容接入发布另以数据库 execution token 栅栏旧执行者。公开 PostgreSQL 回源在主池内最多占 12 条连接；当前单应用实例最多保留 60 条应用连接，数据库 `max_connections` 应为该边界和运维连接留足空间。

后台队列在建立不可变提交意图后先显示“提交排队 / 等待提交”，Server 将 Redis canonical
原子推进到 `committing` 后立刻返回 accepted；worker 真正取得上述数量与字节准入后才执行
对象复制和 PostgreSQL 事务。事务提交后必须经 PostgreSQL 批量结果水合才完成。窗口将等待准入
与等待结果合并为“等待中”，实际执行计入“处理中”，不把全部已选任务算作处理中。持有提交意图的任务锁定当时规范化后的
metadata，不能普通取消、移除或继续编辑；结果读取失败只允许重新获取结果。
commit 边界的结构化重复冲突是例外：会话仍为 `ready`，前端不计失败并允许直接确认复用同一
提交意图，或取消并清理该会话；两种动作都不新增逐图预检请求。

URL 输入窗口、JSONL 解析和微博解析共享 3600 项通用安全边界；JSONL 与微博还在
服务端重复执行该边界。三者同时满足各自的可配置软上限：URL 与 JSONL 由
`import.max_items` 限制，最高 1000 项；
微博链接条数由 `weibo.max_items` 限制，最高 50 条。微博解析后的图片数不受
`import.max_items` 影响；按单条微博最多 18 张图片计算，合法配置最多产生
900 张图片，服务端另保留不可配置的 1000 张安全上限。输入或解析结果超过限制时
会在生成任务前明确拒绝，不自动拆成多个 `batch_time`。URL、JSONL 与微博都先在
浏览器形成有序任务，随后通过一个固定的有界 Import accept JSON 请求批量创建或复用
canonical。所有条目内容只进入受限正文。本地文件通过有界 Upload intent 批次签发，Server
同时执行 `upload.max_items` 与通用 hard limit；每个已签发批次只有一次 intent POST 和至多
N 次纯字节 raw PUT。

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

精准 schema 的完整说明位于“完整 config.json”标题的悬停提示中；移动端隐藏页面头部的
重复功能概述，为编辑器和操作按钮
保留稳定空间。操作失败仅显示简短中文提示，完整异常写入后台应用日志。

保存使用同目录临时文件；临时文件完成 `fsync` 后原子重命名，并在支持目录同步的
平台同步父目录，再替换内存配置并通知热加载监听器。这会同时防止进程中断造成半写
文件，并尽量保证突然掉电后仍保留已发布的新版本；最终持久性仍受底层文件系统和存储
硬件保证约束。`site.domain` 变化会提示当前访问地址可能失效。完整配置接口和响应均
禁止缓存，且仅允许 super 管理员访问。

### 配置包

super 管理员可在「设置 → 高级配置」导出或导入 JSON 配置包。`format` 固定为
`imageshow-config`，`application_version` 仅用于识别导出来源；导入按严格完整 schema
接受当前结构。配置包最大 1 MiB，单包最多
包含 100 个自定义存储后端。

预览和正式导入共用同一个严格解析入口。缺少字段、未知字段、类型错误和
越界值均会拒绝；导出的结构始终包含当前完整字段。

配置包用于把可迁移的站点行为和存储连接复制到新实例：

- `config` 包含站点展示、上传 / 导入、图片处理、后台、安全验证和日志
  等运行时配置，但排除 `site.domain`。监听端口由目标版本的代码固定，
  PostgreSQL / Redis 连接由目标实例自己的环境变量提供；三者均不进入配置包。
- `storage_backends` 包含自定义 S3 后端的显示名、slug、启停状态、
  默认状态、顺序和完整连接配置。内置 `local` 不导出。
- 管理员账号、图片及其标签 / 主题 / 作者、内容接入会话、后台任务和 Redis
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
以防预检之后发生竞态。全部存储后端在同一数据库事务内写入。进程内所有运行时配置写入
共用一条写租约；配置包导入
会持有租约直到数据库结果确认与补偿结束，普通错误会回滚数据库事务，并以本次写入的
精确 revision 恢复旧快照。提交回包不确定时会用事务自身的 xid8 receipt 查询
PostgreSQL 提交状态，不根据可能已被后继修改的业务行猜测；无法确认则保留候选配置
供管理员核对。

配置文件与 PostgreSQL 是两个独立资源，无法组成真正的跨资源原子事务。若在配置
文件写入后遭遇 SIGKILL、容器崩溃或主机断电，仍存在配置已更新而数据库事务已回滚
的极小不一致窗口。此时需人工恢复导入前的 `config.json`，或确认当前后端注册表后
重新导入配置包。

## 环境变量

`.env` 不会自动成为容器环境。默认 `compose.yaml` 没有 `env_file`，只用映射形式逐项插值；
未被引用的变量即使出现在 `.env`，也不会进入 ImageShow、PostgreSQL 或 Redis。默认模型只保留
空数据首次启动所需的部署级最小值，并按职责顺序排列：

| 默认 Compose 职责 | 进入的目标与变量 |
| --- | --- |
| PostgreSQL 必要身份 | ImageShow：`DATABASE_NAME=imageshow`、`DATABASE_USER=imageshow`、`DATABASE_PASSWORD` 必填且无默认值；PostgreSQL：由同一组值转换出的 `POSTGRES_DB`、`POSTGRES_USER`、`POSTGRES_PASSWORD`。 |
| 首次管理员 | ImageShow：`ADMIN_USERNAME=admin`、`ADMIN_PASSWORD` 必填且无默认值；只在数据库没有 super 时由应用读取。 |

ImageShow 与 PostgreSQL 在各自 `environment` 中直接插值同一组数据库名、用户名和密码，
不额外建立顶层 `x-*` 设置；这三项位于 `imageshow.environment` 前部，`ADMIN_*` 紧随其后。
默认 Compose 不注入 RuntimeConfig、`TZ`、`DATABASE_HOST` / `DATABASE_PORT` 或任何
`REDIS_*`。内置拓扑分别使用
Server 的 `UTC`、`postgresql:5432`、`redis:6379/0` 代码默认值；Redis 服务本身不接收任何项目变量，
也不设置密码。默认进入容器的五个 ImageShow 变量都使用映射形式和明确插值，不使用无值宿主透传。
两个密码使用 `:?` 必填插值，未设置或空值都会在 Compose 展开阶段失败；部署者必须分别提供
不同的随机强密码。其余三项继续使用当前默认值。

本地开发或自动化测试可用 `IMAGESHOW_DEVELOPMENT_DATA_DIRECTORY` 将配置、存储、
临时文件和日志整体指向一次性隔离目录，避免测试触碰仓库的真实 `data/`。该变量在
`NODE_ENV=production` 时被忽略，生产容器的数据目录仍固定为 `/app/data`。

全部 RuntimeConfig 变量只列在 `.env.example`，默认不注入。变量名严格由完整路径转成大写
下划线，不增加类型后缀，例如 `site.root → SITE_ROOT`、
`embed.allowed_origins → EMBED_ALLOWED_ORIGINS`、`weibo.author_slugs → WEIBO_AUTHOR_SLUGS`。
部署者确需启用时，必须在 `services.imageshow.environment` 中逐项增加映射并重建，例如：

```yaml
services:
  imageshow:
    environment:
      SITE_ROOT: ${SITE_ROOT:?set SITE_ROOT}
      EMBED_ALLOWED_ORIGINS: ${EMBED_ALLOWED_ORIGINS:?set EMBED_ALLOWED_ORIGINS}
```

在加入映射前先为变量设置合法值；示例使用 `:?` 让缺失或空值在 Compose 展开时直接失败。
只有允许空字符串且确实要保留该语义的字段才应有意使用 `${VARIABLE:-}`。不要使用 `env_file`、
列表式 `- VARIABLE` 宿主透传、通配变量或把完整目录放入共享锚点。

`.env.example` 同时列出可选部署覆盖。只有外部拓扑或自定义时区确实需要时，才逐项映射
`DATABASE_HOST`、`DATABASE_PORT`、`REDIS_HOST`、`REDIS_PORT`、`REDIS_DB`、`REDIS_PASSWORD`
或 `TZ`；仅把它们写入 `.env` 不会改变默认容器。数据库名、用户名和密码仍是默认 Compose
必须持续注入的部署身份；默认 Compose 也持续要求首次管理员用户名和密码，但已有 super 时
应用不会再读取它们覆盖账号。

字符串保留空值语义，数字保留 `0`，布尔保留 `false`。数字必须是无首尾空白的有限 JSON
数字；布尔只接受 `true`、`false`。数组和映射使用严格 JSON，不支持逗号列表、
JSONC、重复对象键或静默跳过非法成员。可复制示例：

```ini
SITE_DESCRIPTION=""
NORMALIZE_SKIP_WEBP_UNDER_KB=0
SITE_ROBOTS_ENABLED=false
SITE_HOME_BANNER_TITLE="我们一起，\n收藏这些瞬间。"
EMBED_ALLOWED_ORIGINS='["https://portal.example.com","https://*.trusted.example.net"]'
WEIBO_AUTHOR_SLUGS='{"1234567890":"example-author"}'
```

对应的复杂配置纯 JSON 片段为：

```json
{
  "site": {
    "home": {
      "banner_title": "我们一起，\n收藏这些瞬间。"
    }
  },
  "embed": {
    "allowed_origins": [
      "https://portal.example.com",
      "https://*.trusted.example.net"
    ]
  },
  "weibo": {
    "author_slugs": {
      "1234567890": "example-author"
    }
  }
}
```

Server 在首次生成前把所有已设置 seed 合并到代码默认值，再执行完整 strict schema 与交叉
字段校验。非法变量会同时报告环境变量名与配置路径；任一失败都不会写出部分配置。部署连接
仍在每次进程启动时解析：数据库名、用户名和密码缺失会拒绝启动，其余连接项缺失时使用代码
默认值。`config.json` 一旦存在，即使容器里
残留非法 seed，启动和手动重载也只处理文件，不会让 seed 覆盖、拒绝或改写合法文件。
