# 配置说明

ImageShow 的配置按生效边界分为三类：部署环境变量、`/app/data/config.json`、PostgreSQL。排查配置时先确认“这项配置由谁管理”，再判断修改后是否需要热加载或重启。

## 配置来源

### 环境变量

- 保存内容：PostgreSQL / Redis 连接、时区与首次管理员凭据；也可在首次生成 `config.json` 时播种应用配置。
- 修改方式：修改 `.env`、宿主环境或 Compose 映射后重建 / 重启。`.env` 只是 Compose 插值来源，只有部署清单显式映射的值才会进入容器。部署字段在每次进程启动时读取，不写入 `config.json`。

### `/app/data/config.json`

- 保存内容：站点、内容接入、图片处理、安全和日志等应用运行策略。
- 修改方式：后台普通设置页或高级配置，或直接编辑文件后在后台「设置 → 读取配置文件」。页面上传窗口、图片处理并发与最终入库并发可在普通设置页修改；导入原图链接、自动开始、微博来源页、质量递减步长、接入原图体积 / 长边与 Server raw 准入只通过配置文件或高级配置维护。存储迁移准入是代码内固定调度，不属于 RuntimeConfig。

### PostgreSQL

- 保存内容：管理员账号及界面偏好；作者主页与派生导入身份；本地 / S3 存储后端注册表；S3 endpoint、region、bucket、access key、secret key、根目录、public URL 与连接 / 空闲 / 总时限等实例化数据。
- 修改方式：后台设置页或对应管理界面。secret key 与作者内部身份列不返回公共接口。

本页的 [RuntimeConfig 参数目录](#runtimeconfig-参数目录)是完整应用字段参考；仓库根目录 `.env.example` 同时列出部署变量与具备环境映射的首次播种变量，并注明仅由配置文件管理的字段。实际运行配置文件是纯 JSON，不支持注释。启动和手动重载时会按当前 schema 归一化：缺少且有默认值的字段自动补齐，未知字段递归删除，已有有效值保留；归一化发生变化时写入同目录临时文件，同步文件内容后原子替换完整配置，并在支持目录同步的平台持久化该 rename。只有已知字段值不符合自身规定的合法范围时才会失败。PostgreSQL 与 Redis 连接值必须由环境变量提供。归一化是长期的结构校验与自愈能力：只投影当前默认结构，结构之外的字段删除，缺少的字段按默认值补齐，不推测字段含义。

运行时配置的默认值只定义在 shared 的 `appConfig.runtimeDefaults`，由服务端归一化后通过公开配置或后台设置 DTO 提供。前端不再为站点名称、图标、分页、接入限制与并发、导入策略等字段复制一套默认值；初次配置读取完成前保持加载状态，失败时提供重试。后台刷新失败且已有配置时保留当前页面和工作流。公开配置在服务端统一处理空描述回退到站点名，SPA 文档与浏览器页面头部直接消费同一有效投影。

运行时配置模块本身不读取或写入文件。主进程在装配 HTTP 路由、注册配置变更监听器和启动 Worker 前显式初始化进程内快照；初始化失败时不会继续连接数据库或监听端口。Docker healthcheck 只读取并在内存中归一化已经存在的 `config.json`，缺失或非法时直接失败并等待主进程恢复，不负责首次生成或写回。管理员密码恢复只依赖 PostgreSQL 和 Redis 部署配置，不初始化运行时配置。由此，单纯导入配置或 HTTP 应用模块不会创建目录、写文件或启动服务。

管理端 `GET /api/admin/settings` 只返回设置页和图片工作流实际读取的最小字段集。除设置页可编辑字段外，仅保留共享接入限制、上传数量、Import 数量和页面工作流所需的只读值；部署配置、完整 `appConfig`、Server raw / 迁移准入、外链抓取超时和内部调度常量留在各自权威配置或代码边界。`POST /api/admin/settings` 同样只接受设置页公开的可编辑字段，并以嵌套 patch 合并，未公开配置不会因保存设置页而被默认值覆盖。`import.keep_original_link` 与 `import.auto_import` 只为内容接入工作流保留在读取 DTO 中，不进入普通设置写入；`weibo.source_enabled` 与 `normalize.quality_step` 不进入普通设置读写 DTO。这些字段统一通过高级配置或配置文件维护。`embed` 不进入普通后台设置的读取或保存 DTO，只通过 `data/config.json` 维护；公开站点配置仅返回前端路由实际消费的有效嵌入开关，不返回来源列表，并额外返回公开路由实际消费的完整 `site.show`。`site.gallery.public_original_button` 在服务端决定是否向访客详情返回原图链接，不进入公开站点配置或普通设置读写 DTO；普通设置保存不会覆盖它。详情接口按公开策略与管理员会话生成可空原图链接，前端只根据非空链接显示原图按钮；加载中、失败或无链接时不渲染入口。`site.domain`、`site.description`、`site.icon` 与 `site.home.enabled` 保留在运行时配置中，但不进入普通设置页及其读写 DTO。普通站点设置暂维持 5.6.2 的字段范围；`site.home.browse_target`、完整 `site.show.*` （含 `autoplay`）及 `site.gallery.enabled` 只通过配置文件或高级配置维护，并支持首次环境变量播种。普通设置接口不返回或接受这些新增字段，保存时不会覆盖它们；画廊分页量和排序仍可编辑。其中 `site.description` 只用于 HTML `description`。这些字段都需要通过配置文件或高级配置维护；公开站点配置投影会返回描述，供 SPA 路由切换后维护同一 meta。

普通设置未修改时跟随共享 settings 查询更新；存在未保存修改时保留当前表单，后台回读不整份覆盖。点击「保存应用配置」或「读取配置文件」后，全表单与两个操作按钮暂时禁止编辑，避免提交期间产生新的输入。请求最多等待 15 秒，失败或超时解除锁定并保留提交内容；超时不代表服务端一定未写入，可重试保存或主动读取文件确认。读取文件成功会明确替换当前修改。两个 POST 接口与 GET 一样返回规范化的 `{ settings }`；页面取消旧 settings 回读后直接发布该结果，只失效其他必要投影，不再额外 GET 配置。离页取消当前请求。

设置页的「读取配置文件」与「保存应用配置」直接在各自按钮内显示进行中、成功或失败，并预留最长状态文案宽度。进行态至少展示 500ms，结果保留三秒；成功状态不会阻止再次点击。原始错误详情写入应用日志，页面只保留简短中文结果。

## 热加载边界

`config.json` 中的应用配置可在后台点击「读取配置文件」后生效。部署配置只在进程启动时读取：`DATABASE_*` 和 `REDIS_*`。修改后需要重新创建或重启应用容器；后台不会读取、展示或保存这些连接值。

应用在代码中固定监听容器内 `5518`，Docker healthcheck 与主进程共享该代码常量，并从现有配置快照取得请求所需的站点 Host。仓库 Compose 固定使用 `127.0.0.1:5518:5518`，不提供宿主端口环境变量；只有容器化代理或明确的同机私有网络拓扑才应通过 `compose.override.yaml`、其他部署清单或 `docker run -p [host-ip:]<host-port>:5518` 覆盖映射，同时仍须阻止不可信客户端直达应用端口。自定义镜像如需改变内部端口，应修改 `appConfig.applicationPort`，并同步 Dockerfile 的 `EXPOSE` 与 Compose 目标端口。

`ADMIN_USERNAME` / `ADMIN_PASSWORD` 只在数据库没有 super 管理员时创建首个账号，最终写入 PostgreSQL 的 `admin_account` 表，不进入 `config.json`。单应用进程初始化直接检查已有 super，只有确实缺失时才要求这两个值；已有 super 时不会再读取环境变量覆盖账号或密码。顺序重启和崩溃后的顺序恢复受支持，两个应用进程重叠播种不受支持。

后台配置写入由同一进程内的 FIFO 写租约串行化，包括配置包导入的长 I/O 和收敛窗口；配置包的存储后端写入使用 PostgreSQL 事务与 xid8 提交结果回执，运行配置采用候选文件持久化和结果核对后的单次内存发布，不维护运行时 revision 补偿。

## 作者身份配置边界

`weibo.author_slugs` 与 `WEIBO_AUTHOR_SLUGS` 已从当前 RuntimeConfig、首次播种和配置包契约中删除；微博导入只按 PostgreSQL 作者身份查询。启动、手动「读取配置文件」、高级配置保存和配置包导入都只按当前默认结构投影，再次出现旧字段时直接作为未知字段删除，不读取其值、不触发迁移，也不影响已经写入 PostgreSQL 的作者身份。这是来源无关的当前结构归一化，不是旧版本迁移层。

## 原图链接显示

`site.gallery.public_original_button` 控制是否向未登录访客的图片详情返回原图链接，默认 `false`。
已登录管理员或开关开启时，存在独立原图就返回公开链接；否则返回 `null`。
原图资源始终通过 `/images/original/<id>` 公开提供并允许缓存，开关不限制直接访问。

## RuntimeConfig 参数目录

以下各项是 `data/config.json` 的完整叶子参数参考，也是 `.env.example` 中全部字段的首次播种目录。环境变量仅在文件不存在时参与一次完整配置生成；后续启动、重启、普通设置、高级配置、配置包和手动重载都以持久化配置为准。默认应用容器环境包含数据库与管理员设置，以及 `SITE_DOMAIN`、`SITE_GALLERY_PUBLIC_ORIGINAL_BUTTON` 映射；其余 RuntimeConfig 字段标为“显式映射”，由部署者扩展 Compose 后进入容器。所有现行配置都可经高级配置保存或手动重载热生效；普通设置页只开放其中的非敏感常用子集。数值除明确注明外均为整数，布尔环境值只接受 `true`、`false`。

### site

#### site.name

- 环境变量：`SITE_NAME`
- Compose：显式映射
- 类型、默认值与范围：字符串；默认 `"ImageShow"`；去空白后非空

页面标题、导航和后台站点名；普通设置或热加载后影响后续响应。

#### site.domain

- 环境变量：`SITE_DOMAIN`
- Compose：默认注入
- 类型、默认值与范围：字符串；默认 `"example.com"`；0–259 字符，空值或 DNS 域名，可带 1–65535 端口

强烈建议设置实际域名；未设置、为空或为 `example.com` 时接受访问 Host 并使用同源 `/images` 路径。显式域名继续约束主站 Host；域名变化可能使当前地址失效。

#### site.description

- 环境变量：`SITE_DESCRIPTION`
- Compose：显式映射
- 类型、默认值与范围：字符串；默认 `"画廊与随机图片API"`；去空白后 0–200 字符

SPA `description`；空值回退到站点名，首次播种或热加载后影响新 HTML。

#### site.icon

- 环境变量：`SITE_ICON`
- Compose：显式映射
- 类型、默认值与范围：字符串；默认 `"/assets/brand/favicon.svg"`；1–2048 字符的站内绝对路径或 HTTPS URL

站点图标；首次播种或热加载后影响公开配置。

#### site.version.enabled

- 环境变量：`SITE_VERSION_ENABLED`
- Compose：显式映射
- 类型、默认值与范围：布尔；默认 `true`

控制后台版本卡片；首次播种或热加载后影响已认证会话探针。

#### site.version.link_enabled

- 环境变量：`SITE_VERSION_LINK_ENABLED`
- Compose：显式映射
- 类型、默认值与范围：布尔；默认 `true`

控制版本卡片是否链接 Release；首次播种或热加载后影响会话探针。

#### site.root

- 环境变量：`SITE_ROOT`
- Compose：显式映射
- 类型、默认值与范围：枚举；默认 `"home"`；`home`、`show`、`gallery`

选择 `/` 显示首页、展映或画廊；目标关闭时按画廊、展映、首页的稳定优先级选择仍启用页面，三页均关闭时 `/` 返回 404，不改写配置值或转向随机图 / 后台。普通设置或热加载后影响导航。

#### site.home.enabled

- 环境变量：`SITE_HOME_ENABLED`
- Compose：显式映射
- 类型、默认值与范围：布尔；默认 `true`

控制公开首页入口与 `/home`；关闭时回退到仍启用的公开页，配置选择原样保留。首次播种或热加载后影响新请求。

#### site.home.browse_target

- 环境变量：`SITE_HOME_BROWSE_TARGET`
- Compose：显式映射
- 类型、默认值与范围：枚举；默认 `"show"`；`gallery`、`show`

选择首页筛选入口进入画廊或展映；目标关闭时改用另一个仍启用的图片页，两者都关闭时入口不可用。嵌入首页遵循同一配置与回退规则，使用 `/embed/gallery` 或 `/embed/show`。配置文件或高级配置热加载后生效。

#### site.home.background

- 环境变量：`SITE_HOME_BACKGROUND`
- Compose：显式映射
- 类型、默认值与范围：字符串；默认 `""`；空值或最长 2048 字符的站内绝对路径 / HTTPS URL

首页背景；空值使用 `/random`，普通设置或热加载后生效。

#### site.home.banner_label

- 环境变量：`SITE_HOME_BANNER_LABEL`
- Compose：显式映射
- 类型、默认值与范围：字符串；默认 `"ImageShow · A FAN-MADE PHOTO HANDBOOK"`；1–160 字符

首页 Banner 标识；普通设置或热加载后生效。

#### site.home.banner_title

- 环境变量：`SITE_HOME_BANNER_TITLE`
- Compose：显式映射
- 类型、默认值与范围：字符串；默认 `"我们一起，\n收藏这些瞬间。"`；1–80 字符，可换行

首页 Banner 标题；普通设置或热加载后生效。

#### site.show.enabled

- 环境变量：`SITE_SHOW_ENABLED`
- Compose：显式映射
- 类型、默认值与范围：布尔；默认 `true`

控制公开展映入口、`/show` 与 `/embed/show`，嵌入入口还需开启 `embed.enabled`；关闭后直接访问、根入口和首页目标均使用公共目标解析器，配置选择原样保留。配置文件或高级配置热加载后生效。

#### site.show.autoplay

- 环境变量：`SITE_SHOW_AUTOPLAY`
- Compose：显式映射
- 类型、默认值与范围：布尔；默认 `true`

普通与嵌入展映首次挂载时是否自动播放；`false` 初始暂停，访客仍可手动启停和拖动、缩放，同次挂载内模式或筛选变化不重置播放状态。通过配置文件或高级配置维护，修改后重新进入或刷新页面采用新值；减少动态效果优先。

#### site.show.mode

- 环境变量：`SITE_SHOW_MODE`
- Compose：显式映射
- 类型、默认值与范围：枚举；默认 `"waterfall"`；`waterfall`、`float`

未带合法 `mode` URL 参数时的展映模式，读取默认值不改写 URL；访客手动切换始终显式写入目标 `mode`，切回配置默认模式也保留参数，不回写配置。配置文件或高级配置热加载后生效。

#### site.show.density

- 环境变量：`SITE_SHOW_DENSITY`
- Compose：显式映射
- 类型、默认值与范围：枚举；默认 `"balanced"`；`relaxed`、`balanced`、`dense`

`waterfall` 初始列数分别为同宽画廊列数 `G` 的 `0.5G`、`G`、`1.5G`；`float` 分别映射为较大、默认与较小图片档。访客按钮调整不写回配置。配置文件或高级配置热加载后生效。

#### site.show.drift_speed

- 环境变量：`SITE_SHOW_DRIFT_SPEED`
- Compose：显式映射
- 类型、默认值与范围：整数；默认 `28`；10–60 CSS px/s

展映自动漂移的基准速度；`float` 按生命周期距离和相邻间距微调各卡片速度，不改变手动拖动、滚轮或导航显隐。配置文件或高级配置热加载后生效。

#### site.show.order

- 环境变量：`SITE_SHOW_ORDER`
- Compose：显式映射
- 类型、默认值与范围：枚举；默认 `"random"`；`random`、`latest`、`oldest`

未带 `order` URL 参数时的展映初始数据顺序；访客三态切换只写 URL，不写配置。配置文件或高级配置热加载后生效。

#### site.gallery.enabled

- 环境变量：`SITE_GALLERY_ENABLED`
- Compose：显式映射
- 类型、默认值与范围：布尔；默认 `true`

控制公开画廊入口、`/gallery` 与嵌入画廊；关闭后直接访问、根入口和首页目标均使用公共目标解析器，配置选择原样保留。配置文件或高级配置热加载后生效。

#### site.gallery.order

- 环境变量：`SITE_GALLERY_ORDER`
- Compose：显式映射
- 类型、默认值与范围：枚举；默认 `"latest"`；`random`、`latest`、`oldest`

画廊默认排序；普通设置或热加载后影响新查询。页面右下角可以切换排序并保留筛选。
页面首批按视口需求向上选择 60 / 120 / 180，续批固定 60；最短列剩余覆盖不足约一屏时补图。

#### site.gallery.public_original_button

- 环境变量：`SITE_GALLERY_PUBLIC_ORIGINAL_BUTTON`
- Compose：默认注入
- 类型、默认值与范围：布尔；默认 `false`

控制未登录访客是否在图片详情取得原图链接，适用于画廊、展映及其共享详情。

- `false`：访客详情中的 `original_url` 为 `null`；已登录管理员取得公开原图链接。
- `true`：访客和已登录管理员都取得公开原图链接。
- 没有与展示图不同的合法 HTTPS 原图时，始终返回 `null`。

原图按钮只消费服务端返回的非空链接。正常图片、后台及回收站统一使用公开且可缓存的
`/images/original/<id>`；该资源出口不读取会话或本开关，直接拼接有效 URL 同样可访问。
详情 JSON 在开关关闭时因登录状态产生不同内容，使用 `private, no-cache`；开启时使用
`public, max-age=30, s-maxage=60`，始终带 `Vary: Cookie`，避免访客详情复用已登录结果。
原图直连 302 使用公开短缓存；代理继承源站缓存策略，缺省使用站内 CDN fallback。
支持首次播种、完整配置、高级配置、配置包及热加载，不进入普通设置或公开站点配置 DTO。
环境变量只在配置文件不存在时播种；已有安装应在配置文件或高级配置中修改此字段。

#### site.random_method

- 环境变量：`SITE_RANDOM_METHOD`
- Compose：显式映射
- 类型、默认值与范围：枚举；默认 `"redirect"`；`proxy`、`redirect`

`/random` 未指定 `mode` 时的图片返回方式；`json` 仅可作为显式 `mode=json` 查询参数，普通设置或热加载后影响新请求。

#### site.robots_enabled

- 环境变量：`SITE_ROBOTS_ENABLED`
- Compose：显式映射
- 类型、默认值与范围：布尔；默认 `false`

控制主站 `robots.txt`；首次播种或热加载后影响新请求。

### embed

#### embed.enabled

- 环境变量：`EMBED_ENABLED`
- Compose：显式映射
- 类型、默认值与范围：布尔；默认 `false`

开放 `/embed/home`、`/embed/show` 与 `/embed/gallery`；显式域名下隐式允许站点 HTTPS 来源与同端口子域，基础域名回退下只隐式允许同源；首次播种或热加载后生效。

#### embed.allowed_origins

- 环境变量：`EMBED_ALLOWED_ORIGINS`
- Compose：显式映射
- 类型、默认值与范围：严格 JSON 数组；默认 `[]`；最多 32 个 HTTPS DNS origin，每项不超过 320 字符且总长不超过 4096 字符

增加精确来源或最左侧 `*.` 子域来源；规范化去重并拒绝 HTTP、IP、路径和凭据。schema 不含 Public Suffix List，部署者须避免为公共托管后缀配置通配，热加载后影响 CSP。

### ingestion

#### ingestion.max_file_size_mb

- 环境变量：`INGESTION_MAX_FILE_SIZE_MB`
- Compose：显式映射
- 类型、默认值与范围：数值；默认 `100`；大于 0 且不超过 200 MiB

Upload raw 与 Import 远程素材共用的单图体积上限；Server 对页面和直接 API 权威校验，热加载后影响新接入。

#### ingestion.max_long_edge

- 环境变量：`INGESTION_MAX_LONG_EDGE`
- Compose：显式映射
- 类型、默认值与范围：整数；默认 `32000`；300–32000 px

Upload / Import 共用的原图长边准入上限；Server 在 raw 或 prepare 边界权威校验，热加载后影响新接入。

#### ingestion.list_page_size

- 环境变量：`INGESTION_LIST_PAGE_SIZE`
- Compose：显式映射
- 类型、默认值与范围：整数；默认 `20`；1–100 项

Upload / Import 队列与批量编辑列表分页；普通设置或热加载后生效。

#### ingestion.commit_concurrency

- 环境变量：`INGESTION_COMMIT_CONCURRENCY`
- Compose：显式映射
- 类型、默认值与范围：整数；默认 `8`；1–16

Upload / Import 共享的 Server 最终入库数量准入；另受代码内 256 MiB prepared 字节预算约束，普通设置或热加载后影响后续提交。

### upload、import 与 weibo

#### upload.max_items

- 环境变量：`UPLOAD_MAX_ITEMS`
- Compose：显式映射
- 类型、默认值与范围：整数；默认 `200`；1–1000 项

文件选择与 intent 批次软上限；首次播种或热加载后影响新接入。

#### upload.browser_concurrency

- 环境变量：`UPLOAD_BROWSER_CONCURRENCY`
- Compose：显式映射
- 类型、默认值与范围：整数；默认 `2`；1–8

每个活动页面共享的预览解码、短凭据请求与 raw PUT 窗口；页面读取新设置后影响后续准入。

#### upload.raw_concurrency

- 环境变量：`UPLOAD_RAW_CONCURRENCY`
- Compose：显式映射
- 类型、默认值与范围：整数；默认 `5`；1–8

所有客户端共享的 Server raw PUT 准入；热加载后按 FIFO 调整等待请求。

#### import.keep_original_link

- 环境变量：`IMPORT_KEEP_ORIGINAL_LINK`
- Compose：显式映射
- 类型、默认值与范围：严格 JSON 字符串数组；默认 `["url", "jsonl", "weibo"]`；成员仅可为 `url`、`jsonl`、`weibo`，规范化去重，空白名单为 `[]`

只有白名单中的导入来源会把实际下载 URL 保存为公开 `original`；未列出的来源仍正常下载和入库。Server 在接管与首次提交意图冻结时均执行权威投影，高级配置或热加载后影响尚未冻结提交的任务；正式入库后的人工编辑不属于此配置。

#### import.auto_import

- 环境变量：`IMPORT_AUTO_IMPORT`
- Compose：显式映射
- 类型、默认值与范围：布尔；默认 `true`

无问题项时是否直接建立 Import 队列；高级配置或热加载后影响新解析。

#### import.fetch_timeout_seconds

- 环境变量：`IMPORT_FETCH_TIMEOUT_SECONDS`
- Compose：显式映射
- 类型、默认值与范围：整数；默认 `30`；5–300 秒

外链 download 请求期限；热加载后影响新请求。

#### import.max_items

- 环境变量：`IMPORT_MAX_ITEMS`
- Compose：显式映射
- 类型、默认值与范围：整数；默认 `200`；1–1000 项

URL / JSONL 单次软上限，不限制微博图片数；热加载后影响新解析。

#### weibo.max_items

- 环境变量：`WEIBO_MAX_ITEMS`
- Compose：显式映射
- 类型、默认值与范围：整数；默认 `10`；1–50 条

单次微博链接软上限；热加载后影响新解析。

#### weibo.source_enabled

- 环境变量：`WEIBO_SOURCE_ENABLED`
- Compose：显式映射
- 类型、默认值与范围：布尔；默认 `true`

微博导入是否把帖子页面写入 `source`；不影响图片下载、`original` 白名单或其他导入来源。关闭后，新解析、接管与首次提交意图冻结都会清空该字段；重新开启会让新解析清单携带来源，并允许仍持有来源值的未冻结任务提交，但不会重建此前已从清单省略的来源。高级配置或热加载后生效；正式入库后的人工编辑不属于此配置。

#### weibo.request_delay_seconds

- 环境变量：`WEIBO_REQUEST_DELAY_SECONDS`
- Compose：显式映射
- 类型、默认值与范围：严格 JSON 二元整数数组；默认 `[2, 5]`；两项均为 0–60 秒且下界不高于上界

全进程串行微博帖子请求的随机间隔 `[下界, 上界]`；已经开始的等待保持其采样值，热加载影响再下一项。

### normalize 与 thumbnail

#### normalize.concurrency

- 环境变量：`NORMALIZE_CONCURRENCY`
- Compose：显式映射
- 类型、默认值与范围：整数；默认 `2`；1–8

Upload / Import、缩略图维修与亮度重算共享的 Server 图片处理准入；同一数值还派生 Upload / Import 共用的 prepare / staging publication 总量，以及 Import 正在下载或持有磁盘 raw 的后继数量。每图 Sharp 线程固定为 `1`，普通设置或热加载后影响后续工作。

#### normalize.quality

- 环境变量：`NORMALIZE_QUALITY`
- Compose：显式映射
- 类型、默认值与范围：整数；默认 `80`；1–100

新图片 WebP 首次编码质量；普通设置或热加载后影响新 prepare。

#### normalize.quality_step

- 环境变量：`NORMALIZE_QUALITY_STEP`
- Compose：显式映射
- 类型、默认值与范围：整数；默认 `5`；1–50

超体积后的质量递减步长；高级配置或热加载后影响新 prepare。

#### normalize.min_quality

- 环境变量：`NORMALIZE_MIN_QUALITY`
- Compose：显式映射
- 类型、默认值与范围：整数；默认 `20`；1–100，且不高于 `normalize.quality`

转码最低质量；普通设置或热加载后影响新 prepare。

#### normalize.max_long_edge

- 环境变量：`NORMALIZE_MAX_LONG_EDGE`
- Compose：显式映射
- 类型、默认值与范围：整数；默认 `4200`；300–32000 px

入库成品长边上限，不放大；普通设置或热加载后影响新 prepare。

#### normalize.max_size_kb

- 环境变量：`NORMALIZE_MAX_SIZE_KB`
- Compose：显式映射
- 类型、默认值与范围：整数；默认 `500`；50–102400 KiB

入库成品目标体积；普通设置或热加载后影响新 prepare。

#### normalize.skip_webp_under_kb

- 环境变量：`NORMALIZE_SKIP_WEBP_UNDER_KB`
- Compose：显式映射
- 类型、默认值与范围：整数；默认 `700`；0–102400 KiB

合法 WebP 原字节保留阈值；普通设置或热加载后影响新 prepare。

#### thumbnail.long_edge

- 环境变量：`THUMBNAIL_LONG_EDGE`
- Compose：显式映射
- 类型、默认值与范围：整数；默认 `512`；64–4096 px

新缩略图长边；普通设置或热加载后影响新生成，不重做旧图。

#### thumbnail.quality

- 环境变量：`THUMBNAIL_QUALITY`
- Compose：显式映射
- 类型、默认值与范围：整数；默认 `75`；1–100

新缩略图质量；普通设置或热加载后影响新生成。

### admin、security、altcha 与 log

#### admin.login_background

- 环境变量：`ADMIN_LOGIN_BACKGROUND`
- Compose：显式映射
- 类型、默认值与范围：字符串；默认 `""`；空值或最长 2048 字符的站内绝对路径 / HTTPS URL

登录背景，空值使用站点 `/random`；普通设置或热加载后影响新登录页。

#### admin.image_page_size

- 环境变量：`ADMIN_IMAGE_PAGE_SIZE`
- Compose：显式映射
- 类型、默认值与范围：整数；默认 `60`；10–200 项

后台图片数字分页量；普通设置或热加载后影响新查询。

#### admin.recent_uploads

- 环境变量：`ADMIN_RECENT_UPLOADS`
- Compose：显式映射
- 类型、默认值与范围：整数；默认 `16`；1–60 项

概览最近上传数量；普通设置或热加载后影响新查询。

#### admin.show_unset_theme_card

- 环境变量：`ADMIN_SHOW_UNSET_THEME_CARD`
- Compose：显式映射
- 类型、默认值与范围：布尔；默认 `true`

主题页未设置卡片；普通设置或热加载后影响新渲染。

#### security.session_ttl_seconds

- 环境变量：`SECURITY_SESSION_TTL_SECONDS`
- Compose：显式映射
- 类型、默认值与范围：整数；默认 `604800`；300–31536000 秒

管理员会话空闲超时；登录时设置，之后仅在已认证 `/auth/me` 成功探针中滑动续期。热加载后影响新登录及后续成功续期。

#### security.login_failure_window_seconds

- 环境变量：`SECURITY_LOGIN_FAILURE_WINDOW_SECONDS`
- Compose：显式映射
- 类型、默认值与范围：整数；默认 `60`；30–300 秒

单来源失败统计窗口；热加载后影响后续登录与挑战。

#### security.login_max_failures

- 环境变量：`SECURITY_LOGIN_MAX_FAILURES`
- Compose：显式映射
- 类型、默认值与范围：整数；默认 `5`；3–500 次

单来源失败阈值；热加载后影响后续登录与挑战。

#### security.login_global_window_seconds

- 环境变量：`SECURITY_LOGIN_GLOBAL_WINDOW_SECONDS`
- Compose：显式映射
- 类型、默认值与范围：整数；默认 `180`；60–600 秒

全局登录窗口；热加载后影响后续登录与挑战。

#### security.login_global_max_attempts

- 环境变量：`SECURITY_LOGIN_GLOBAL_MAX_ATTEMPTS`
- Compose：显式映射
- 类型、默认值与范围：整数；默认 `10`；5–1000 次

全局尝试阈值；热加载后影响后续登录与挑战。

#### altcha.enabled

- 环境变量：`ALTCHA_ENABLED`
- Compose：显式映射
- 类型、默认值与范围：布尔；默认 `true`

自托管 ALTCHA 开关；热加载后影响新登录挑战。

#### altcha.ttl_seconds

- 环境变量：`ALTCHA_TTL_SECONDS`
- Compose：显式映射
- 类型、默认值与范围：整数；默认 `300`；90–3600 秒

签名挑战有效期，覆盖 60 秒求解与 30 秒余量；热加载后影响新挑战。

#### altcha.cost

- 环境变量：`ALTCHA_COST`
- Compose：显式映射
- 类型、默认值与范围：整数；默认 `5000`；1000–100000

PBKDF2 单次迭代成本；与 `counter_range` 上界的乘积不超过 100000000，热加载后影响新挑战。

#### altcha.counter_range

- 环境变量：`ALTCHA_COUNTER_RANGE`
- Compose：显式映射
- 类型、默认值与范围：严格 JSON 二元整数数组；默认 `[2000, 5000]`；两项均为 100–100000，下界不高于上界，且 `cost × 上界 <= 100000000`

ALTCHA 工作量 `[下界, 上界]`；热加载后影响新挑战。

#### log.level

- 环境变量：`LOG_LEVEL`
- Compose：显式映射
- 类型、默认值与范围：枚举；默认 `"WARN"`；`DEBUG`、`INFO`、`WARN`、`ERROR`、`OFF`

stdout / stderr 与文件日志级别；后台日志页或热加载后立即影响后续记录。

#### log.max_size_mb

- 环境变量：`LOG_MAX_SIZE_MB`
- Compose：显式映射
- 类型、默认值与范围：数值；默认 `10`；大于 0 且不超过 1024 MiB

单日志文件轮转阈值；热加载后影响后续写入。

#### log.max_files

- 环境变量：`LOG_MAX_FILES`
- Compose：显式映射
- 类型、默认值与范围：整数；默认 `5`；1–100 个文件

轮转文件保留数；热加载后影响后续轮转。

Ingestion 运行态期限是应用代码生命周期常量，不属于 `config.json`。Upload intent 与 credential 是创建后绝对 30 分钟，读取、重签或显示窗口都不续期；Upload canonical 的空闲期限为 2 小时，Import canonical 为 24 小时。合法语义推进按新状态延长期限；长阶段内只有持有当前 execution token 的有效 heartbeat 才能续租。ready、可重试 failed 等空闲状态不会自行续租。discarded / completed 紧凑回执沿用所属队列的终态保留窗口，并由 expires scanner 删除，不依赖 Redis 原生 EXPIRE 或 keyspace event。

孤儿清理周期和安全余量均固定为 60 秒。无 canonical 引用的 raw 与 `_uploads` 使用 “24 小时 + 一个周期 + 安全余量”；旧 `.part` 使用上传 claim 失活期限 2 分钟与远端请求超时两者较长者，再加周期与余量。所有年龄、批次和稳定读取边界都是代码常量，不能用运行配置缩短为会误删活跃素材的值。

后台 Worker 的 5 秒 tick、每种任务类型单次最多 50 项 / 2 秒的公平时间片、15 分钟任务执行期限、10 秒停机排空期限、僵尸任务恢复周期和历史保留周期同样是应用生命周期常量，不属于 `config.json`。停机排空的 10 秒是领取、handler、续租收口、终态写入和当前 tick 共用的总期限，不会按任务或阶段重复计算。后台任务 lane、短窗口和时间片都是代码内部调度策略。存储清理由代码固定为一个活动的 provider 中性 1…N 删除调用，同一业务调用的 driver group 逐组交接；所选图片与整后端迁移直接共享代码内固定 5 项的逐图对象传输容量，主题重分配使用图片领域独立的固定 5 项 metadata 更新容量。内容接入 Worker 另有一个 Upload / Import 共用的进程级 prepare / staging publication owner，由 `normalize.concurrency=N` 派生并从等待 Normalize 一直持有到两个 `_uploads` 对象及 ready canonical 发布完成；因此两种来源合计最多保留 `N` 份 Prepared Buffer。Import 与 Upload pre-commit dispatch slot 也由同一值派生；Import 在取得 Normalize 许可时交还，Upload 在 prepare 完成时交还。两类补位各自使用 frozen-tail 游标，Import queued 与恢复后的 received 保持同一个 Redis runnable FIFO。commit dispatch window 由 `ingestion.commit_concurrency=N` 派生为 `N + ceil(N / 2)`，候补只增加有界发现容量，不复制资源准入。

## 入库图片标准化

本地上传与 URL 下载共用顶层 `normalize` 配置。两者分别由浏览器 raw PUT 和服务器安全下载取得原始字节，attempt `.part` 完整校验后原子落到 `data/tmp/upload|import`；prepare 才执行标准化、缩略图和最终入库文件处理，并把候选文件写入选定存储后端。

```json
{
  "ingestion": {
    "max_file_size_mb": 100,
    "max_long_edge": 32000,
    "list_page_size": 20,
    "commit_concurrency": 8
  },
  "upload": {
    "max_items": 200,
    "browser_concurrency": 2,
    "raw_concurrency": 5
  },
  "import": {
    "keep_original_link": ["url", "jsonl", "weibo"],
    "auto_import": true,
    "fetch_timeout_seconds": 30,
    "max_items": 200
  },
  "weibo": {
    "max_items": 10,
    "source_enabled": true,
    "request_delay_seconds": [2, 5]
  },
  "normalize": {
    "concurrency": 2,
    "quality": 80,
    "quality_step": 5,
    "min_quality": 20,
    "max_long_edge": 4200,
    "max_size_kb": 500,
    "skip_webp_under_kb": 700
  }
}
```

`normalize.quality` 是首次 WebP 编码质量。输出超过 `normalize.max_size_kb` 时，会按超限倍数放大 `normalize.quality_step` 降低质量，最大不超过 `3 * quality_step`。某轮达标后会按原步进向上回补探测，最多补回本轮跳过的质量档位，尽量避免一次跳过可用画质。最低降到 `normalize.min_quality`；到达最低质量后即使仍超出目标体积，也会直接入库。尺寸会按比例缩小到 `normalize.max_long_edge` 以内，不会放大。

prepare 只接受 JPEG、PNG、WebP、GIF 与 AVIF；SVG、TIFF、HEIC 及其他 Sharp 虽能识别但不在白名单内的格式仍会拒绝。输入格式、原始尺寸和 EXIF 展示方向来自同一次 Sharp metadata，标准化后 WebP 的格式、尺寸与字节数来自最终编码结果，不二次解码候选文件。需要转码的 GIF、animated WebP 与 AVIF 使用 Sharp 默认的首帧处理语义；符合下述跳过条件的 animated WebP 则保留完整原字节。URL download 阶段执行的独立图片魔数检查仍是外部抓取安全边界，不由 prepare 的 Sharp 校验替代。

输入本身是 WebP、体积小于 `normalize.skip_webp_under_kb` 且长边已经达标时，原字节直接成为最终候选文件；服务端仍会执行解码校验、标准缩略图生成和最终 MD5 计算。`upload.browser_concurrency` 由单个活动页面的一个 FIFO owner 同时约束预览解码、短凭据请求和 raw PUT；同一次文件选择必须完成预览、短凭据和 raw 交接，后一次选择才可把预览排入该 lane。每个 intent 批次开始时读取页面 lane 的当前容量，当前批结算后才为下一批签发，避免后续预览饿死已经签发的 raw，也避免长队列预先消耗短 credential TTL。`upload.raw_concurrency` 在 Server 接收边界合计约束所有页面和直接 API 的流式 raw PUT。Import accept 后，URL、JSONL 与微博解析出的图片进入全进程 FIFO 后继窗口；`normalize.concurrency=N` 时，正在下载及已经下载但尚未取得图片处理许可的 Import 合计最多为 `N`。某项真正取得 Normalize 许可时让出后继名额，下一项才开始下载。Upload / Import 还共用一个由该值派生的 prepare / staging publication owner：两种来源合计最多有 `N` 项从等待 Normalize 推进到两个 `_uploads` 对象及 ready canonical 发布；后继 Import 在取得这个许可前只持有磁盘 raw，不生成 Prepared Buffer。图片重工作完成后释放中央 Normalize 许可，慢存储不会占用检查页维修或亮度重算所需的 CPU 准入。Sharp 每图线程固定为 `1`，由图片处理运行时统一设置。直接 API 与恢复后的 Import canonical 也进入相同 Server 边界，等待均支持取消。

微博访客握手和帖子元数据请求由一个全进程调度器串行执行；并行到达的批次每次各执行一项后轮转。进程只缓存一个访客身份，明确被上游拒绝时不重试当前帖子，而是清除身份并在下一项重新创建。相邻帖子请求按 `weibo.request_delay_seconds` 的 `[下界, 上界]` 均匀随机等待；图片链接解析完成后即离开该调度器，进入通用 Import 后继窗口。

最终入库只读取 `ingestion.commit_concurrency=N`，并在取得会话 advisory lock、存储共享锁和数据库事务连接之前限制整个 Server 进程。Ingestion Worker 由该值派生 `N + ceil(N / 2)` 个 commit dispatch slot；候补只提前完成 Redis runnable 发现，等待数量许可或字节许可的任务仍计入窗口，不形成另一项资源并发。提额会立即唤醒数量许可并补足候补，降额保留已活动项自然排空且停止新增任务。服务端另以代码内部的 FIFO 加权准入把 prepared 图片与缩略图活动字节限制在 `256 MiB`；超过该预算的单个合法对象只能在当前没有其他 commit 占用时独立运行。数量许可与字节许可都覆盖正式对象复制、数据库事务、暂存清理和缓存更新，而不只是 `INSERT`。正式提交后，同一 attempt 的 prepared image 与 thumbnail 作为一个 N=2 删除调用清理；只把逐项结果中仍为 `failed` / `unknown` 的键交给有界重试，整次请求没有可信结果时才保留两键。提交 intent 会先批量读取已提交结果、Redis 会话与重复内容快照，再由代码内固定 `10` 个 worker 建立意图，不占用最终入库配置。PostgreSQL 主查询连接池上限为 30；长生命周期 advisory lock 使用另一个上限同为 30 的专用连接池，避免下载、转码和存储 I/O 持锁期间占满查询连接。commit 的存储共享锁、排序后的主题 / 作者 / 最终标签共享关联租约、会话锁和单图锁由同一专用连接按固定顺序取得，不会在锁池内嵌套等待第二条连接；同 slug commit 可以并行并在共享租约内幂等确保词表项存在，显式词表管理和删除使用的独占锁仍会等待全部关联租约退出。锁连接丢失会中止工作，内容接入发布另以数据库 execution token 栅栏旧执行者。公开 PostgreSQL 回源在主池内最多占 12 条连接；当前单应用实例最多保留 60 条应用连接，数据库 `max_connections` 应为该边界和运维连接留足空间。

后台队列在建立不可变提交意图后先显示“提交排队 / 等待提交”，Server 将 Redis canonical 原子推进到 `committing` 后立刻返回 accepted；worker 真正取得上述数量与字节准入后才执行对象复制和 PostgreSQL 事务。事务提交后必须经 PostgreSQL 批量结果水合才完成。窗口将等待准入与等待结果合并为“等待中”，实际执行计入“处理中”，不把全部已选任务算作处理中。持有提交意图的任务锁定当时规范化后的 metadata，不能普通取消、移除或继续编辑；结果读取失败只允许重新获取结果。commit 边界的结构化重复冲突是例外：会话仍为 `ready`，前端不计失败并允许直接确认复用同一提交意图，或取消并清理该会话；两种动作都不新增逐图预检请求。

URL 输入窗口、JSONL 解析和微博解析共享 3600 项通用安全边界；JSONL 与微博还在服务端重复执行该边界。三者同时满足各自的可配置软上限：URL 与 JSONL 由 `import.max_items` 限制，最高 1000 项；微博链接条数由 `weibo.max_items` 限制，最高 50 条。微博解析后的图片数不受 `import.max_items` 影响；按单条微博最多 18 张图片计算，合法配置最多产生 900 张图片，服务端另保留不可配置的 1000 张安全上限。输入或解析结果超过限制时会在生成任务前明确拒绝，不自动拆成多个 `batch_time`。URL、JSONL 与微博都先在浏览器形成有序任务，随后通过一个固定的有界 Import accept JSON 请求批量创建或复用 canonical。所有条目内容只进入受限正文。本地文件通过有界 Upload intent 批次签发，Server 同时执行 `upload.max_items` 与通用 hard limit；每个已签发批次只有一次 intent POST 和至多 N 次纯字节 raw PUT。

## 高级配置

### 完整配置编辑

super 管理员可在「设置 → 高级配置」直接查看和编辑当前实例的完整 `data/config.json`。编辑器只包含应用运行策略，不包含代码中固定的监听端口或由环境变量管理的 PostgreSQL / Redis 连接值；它与下方用于跨实例迁移的配置包范围仍有 `site.domain` 等差异。

“格式化”只在浏览器内重新缩进 JSON；“重新读取”会在存在未保存修改时要求确认；“保存配置”先由服务端按完整运行时 schema 严格预检，再显示实际风险并要求确认。完整编辑采用精准 schema，缺少字段、未知字段、类型错误或越界值都会拒绝保存，不会执行启动时的默认值补齐或未知字段删除。

完整配置的格式化和重新读取直接显示在对应按钮内；校验成功由下一步确认窗口表示，失败留在保存按钮。确认保存、配置包导出和配置包导入成功后关闭对应窗口，失败留在确认按钮供重试。编辑器卡片头部的稳定区域只承载没有可见按钮时的首次读取或外部刷新失败，不会压缩代码编辑区。字段级 slug 冲突与重命名校验仍紧邻对应输入框。

精准 schema 的完整说明位于“完整 config.json”标题的悬停提示中；移动端隐藏页面头部的重复功能概述，为编辑器和操作按钮保留稳定空间。操作失败仅显示简短中文提示，完整异常写入后台应用日志。

保存使用同目录临时文件；临时文件完成 `fsync` 后原子重命名，并在支持目录同步的平台同步父目录，再替换内存配置并通知热加载监听器。这会同时防止进程中断造成半写文件，并尽量保证突然掉电后仍保留已发布的新版本；最终持久性仍受底层文件系统和存储硬件保证约束。`site.domain` 变化会提示当前访问地址可能失效。完整配置接口和响应均禁止缓存，且仅允许 super 管理员访问。

### 配置包

配置包导出使用 Web 唯一 API 原始响应入口，保留文件名与 Blob 下载。401 与其他受保护请求一样清除 CSRF 并触发既有认证过期处理，不增加 `/auth/me` 轮询；临时下载节点和对象 URL 在结束时释放。

super 管理员可在「设置 → 高级配置」导出或导入 JSON 配置包。当前版本导出的 `format` 固定为 `imageshow-config`，并始终写出当前完整字段；导入不以 `format`、`application_version` 或 `exported_at` 作为准入条件，三者只在能够识别时作为来源提示展示。目标版本不比较来源版本，也不维护旧字段 alias、版本白名单、双读或格式迁移链。

预览和正式导入共用同一个目标版本投影入口。运行时配置以目标版本的当前默认配置为基线，只采用名称仍存在且类型、范围及字段组合均满足当前 schema 的值；缺失字段使用当前默认值，未知、已删除或错误字段被忽略，单个坏值不会拒绝其余可识别内容。`site.domain` 不属于可移植结构，即使来源文件手工加入也会忽略，目标实例继续保留自己的域名。

`storage_backends` 按来源顺序逐条识别。当前已知字段能够组成合法 S3 后端时采用，并忽略条目中的额外未知字段；缺少必要结构、当前已知字段错误、slug 重复、停用却声明为默认，或在同一包中成为第二个默认后端的条目会单独跳过，不影响其他条目。预览明确列出采用的运行时配置项、使用默认值的运行时配置项、忽略的运行时配置字段和跳过后端数量，再由管理员确认；顶层来源提示、后端及 S3 中被宽松剥离的额外字段不计入运行时配置字段数量。配置包必须能解析为 JSON 对象；其正文最大 1 MiB，来源 `storage_backends` 数组在跳过坏条目前仍最多允许 100 项。

配置包用于把可迁移的站点行为和存储连接复制到新实例：

- `config` 包含站点展示、上传 / 导入、图片处理、后台、安全验证和日志等运行时配置，但排除 `site.domain`。监听端口由目标版本的代码固定，PostgreSQL / Redis 连接由目标实例自己的环境变量提供；三者均不进入配置包。
- `storage_backends` 包含自定义 S3 后端的显示名、slug、启停状态、默认状态、顺序和完整连接配置。内置 `local` 不导出。
- 管理员账号、图片及其标签 / 主题 / 作者、内容接入会话、后台任务和 Redis 缓存不属于配置包。
- ALTCHA 的 HMAC 主密钥在首次签发挑战时随机生成并仅驻留进程内存，不属于配置项或配置包；应用重启后，重启前尚未提交的证明需要重新验证。当前单应用实例在每次重启后生成新的主密钥，因此重启前的未提交证明自然失效。

导出的 S3 Secret Key 是恢复连接所必需的，因此会以明文出现在文件中。点击导出按钮后必须先确认敏感凭据提示；导出响应禁止缓存，但下载后的文件仍应按敏感凭据保管，使用后及时移出共享下载目录。导入按钮选择文件并完成服务端预检后，会在模态窗口中展示摘要、待新增后端和 slug 重命名。

导入前会先进行只读预检。被目标版本采用且不存在的 slug 会新增；若某个 slug 已存在，必须为导入后端指定新的合法 slug。系统不会覆盖、合并或跳过同名后端，改名后的 slug 也不能是 `local`、现有 slug 或同一批中的另一个目标。应用时再次检查当前注册表，以防预检之后发生竞态。全部存储后端在同一数据库事务内写入。进程内所有运行时配置写入共用一条 FIFO 写租约；普通设置、高级配置保存和磁盘重载都先完成所需的原子文件持久化，再替换进程内快照并通知 listener。配置包导入会持有租约直到完成数据库结果核对并作出收敛决定：候选 `config.json` 仍在 PostgreSQL `COMMIT` 前原子写入，文件写入失败会阻止提交，但这一阶段不替换内存快照，也不通知 listener；写入若在 rename 已生效、父目录同步尚未完成时抛错，系统知道 `COMMIT` 尚未发送，会在同一租约内原子恢复旧文件。写租约同时阻止手动重载插入该窗口。

正常 `COMMIT` 后只发布候选内存快照一次。若提交回包丢失，系统用该事务自身的 xid8 receipt 查询 PostgreSQL，不根据业务行猜测：确认 committed 时按成功收敛并发布一次；确认 rolled back 时原子恢复导入前文件，内存快照和 listener 始终保持旧值。旧文件恢复失败会记录 `config_package_file_restore_failed` 结构化错误并返回 503，此时应立即检查 `config.json`，再到检查页与存储管理页核对后端注册表并人工恢复。结果仍为 unknown 时不盲目回滚候选文件，而是把同一候选发布到活进程一次并返回 503 `config_package_outcome_unknown`；管理员应在检查页核对 PostgreSQL 与存储后端注册表后，决定恢复旧文件或重新导入，不存在后台轮询、重试或第二套恢复状态。运行配置 listener 是单进程同步回调；单个 listener 抛错只记录 `runtime_config_listener_failed`，其余 listener 继续执行，已持久化配置和已确认提交不会被逆转。

配置文件与 PostgreSQL 是两个独立资源，无法组成真正的跨资源原子事务。若在配置文件写入后遭遇 SIGKILL、容器崩溃或主机断电，仍存在配置已更新而数据库事务已回滚的极小不一致窗口。此时需人工恢复导入前的 `config.json`，或确认当前后端注册表后重新导入配置包。

## 环境变量

`.env` 为 Compose 提供插值，默认 `compose.yaml` 以映射形式逐项构成 ImageShow 与 PostgreSQL 的容器环境。默认模型包含空数据首次启动所需的部署级最小值，并按职责顺序排列：

### PostgreSQL 必要身份

- 进入的目标与变量：ImageShow：`DATABASE_NAME=imageshow`、`DATABASE_USER=imageshow`、`DATABASE_PASSWORD` 必填且无默认值；PostgreSQL：由同一组值转换出的 `POSTGRES_DB`、`POSTGRES_USER`、`POSTGRES_PASSWORD`。

### 首次管理员

- 进入的目标与变量：ImageShow：`ADMIN_USERNAME=admin`、`ADMIN_PASSWORD` 必填且无默认值；只在数据库没有 super 时由应用读取。

### 首次站点配置

- 进入的目标与变量：ImageShow 默认映射 `SITE_DOMAIN` 与 `SITE_GALLERY_PUBLIC_ORIGINAL_BUTTON`，分别使用 `${SITE_DOMAIN:-}` 和 `${SITE_GALLERY_PUBLIC_ORIGINAL_BUTTON:-false}`；只在配置文件不存在时播种域名和访客原图按钮配置。强烈建议在 `.env` 设置实际域名。

ImageShow 与 PostgreSQL 在各自 `environment` 中直接插值同一组数据库名、用户名和密码，这三项位于 `imageshow.environment` 前部，`ADMIN_*`、`SITE_DOMAIN` 和 `SITE_GALLERY_PUBLIC_ORIGINAL_BUTTON` 依次跟随。内置拓扑使用 Server 的 `UTC`、`postgresql:5432`、`redis:6379/0` 代码默认值；Redis 服务在项目私有网络内采用无密码连接。所有默认变量均使用明确插值；`SITE_DOMAIN` 未设置时传入空值，使用访问 Host 与同源资源路径的基础回退，不会自动发现或持久化一个站点域名。两个密码使用 `:?` 必填插值，未设置或空值都会在 Compose 展开阶段失败；部署者必须分别提供不同的随机强密码。数据库名、数据库用户名和管理员用户名继续使用当前默认值。

本地开发或自动化测试可用 `IMAGESHOW_DEVELOPMENT_DATA_DIRECTORY` 将配置、存储、临时文件和日志整体指向一次性隔离目录，避免测试触碰仓库的真实 `data/`。该变量在 `NODE_ENV=production` 时被忽略，生产容器的数据目录仍固定为 `/app/data`。

`.env.example` 提供全部 RuntimeConfig 首次播种变量目录；默认应用容器环境只注入上述设置。变量名严格由完整路径转成大写下划线，不增加类型后缀，例如 `site.root → SITE_ROOT`、`embed.allowed_origins → EMBED_ALLOWED_ORIGINS`、`weibo.request_delay_seconds → WEIBO_REQUEST_DELAY_SECONDS`。除默认已有的 `SITE_DOMAIN` 与 `SITE_GALLERY_PUBLIC_ORIGINAL_BUTTON` 外，部署者确需启用其他值时，必须在 `services.imageshow.environment` 中逐项增加映射并重建，例如：

```yaml
services:
  imageshow:
    environment:
      SITE_ROOT: ${SITE_ROOT:?set SITE_ROOT}
      EMBED_ALLOWED_ORIGINS: ${EMBED_ALLOWED_ORIGINS:?set EMBED_ALLOWED_ORIGINS}
```

在加入映射前先为变量设置合法值；示例使用 `:?` 让缺失或空值在 Compose 展开时直接失败。允许空字符串且确实要保留该语义的字段使用 `${VARIABLE:-}`；其余 RuntimeConfig 首次播种值均以显式键值映射逐项加入应用容器。

`.env.example` 同时列出可选部署覆盖。只有外部拓扑或自定义时区确实需要时，才逐项映射 `DATABASE_HOST`、`DATABASE_PORT`、`REDIS_HOST`、`REDIS_PORT`、`REDIS_DB`、`REDIS_PASSWORD` 或 `TZ`；这些覆盖值通过 Compose 的显式映射生效。数据库名、用户名和密码仍是默认 Compose 持续注入的部署身份；默认 Compose 也持续要求首次管理员用户名和密码，已有 super 时应用沿用 PostgreSQL 中的现有账号。

字符串保留空值语义，数字保留 `0`，布尔保留 `false`。数字必须是无首尾空白的有限 JSON 数字；布尔只接受 `true`、`false`。数组和映射使用严格 JSON，不支持逗号列表、JSONC、重复对象键或静默跳过非法成员。可复制示例：

```ini
SITE_DESCRIPTION=""
NORMALIZE_SKIP_WEBP_UNDER_KB=0
SITE_ROBOTS_ENABLED=false
SITE_HOME_BANNER_TITLE="我们一起，\n收藏这些瞬间。"
EMBED_ALLOWED_ORIGINS='["https://portal.example.com","https://*.trusted.example.net"]'
```

对应的复杂配置纯 JSON 片段为：

```json
{
  "site": {
    "gallery": {
      "public_original_button": false
    },
    "home": {
      "banner_title": "我们一起，\n收藏这些瞬间。"
    }
  },
  "embed": {
    "allowed_origins": [
      "https://portal.example.com",
      "https://*.trusted.example.net"
    ]
  }
}
```

Server 在首次生成前把所有已设置 seed 合并到代码默认值，再执行完整 strict schema 与交叉字段校验。非法变量会同时报告环境变量名与配置路径；任一失败都不会写出部分配置。部署连接仍在每次进程启动时解析：数据库名、用户名和密码缺失会拒绝启动，其余连接项缺失时使用代码默认值。`config.json` 一旦存在，即使容器里残留非法 seed，启动和手动重载也只处理文件，不会让 seed 覆盖、拒绝或改写合法文件。
