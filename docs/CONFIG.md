# 配置说明

本页逐项说明应用配置和部署环境变量。部署步骤见[部署说明](DEPLOY.md)，存储后端的连接设置见[存储指南](guide/storage.md)。

## 修改与生效

应用配置保存在 `data/config.json`，容器内路径为 `/app/data/config.json`。超级管理员可在「设置 → 高级配置」编辑完整配置，常用项也可在普通设置页修改；每项说明会标出可用的普通设置入口。直接编辑文件后，需在后台点击「读取配置文件」或重启应用。

配置文件使用纯 JSON，不支持注释。启动和读取文件时会补齐缺失项、删除未知项并保留合法值；已知项的值非法时会报错。高级配置编辑器要求提交完整、合法的配置，不会替你补齐遗漏字段。配置加载成功后影响后续操作；图片处理设置不会自动重新处理已入库图片，页面默认值必要时需刷新或重新进入页面才能看到。

环境变量的修改规则见[环境变量](#环境变量)。管理员账号、个人外观、作者信息和存储后端在对应后台页面管理，不属于 `config.json`。

## RuntimeConfig 参数目录

以下列出 `config.json` 的全部配置项。数值除明确注明外均为整数；`KiB` 为 1024 字节，`MiB` 为 1024 KiB，`px` 为像素，时间项按名称使用秒。

每项列出的环境变量只在配置文件不存在时用于生成初始值。已有配置文件时，以文件为准。Compose 标为“默认注入”的变量已在仓库部署清单中映射；“显式映射”表示使用前需自行加入清单，单独填写 `.env` 不会生效。

### site

#### site.name

- 环境变量：`SITE_NAME`
- Compose：显式映射
- 类型、默认值与范围：字符串；默认 `"ImageShow"`；去空白后非空

站点显示名称，用于浏览器标题、导航和后台。可在普通设置页修改。

#### site.domain

- 环境变量：`SITE_DOMAIN`
- Compose：默认注入
- 类型、默认值与范围：字符串；默认 `"example.com"`；0–259 字符，空值或 DNS 域名，可带 1–65535 端口

站点对外访问的域名，例如 `img.example.com`，不要填写协议或路径；需要指定端口时可写成 `img.example.com:8443`。设置实际域名后，其他域名的访问会返回 404，因此修改前应先准备好对应域名和反向代理。空值或 `example.com` 表示使用当前访问域名，不限定一个固定域名。

#### site.description

- 环境变量：`SITE_DESCRIPTION`
- Compose：显式映射
- 类型、默认值与范围：字符串；默认 `"画廊与随机图片API"`；去空白后 0–200 字符

站点的网页描述，供浏览器页面信息和搜索引擎使用，不是首页横幅正文。设为空字符串时使用站点名称。

#### site.icon

- 环境变量：`SITE_ICON`
- Compose：显式映射
- 类型、默认值与范围：字符串；默认 `"/assets/brand/favicon.svg"`；1–2048 字符的站内绝对路径或 HTTPS URL

浏览器标签页等位置使用的站点图标。可以填写站内绝对路径，例如 `/assets/brand/favicon.svg`，或外部 HTTPS 图片地址。

#### site.version.enabled

- 环境变量：`SITE_VERSION_ENABLED`
- Compose：显式映射
- 类型、默认值与范围：布尔；默认 `true`

是否在后台显示版本信息卡片。关闭只隐藏版本信息，不影响应用运行和升级。

#### site.version.link_enabled

- 环境变量：`SITE_VERSION_LINK_ENABLED`
- Compose：显式映射
- 类型、默认值与范围：布尔；默认 `true`

后台版本信息是否可点击跳转到对应的 GitHub Release。仅在 `site.version.enabled=true` 时有可见效果。

#### site.root

- 环境变量：`SITE_ROOT`
- Compose：显式映射
- 类型、默认值与范围：枚举；默认 `"home"`；`home`、`show`、`gallery`

访问站点根路径 `/` 时展示的页面：`home` 为首页，`show` 为展映，`gallery` 为画廊。如果所选页面已关闭，会依次选择仍启用的画廊、展映或首页；三者都关闭时返回 404。可在普通设置页修改。

#### site.home.enabled

- 环境变量：`SITE_HOME_ENABLED`
- Compose：显式映射
- 类型、默认值与范围：布尔；默认 `true`

是否开放公开首页及 `/home` 入口。关闭后，原本指向首页的访问会使用仍启用的公开页面；全部公开页面关闭时返回 404。嵌入首页还需要开启 `embed.enabled`。

#### site.home.browse_target

- 环境变量：`SITE_HOME_BROWSE_TARGET`
- Compose：显式映射
- 类型、默认值与范围：枚举；默认 `"show"`；`gallery`、`show`

首页选择筛选条件后进入的图片页面：`show` 为展映，`gallery` 为画廊。目标页面关闭时改用另一个仍启用的图片页面；两者都关闭时浏览入口不可用。嵌入首页使用对应的嵌入页面。

#### site.home.background

- 环境变量：`SITE_HOME_BACKGROUND`
- Compose：显式映射
- 类型、默认值与范围：字符串；默认 `""`；空值或最长 2048 字符的站内绝对路径 / HTTPS URL

首页背景图片。空字符串表示使用本站随机图；指定站内绝对路径或 HTTPS 地址后使用固定背景。可在普通设置页修改。

#### site.home.banner_label

- 环境变量：`SITE_HOME_BANNER_LABEL`
- Compose：显式映射
- 类型、默认值与范围：字符串；默认 `"ImageShow · A FAN-MADE PHOTO HANDBOOK"`；1–160 字符

首页主标题上方的短标识文字，可填写站点定位、主题或简短介绍。可在普通设置页修改。

#### site.home.banner_title

- 环境变量：`SITE_HOME_BANNER_TITLE`
- Compose：显式映射
- 类型、默认值与范围：字符串；默认 `"我们一起，\n收藏这些瞬间。"`；1–80 字符，可换行

首页主标题，支持换行。编辑 JSON 时用 `\n` 表示换行；在普通设置页可直接输入多行文字。

#### site.show.enabled

- 环境变量：`SITE_SHOW_ENABLED`
- Compose：显式映射
- 类型、默认值与范围：布尔；默认 `true`

是否开放展映页面 `/show`。嵌入展映 `/embed/show` 还需要开启 `embed.enabled`。关闭后，指向展映的访问会使用仍启用的公开页面。

#### site.show.autoplay

- 环境变量：`SITE_SHOW_AUTOPLAY`
- Compose：显式映射
- 类型、默认值与范围：布尔；默认 `true`

进入展映时是否自动播放。设为 `false` 时初始暂停，访客仍可手动播放、暂停、拖动和缩放；系统启用“减少动态效果”时优先保持暂停。修改后重新进入或刷新展映页面采用新值，同一次浏览中切换模式或筛选不会重置播放状态。

#### site.show.mode

- 环境变量：`SITE_SHOW_MODE`
- Compose：显式映射
- 类型、默认值与范围：枚举；默认 `"waterfall"`；`waterfall`、`float`

展映的默认布局：`waterfall` 为瀑布流，`float` 为漂浮图片。链接中显式指定的 `mode` 优先；访客手动切换只影响当前浏览链接，不修改站点配置。

#### site.show.density

- 环境变量：`SITE_SHOW_DENSITY`
- Compose：显式映射
- 类型、默认值与范围：枚举；默认 `"balanced"`；`relaxed`、`balanced`、`dense`

展映的初始图片密度。`relaxed` 较疏、`balanced` 适中、`dense` 较密；瀑布流对应较少、标准、较多列，漂浮模式对应较大、标准、较小图片。访客可以在展映中继续调整，不会保存为全站配置。

#### site.show.drift_speed

- 环境变量：`SITE_SHOW_DRIFT_SPEED`
- Compose：显式映射
- 类型、默认值与范围：整数；默认 `28`；10–60 CSS px/s

展映自动播放的基准移动速度，单位为每秒屏幕像素。数值越大移动越快；漂浮模式中不同图片会略有速度差异。此项不改变手动拖动和缩放速度。

#### site.show.order

- 环境变量：`SITE_SHOW_ORDER`
- Compose：显式映射
- 类型、默认值与范围：枚举；默认 `"random"`；`random`、`latest`、`oldest`

展映默认顺序：`random` 乱序，`latest` 按图片时间从新到旧，`oldest` 从旧到新。链接中显式指定的 `order` 优先，访客切换顺序不修改站点配置。

#### site.gallery.enabled

- 环境变量：`SITE_GALLERY_ENABLED`
- Compose：显式映射
- 类型、默认值与范围：布尔；默认 `true`

是否开放画廊页面 `/gallery`。嵌入画廊 `/embed/gallery` 还需要开启 `embed.enabled`。关闭后，指向画廊的访问会使用仍启用的公开页面。

#### site.gallery.order

- 环境变量：`SITE_GALLERY_ORDER`
- Compose：显式映射
- 类型、默认值与范围：枚举；默认 `"latest"`；`random`、`latest`、`oldest`

画廊默认排序：`random` 乱序，`latest` 按图片时间从新到旧，`oldest` 从旧到新。访客可在页面切换并保留筛选条件。可在普通设置页修改。

#### site.gallery.public_original_button

- 环境变量：`SITE_GALLERY_PUBLIC_ORIGINAL_BUTTON`
- Compose：显式映射
- 类型、默认值与范围：布尔；默认 `false`

是否向未登录访客显示图片详情中的原图按钮，适用于画廊和展映。`false` 隐藏访客按钮，`true` 允许显示；已登录管理员不受此开关影响。只有图片具有与展示图不同的合法 HTTPS 原图时才显示按钮。

此项只控制详情中的入口。`/images/original/<id>` 原图地址始终公开，知道地址的用户仍可直接访问。已有安装需在配置文件或高级配置中修改，重设环境变量不会覆盖文件。

#### site.random_method

- 环境变量：`SITE_RANDOM_METHOD`
- Compose：显式映射
- 类型、默认值与范围：枚举；默认 `"redirect"`；`proxy`、`redirect`

随机图入口 `/random` 未指定返回方式时采用的行为。`redirect` 跳转到图片地址，`proxy` 由站点直接返回图片内容；后者会占用站点传输带宽。调用方可以用 `mode` 参数覆盖默认值，也可以显式请求 `mode=json` 获取图片信息。可在普通设置页修改。

#### site.robots_enabled

- 环境变量：`SITE_ROBOTS_ENABLED`
- Compose：显式映射
- 类型、默认值与范围：布尔；默认 `false`

是否提供 `/robots.txt`。`false` 时该路径返回 404；`true` 时仅允许爬虫抓取已启用的首页，禁止抓取画廊、接口、图片资源和后台。这是给爬虫的访问约定，不限制用户直接访问。

### embed

#### embed.enabled

- 环境变量：`EMBED_ENABLED`
- Compose：显式映射
- 类型、默认值与范围：布尔；默认 `false`

是否开放 `/embed/home`、`/embed/show` 和 `/embed/gallery`，供其他网页通过 iframe 嵌入；对应的首页、展映或画廊也必须启用。默认允许本站同源页面嵌入；配置实际站点域名后，还允许该域名的 HTTPS 来源及同端口子域。其他来源通过 `embed.allowed_origins` 添加。

#### embed.allowed_origins

- 环境变量：`EMBED_ALLOWED_ORIGINS`
- Compose：显式映射
- 类型、默认值与范围：严格 JSON 数组；默认 `[]`；最多 32 个 HTTPS DNS origin，每项不超过 320 字符且总长不超过 4096 字符

额外允许嵌入本站的网页来源，例如 `["https://portal.example.com", "https://*.trusted.example.net"]`。精确地址只允许对应来源；最左侧的 `*.` 允许该域名下的子域。来源可带端口，但不能包含路径、账号密码、IP 地址或 HTTP 协议。

只填写自己信任的站点，不要将公共托管平台的整个域名设为通配来源。空数组表示不额外放行来源，不会取消本站的默认嵌入范围。

### ingestion

#### ingestion.max_file_size_mb

- 环境变量：`INGESTION_MAX_FILE_SIZE_MB`
- Compose：显式映射
- 类型、默认值与范围：数值；默认 `100`；大于 0 且不超过 200 MiB

本地上传和远程导入共用的单张原始图片体积上限，超过时拒绝接收。该值针对处理前的文件；成品压缩目标由 `normalize.max_size_kb` 设置。调高会允许更大的原图，也增加传输、临时空间和图片处理的资源需求。

#### ingestion.max_long_edge

- 环境变量：`INGESTION_MAX_LONG_EDGE`
- Compose：显式映射
- 类型、默认值与范围：整数；默认 `32000`；300–32000 px

允许接收的原始图片长边上限，长边是宽、高中的较大值。超过时拒绝接收，不会先缩小再接受；入库图片的缩小尺寸由 `normalize.max_long_edge` 决定。

#### ingestion.list_page_size

- 环境变量：`INGESTION_LIST_PAGE_SIZE`
- Compose：显式映射
- 类型、默认值与范围：整数；默认 `20`；1–100 项

上传、导入队列和批量编辑列表每页显示的项目数。只影响列表分页，不限制一次可提交的总数量。可在普通设置页修改。

#### ingestion.commit_concurrency

- 环境变量：`INGESTION_COMMIT_CONCURRENCY`
- Compose：显式映射
- 类型、默认值与范围：整数；默认 `8`；1–16

服务器同时进行最终入库的图片数上限，由所有上传和导入任务共同使用。调高可能提高入库速度，也会增加数据库、存储和内存压力；实际同时执行数量还受可用资源限制。修改后影响后续任务，已经开始的任务继续完成。可在普通设置页修改。

### upload、import 与 weibo

#### upload.max_items

- 环境变量：`UPLOAD_MAX_ITEMS`
- Compose：显式映射
- 类型、默认值与范围：整数；默认 `200`；1–1000 项

本地上传一次可选择和创建的文件数量上限。超出时需分批上传；每张图片仍分别受原始体积和尺寸限制。

#### upload.browser_concurrency

- 环境变量：`UPLOAD_BROWSER_CONCURRENCY`
- Compose：显式映射
- 类型、默认值与范围：整数；默认 `2`；1–8

单个活动上传页面同时推进的文件数量，包括预览准备和文件传输。调高可能加快上传，但会增加浏览器内存和网络占用；多个页面仍共同受服务器接收能力限制。修改后影响后续文件，可在普通设置页修改。

#### upload.raw_concurrency

- 环境变量：`UPLOAD_RAW_CONCURRENCY`
- Compose：显式映射
- 类型、默认值与范围：整数；默认 `5`；1–8

服务器同时接收本地上传文件的数量上限，由所有客户端共享。超过容量的请求等待空位。调低后已开始的传输继续完成，后续文件按新上限进入。

#### import.keep_original_link

- 环境变量：`IMPORT_KEEP_ORIGINAL_LINK`
- Compose：显式映射
- 类型、默认值与范围：严格 JSON 字符串数组；默认 `["url", "jsonl", "weibo"]`；成员仅可为 `url`、`jsonl`、`weibo`，规范化去重，空白名单为 `[]`

哪些导入来源保留原始图片链接：`url` 为 URL 导入，`jsonl` 为 JSONL 导入，`weibo` 为微博导入。未列出的来源仍正常下载和入库，只是不自动保留原图链接；`[]` 表示全部不保留。

修改影响后续导入及尚未确认提交的任务，已经确认提交的内容和正式入库图片不会因此改写。是否向访客显示原图按钮由 `site.gallery.public_original_button` 单独控制。

#### import.auto_import

- 环境变量：`IMPORT_AUTO_IMPORT`
- Compose：显式映射
- 类型、默认值与范围：布尔；默认 `true`

解析内容没有问题项时，是否自动加入导入队列。`true` 直接开始，`false` 先展示解析结果、由管理员确认后开始；有问题项时仍需处理或确认。修改后影响新解析的内容。

#### import.fetch_timeout_seconds

- 环境变量：`IMPORT_FETCH_TIMEOUT_SECONDS`
- Compose：显式映射
- 类型、默认值与范围：整数；默认 `30`；5–300 秒

导入外部图片时，每次下载允许等待的最长时间。超时会使该项下载失败，可在解决网络或源站问题后重试。较大值适合较慢的源站，但失败请求也会占用更久。

#### import.max_items

- 环境变量：`IMPORT_MAX_ITEMS`
- Compose：显式映射
- 类型、默认值与范围：整数；默认 `200`；1–1000 项

一次 URL 或 JSONL 导入允许的图片条目数，超出时需拆成多个批次。微博链接数量由 `weibo.max_items` 控制，微博解析出的图片数不受本项限制。

#### weibo.max_items

- 环境变量：`WEIBO_MAX_ITEMS`
- Compose：显式映射
- 类型、默认值与范围：整数；默认 `10`；1–50 条

一次微博导入允许提交的微博链接数量，计数单位是帖子链接，不是图片。单条微博包含多张图片时，会分别生成图片任务。

#### weibo.source_enabled

- 环境变量：`WEIBO_SOURCE_ENABLED`
- Compose：显式映射
- 类型、默认值与范围：布尔；默认 `true`

微博导入是否保留帖子页面作为图片的来源链接。关闭后，尚未确认提交的任务不保存该来源；不影响图片下载，也不控制原图链接。

重新开启只影响新解析的内容，以及仍保留来源信息、尚未确认提交的任务；不会自动找回此前已省略的来源，也不会修改正式入库的图片。

#### weibo.request_delay_seconds

- 环境变量：`WEIBO_REQUEST_DELAY_SECONDS`
- Compose：显式映射
- 类型、默认值与范围：严格 JSON 二元整数数组；默认 `[2, 5]`；两项均为 0–60 秒且下界不高于上界

相邻微博帖子请求之间随机等待的秒数，格式为 `[最短时间, 最长时间]`。例如 `[2, 5]` 表示每次等待 2–5 秒，设为相同数值可固定间隔。较长间隔会降低请求频率并延长批次解析时间；修改不打断已经开始的等待。

### normalize 与 thumbnail

#### normalize.concurrency

- 环境变量：`NORMALIZE_CONCURRENCY`
- Compose：显式映射
- 类型、默认值与范围：整数；默认 `2`；1–8

服务器同时处理图片的数量上限，上传、导入、缩略图维修和亮度重算共同使用。调高可让更多图片同时处理，也会增加 CPU 和内存占用。修改后影响后续工作，可在普通设置页修改。

#### normalize.quality

- 环境变量：`NORMALIZE_QUALITY`
- Compose：显式映射
- 类型、默认值与范围：整数；默认 `80`；1–100

需要转换为 WebP 的图片所使用的初始质量。数值越高通常画质越好、文件越大；超过目标体积时还会逐步降低质量。符合 `normalize.skip_webp_under_kb` 保留条件的 WebP 不使用此项重新压缩。可在普通设置页修改。

#### normalize.quality_step

- 环境变量：`NORMALIZE_QUALITY_STEP`
- Compose：显式映射
- 类型、默认值与范围：整数；默认 `5`；1–50

成品超过目标体积时，降低压缩质量的基础步长。数值较大可减少尝试次数，但质量调整更粗；数值较小调整更细，处理可能更慢。质量不会低于 `normalize.min_quality`。

#### normalize.min_quality

- 环境变量：`NORMALIZE_MIN_QUALITY`
- Compose：显式映射
- 类型、默认值与范围：整数；默认 `20`；1–100，且不高于 `normalize.quality`

压缩图片时允许使用的最低质量，必须小于或等于初始质量。达到此值后即使文件仍超过目标体积，也会保留结果并入库，因此目标体积不是硬性拒绝线。可在普通设置页修改。

#### normalize.max_long_edge

- 环境变量：`NORMALIZE_MAX_LONG_EDGE`
- Compose：显式映射
- 类型、默认值与范围：整数；默认 `4200`；300–32000 px

入库展示图的最大长边。超过时按比例缩小，原图较小时不放大；此项控制处理结果，原始图片能否接收由 `ingestion.max_long_edge` 决定。可在普通设置页修改。

#### normalize.max_size_kb

- 环境变量：`NORMALIZE_MAX_SIZE_KB`
- Compose：显式映射
- 类型、默认值与范围：整数；默认 `500`；50–102400 KiB

入库展示图的目标体积。转换后的文件过大时会降低质量，最低到 `normalize.min_quality`；仍超出时允许入库。符合原字节保留条件的 WebP 也可能大于此目标。可在普通设置页修改。

#### normalize.skip_webp_under_kb

- 环境变量：`NORMALIZE_SKIP_WEBP_UNDER_KB`
- Compose：显式映射
- 类型、默认值与范围：整数；默认 `700`；0–102400 KiB

允许直接保留原始 WebP 的体积阈值。只有合法 WebP 的体积严格小于此值，且长边不超过 `normalize.max_long_edge` 时，才保留原字节，包括其中的动画；否则按图片处理设置转换，动画取首帧。设为 `0` 可关闭直接保留。

直接保留仍会生成缩略图；本项不放宽接收原始图片的体积、尺寸限制。可在普通设置页修改。

#### thumbnail.long_edge

- 环境变量：`THUMBNAIL_LONG_EDGE`
- Compose：显式映射
- 类型、默认值与范围：整数；默认 `512`；64–4096 px

新生成缩略图的最大长边，按比例缩小且不放大。较大值可提高预览清晰度，也会增加存储和加载流量。修改只影响之后生成的缩略图，不会自动重做已存图片。可在普通设置页修改。

#### thumbnail.quality

- 环境变量：`THUMBNAIL_QUALITY`
- Compose：显式映射
- 类型、默认值与范围：整数；默认 `75`；1–100

新生成 WebP 缩略图的质量。较高值通常更清晰、文件更大；修改不会自动重做已存缩略图。可在普通设置页修改。

### admin、security、altcha 与 log

#### admin.login_background

- 环境变量：`ADMIN_LOGIN_BACKGROUND`
- Compose：显式映射
- 类型、默认值与范围：字符串；默认 `""`；空值或最长 2048 字符的站内绝对路径 / HTTPS URL

管理员登录页的背景图片。空字符串表示使用本站随机图，也可指定站内绝对路径或 HTTPS 图片地址。可在普通设置页修改。

#### admin.image_page_size

- 环境变量：`ADMIN_IMAGE_PAGE_SIZE`
- Compose：显式映射
- 类型、默认值与范围：整数；默认 `60`；10–200 项

后台图片管理列表每页显示的图片数。较大值便于一次查看更多图片，但会增加单页加载量；不影响公开画廊和展映。可在普通设置页修改。

#### admin.recent_uploads

- 环境变量：`ADMIN_RECENT_UPLOADS`
- Compose：显式映射
- 类型、默认值与范围：整数；默认 `16`；1–60 项

后台概览中“最近上传”显示的图片数量，不限制图库总量或上传批次大小。可在普通设置页修改。

#### security.session_ttl_seconds

- 环境变量：`SECURITY_SESSION_TTL_SECONDS`
- Compose：显式映射
- 类型、默认值与范围：整数；默认 `604800`；300–31536000 秒

管理员登录会话的有效闲置时长，默认 604800 秒，即 7 天。登录成功或页面重新验证登录状态成功时更新期限；普通操作或一直挂着后台不保证无限续期。修改影响新登录和后续续期，过期后需要重新登录。

#### security.login_failure_window_seconds

- 环境变量：`SECURITY_LOGIN_FAILURE_WINDOW_SECONDS`
- Compose：显式映射
- 类型、默认值与范围：整数；默认 `60`；30–300 秒

同一访问 IP 与用户名组合的登录尝试统计窗口，与 `security.login_max_failures` 配合。窗口越长，连续失败后的限制持续越久；该组合成功登录后会清除其计数。

#### security.login_max_failures

- 环境变量：`SECURITY_LOGIN_MAX_FAILURES`
- Compose：显式映射
- 类型、默认值与范围：整数；默认 `5`；3–500 次

同一 IP 与用户名组合在上述窗口内允许的登录尝试次数。达到限制后继续尝试会被暂时拒绝，需稍后再试；成功登录会清除该组合的计数。较低值限制更严格，也更容易影响连续输错密码的管理员。

#### security.login_global_window_seconds

- 环境变量：`SECURITY_LOGIN_GLOBAL_WINDOW_SECONDS`
- Compose：显式映射
- 类型、默认值与范围：整数；默认 `180`；60–600 秒

全站登录尝试的统计窗口，与 `security.login_global_max_attempts` 配合，所有 IP 和用户名共同计数。它用于限制总登录频率，不因某个账号登录成功而清空。

#### security.login_global_max_attempts

- 环境变量：`SECURITY_LOGIN_GLOBAL_MAX_ATTEMPTS`
- Compose：显式映射
- 类型、默认值与范围：整数；默认 `10`；5–1000 次

全站在上述窗口内允许的登录尝试总次数。达到限制后，其他来源的登录也需等待；多人使用的实例应为正常登录保留足够余量。该项与单个 IP、用户名组合的限制同时生效。

#### altcha.enabled

- 环境变量：`ALTCHA_ENABLED`
- Compose：显式映射
- 类型、默认值与范围：布尔；默认 `true`

是否启用登录时的自托管 ALTCHA 验证。开启后，浏览器需完成验证才能提交登录；关闭不取消账号密码校验和登录频率限制。修改影响之后获取的登录验证。

#### altcha.ttl_seconds

- 环境变量：`ALTCHA_TTL_SECONDS`
- Compose：显式映射
- 类型、默认值与范围：整数；默认 `300`；90–3600 秒

一次登录验证的有效时间。超过后需要重新获取并完成验证；较短时间减少验证结果可使用的时长，也更容易影响较慢设备。修改影响新发起的验证。

#### altcha.cost

- 环境变量：`ALTCHA_COST`
- Compose：显式映射
- 类型、默认值与范围：整数；默认 `5000`；1000–100000

单次验证计算的成本。数值越大，浏览器需要的计算时间通常越长；应结合较慢的手机设置，避免登录等待过久。它与 `altcha.counter_range` 上界的乘积不能超过 100000000，修改影响新发起的验证。

#### altcha.counter_range

- 环境变量：`ALTCHA_COUNTER_RANGE`
- Compose：显式映射
- 类型、默认值与范围：严格 JSON 二元整数数组；默认 `[2000, 5000]`；两项均为 100–100000，下界不高于上界，且 `cost × 上界 <= 100000000`

每次登录验证工作量的取值范围，格式为 `[下界, 上界]`。较大的范围值会增加可能的计算量和耗时；下界不能大于上界，且上界必须满足与 `altcha.cost` 的乘积限制。修改影响新发起的验证。

#### log.level

- 环境变量：`LOG_LEVEL`
- Compose：显式映射
- 类型、默认值与范围：枚举；默认 `"WARN"`；`DEBUG`、`INFO`、`WARN`、`ERROR`、`OFF`

记录到控制台和文件的最低日志级别：`DEBUG` 包含调试信息，`INFO` 包含日常运行信息，`WARN` 仅记录警告和错误，`ERROR` 仅记录错误，`OFF` 关闭日志。调试级别会产生更多内容；可在后台日志页修改，立即影响后续记录。

#### log.max_size_mb

- 环境变量：`LOG_MAX_SIZE_MB`
- Compose：显式映射
- 类型、默认值与范围：数值；默认 `10`；大于 0 且不超过 1024 MiB

当前日志文件达到该体积后，在后续写入时换用新文件，并将原文件保留为历史日志。单条日志可能使文件略微超过阈值；此项不是整个日志目录的容量上限。

#### log.max_files

- 环境变量：`LOG_MAX_FILES`
- Compose：显式映射
- 类型、默认值与范围：整数；默认 `5`；1–100 个文件

轮转时保留的历史日志文件数量，不包含当前正在写入的 `app.log`。超过保留数量时，轮转会淘汰最早的历史文件；修改影响后续轮转。

## 环境变量

`.env` 是 Docker Compose 的变量来源，只有 `compose.yaml` 中显式映射的值才会进入容器。修改已映射的部署变量后，用 `docker compose up -d` 重新创建受影响的容器；已有 `config.json` 时，应用配置的环境变量不再覆盖文件。

### 数据库、管理员与时区

下表默认值以仓库 Compose 部署为准。数据库名、用户和密码同时供应用与内置 PostgreSQL 使用；接入现有数据库时，应填写实际身份，修改变量不会替现有数据库改名或重设账号密码。

| 变量 | 默认值与要求 | 用途 |
| --- | --- | --- |
| `DATABASE_NAME` | `imageshow`；非空 | ImageShow 使用的 PostgreSQL 数据库名。 |
| `DATABASE_USER` | `imageshow`；非空 | 连接该数据库的用户名。 |
| `DATABASE_PASSWORD` | 无默认值，必填且非空 | 数据库连接密码；使用独立的随机强密码。 |
| `DATABASE_HOST` | `postgresql`；非空 | PostgreSQL 主机名。默认连接 Compose 内置服务；外部数据库需额外映射此变量。 |
| `DATABASE_PORT` | `5432`；1–65535 | PostgreSQL 连接端口，自定义时需额外映射。 |
| `REDIS_HOST` | `redis`；非空 | Redis 主机名。默认连接 Compose 内置服务；外部 Redis 需额外映射。 |
| `REDIS_PORT` | `6379`；1–65535 | Redis 连接端口，自定义时需额外映射。 |
| `REDIS_DB` | `0`；0–15 | ImageShow 专用的 Redis 逻辑库编号，不要与其他应用混用。自定义时需额外映射。 |
| `REDIS_PASSWORD` | `""`；最多 512 字符 | Redis 密码。空值表示不认证；内置 Redis 使用私有网络且无密码，外部 Redis 按需额外映射。 |
| `ADMIN_USERNAME` | `admin`；1–32 字符 | 首个超级管理员的用户名，仅在数据库没有超级管理员时使用。自动去除首尾空白并转为小写，只允许字母、数字和连字符，首尾不能是连字符。 |
| `ADMIN_PASSWORD` | 无默认值，必填；8–128 字符且同时包含字母和数字 | 首个超级管理员的密码。已有账号时不会被此变量覆盖，日后在账号页面改密。 |
| `TZ` | `UTC`；IANA 时区名称 | 本地时间的解释和显示时区，例如 `Asia/Shanghai`；自定义时需额外映射。 |

默认 Compose 持续要求两个密码非空；管理员初始化完成后，仍应保留部署文件所需的变量。密码恢复步骤见[部署说明](DEPLOY.md#管理员密码恢复)。

### 应用配置的初始值

完整变量名和默认值见上方参数目录及根目录 `.env.example`。应用配置中，默认 Compose 仅映射 `SITE_DOMAIN`，未设置时传入空值。

需要使用其他初始值时，在 `.env` 填写合法值，并为 `services.imageshow.environment` 增加对应映射，例如：

```yaml
services:
  imageshow:
    environment:
      SITE_ROOT: ${SITE_ROOT:?set SITE_ROOT}
      EMBED_ALLOWED_ORIGINS: ${EMBED_ALLOWED_ORIGINS:?set EMBED_ALLOWED_ORIGINS}
```

布尔值只接受 `true`、`false`；数字不能带首尾空白；数组使用 JSON，不支持逗号列表。允许空字符串的项目可显式设为空，数字 `0` 和布尔 `false` 也会按原值使用。例如：

```ini
SITE_ROOT=gallery
SITE_DESCRIPTION=""
NORMALIZE_SKIP_WEBP_UNDER_KB=0
EMBED_ALLOWED_ORIGINS='["https://portal.example.com","https://*.trusted.example.net"]'
```

这些值只参与第一次生成配置文件。已有安装请修改配置文件或高级配置，避免误以为重新启动就会覆盖配置。

### 本地开发变量

| 变量 | 默认值与要求 | 用途 |
| --- | --- | --- |
| `NODE_ENV` | 源码运行默认 `development`，生产镜像设为 `production` | 区分运行环境；生产镜像的数据目录固定为 `/app/data`。 |
| `IMAGESHOW_DEVELOPMENT_DATA_DIRECTORY` | 未设置时使用当前工作目录下的 `data/` | 本地开发时指定独立的数据目录，涵盖配置、存储、临时文件和日志；生产环境忽略此变量。 |
