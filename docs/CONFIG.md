# 配置参考

本页列出全部配置项的默认值和取值范围，安装步骤见[安装与维护](DEPLOY.md)。

## 配置如何生效

- 配置保存在 `data/config.json`（容器内为 `/app/data/config.json`）。超级管理员可以在后台「设置 → 站点配置」修改本页的所有配置项。
- 直接编辑文件后，在后台点击「读取配置文件」或重启应用。文件是纯 JSON，不能写注释。
- 应用启动和读取文件时，会补上缺少的项、删除不认识的项，并在内容变化时写回文件。某一项的值不合法时会报错，整份配置不会生效。
- 配置文件不存在时（通常是第一次启动），应用用环境变量生成初始配置；文件存在后，这些初始配置变量不再覆盖文件。数据库、Redis 连接和时区等部署变量仍在每次启动时读取。
- 图片处理相关设置只影响之后添加的图片。
- 管理员账号、个人外观、主题标签作者和存储后端不在配置文件里，在后台对应页面管理。

如果保存时提示配置已被其他页面修改，先记下自己的改动，再读取配置文件核对最新值后重新保存。如果提示“配置文件已替换，但持久化确认失败”，先排查磁盘问题，再点击「读取配置文件」恢复；提示消失前不要把保存当作成功。

单位说明：KiB = 1024 字节，MiB = 1024 KiB；时间单位都是秒。数值除 `ingestion.max_file_size_mb` 和 `log.max_size_mb` 可用小数外，均使用整数。

## 站点

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `site.domain` | `"example.com"` | 主站域名，如 `img.example.com`，可带端口，不写协议和路径。设置后，除已配置的图片和静态资源域名外，其他域名返回 404。留空或保持 `example.com` 表示不限制域名 |
| `site.title` | `"ImageShow"` | 浏览器标签页上的网页标题，不能为空 |
| `site.header_name` | `"ImageShow"` | 页面顶部和后台显示的站点名称，不能为空 |
| `site.description` | `"画廊与随机图片API"` | 网页描述，供搜索引擎使用，最多 200 字；留空时使用网页标题 |
| `site.icon` | `""` | 站点图标，留空使用内置图标；可填以 `/` 开头的站内路径或 HTTPS 地址，最多 2048 字符。自定义图标见[自定义静态资源](#自定义静态资源) |
| `site.version.enabled` | `true` | 在后台显示版本信息 |
| `site.version.link_enabled` | `true` | 版本信息可点击打开 GitHub Release |
| `site.root` | `"home"` | 打开站点根路径 `/` 时显示的页面：`home` 首页、`gallery` 画廊、`show` 展映。所选页面关闭时，依次改用画廊、展映、首页 |
| `site.robots_enabled` | `false` | 提供 `/robots.txt`，只允许搜索引擎抓取首页。关闭时该地址返回 404 |
| `site.random_method` | `"redirect"` | `/random` 默认的返回方式：`redirect` 跳转到图片地址；`proxy` 由本站直接返回图片，会占用本站带宽 |
| `site.random_size` | `"medium"` | `/random` 默认的图片尺寸：`large`、`medium`、`small` |
| `site.random_fallback_order` | `["device","brightness","author","tag","theme"]` | 零匹配回退时 `all` 展开的顺序，五个维度各出现一次：`fallback=all` 按此顺序放宽全部维度，列表末尾的 `all` 按此顺序放宽其余维度；请求中写明的维度按书写顺序放宽 |
| `site.assets_base_url` | `""` | 前端静态文件的独立地址，见[静态资源地址](#静态资源地址) |

### 首页与页脚

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `site.home.enabled` | `true` | 开放首页 `/home` |
| `site.home.browse_target` | `"show"` | 在首页选好条件后进入的页面：`show` 展映或 `gallery` 画廊 |
| `site.home.background` | `""` | 首页背景图，留空使用本站随机图；可填以 `/` 开头的站内路径（如[自定义静态资源](#自定义静态资源)）或 HTTPS 地址，最多 2048 字符 |
| `site.home.banner_label` | `"ImageShow · A FAN-MADE PHOTO HANDBOOK"` | 首页大标题上方的小字，1–160 字 |
| `site.home.banner_title` | `"我们一起，\n收藏这些瞬间。"` | 首页大标题，1–80 字，在 JSON 中用 `\n` 换行 |
| `site.icp` | `""` | ICP 备案号，显示在首页底部并链接到备案查询网站，最多 200 字 |
| `site.mps` | `""` | 公安备案号，最多 200 字。只填备案号及其省份名称，其中的数字会用来生成查询链接 |
| `site.footer` | `""` | 自定义页脚，见[自定义页脚](#自定义页脚) |

首页底部依次显示 ICP 备案号、公安备案号和自定义页脚，三项都为空时不显示页脚。嵌入的首页只显示自定义页脚。

### 画廊与展映

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `site.gallery.enabled` | `true` | 开放画廊 `/gallery` |
| `site.gallery.order` | `"latest"` | 画廊默认排序：`latest` 最新优先、`oldest` 最旧优先、`random` 随机 |
| `site.show.enabled` | `true` | 开放展映 `/show` |
| `site.show.autoplay` | `true` | 进入展映时自动播放。系统开启了“减少动态效果”时保持暂停 |
| `site.show.mode` | `"waterfall"` | 展映默认模式：`waterfall` 瀑布流、`float` 漂浮、`cluster` 星群（按主题、标签或作者把图片聚成星团，不使用筛选） |
| `site.show.density` | `"balanced"` | 瀑布流与漂浮的默认密度：`relaxed` 宽松、`balanced` 均衡、`dense` 紧凑 |
| `site.show.drift_speed` | `28` | 自动播放速度，10–60 像素/秒；星群的转动速度按它与默认值的比例快慢 |
| `site.show.order` | `"random"` | 展映默认排序，取值同画廊 |

链接中的 `mode`、`order` 参数优先于这些默认值。访客在页面上的调整只影响自己当前的浏览。

### 自定义页脚

`site.footer` 最多 2000 字，支持纯文字，以及两种 HTML：`<a href="https://…">` 链接和 `<br>` 换行。链接必须是 HTTPS，会在新标签页打开；其他 HTML 标签不显示，也不支持 Markdown。

```json
"footer": "Powered by <a href=\"https://github.com/wozsun/ImageShow\">ImageShow</a>"
```

用环境变量设置时，用单引号包住整个值：

```ini
SITE_FOOTER='Powered by <a href="https://github.com/wozsun/ImageShow">ImageShow</a>'
```

### 自定义静态资源

`data/asset/`（容器内为 `/app/data/asset/`）存放自己的图标、背景图等图片，随 `data/` 一起挂载和备份，应用启动时会自动创建这个目录。放入的文件通过主站的 `/asset/` 访问：

| 文件位置 | 访问地址 |
| --- | --- |
| `data/asset/logo.png` | `/asset/logo.png` |
| `data/asset/bg/home.webp` | `/asset/bg/home.webp` |

例如把图标放到 `data/asset/logo.png`，再把 `site.icon` 设为 `/asset/logo.png`。

- 支持 SVG、PNG、ICO、WebP、JPEG、GIF、AVIF 图片，可以建子目录；以 `.` 开头的文件和目录不会提供，文件名不要包含 `%`、`#`、`?`。
- 注意区分 `/asset/`（你放入的文件）和 `/assets/`（应用自带的文件，内置图标就在其中）。
- 只能通过主站访问，不随[静态资源地址](#静态资源地址)切换域名。
- 文件按长期不变的资源缓存（1 年）。更换图片时请使用新文件名并更新对应配置；同名覆盖后，浏览器可能继续使用旧文件，使用 CDN 时还需手动刷新该地址的 CDN 缓存。
- 浏览器自动请求的 `/favicon.ico` 会跳转到当前的站点图标。

### 静态资源地址

`site.assets_base_url` 让前端的 JS、CSS 等文件从独立域名加载，留空时使用主站的 `/assets/`。

- 地址直接对应静态文件目录，不会自动加 `/assets`：`https://asset.example.com/static` 对应 `https://asset.example.com/static/文件名`。
- 必须是 HTTPS，域名不能与主站相同，不能带账号密码、查询参数或 `#`。可以与本地存储的图片公开地址共用一个域名。
- 先配置好域名和反向代理（保留 Host 和路径，转发到 ImageShow），再保存设置并刷新页面，不需要重新构建。
- 已经打开的页面仍使用旧地址，切换期间请保持旧地址可用。登录验证所需的脚本始终从主站加载。

## 外部嵌入

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `embed.enabled` | `false` | 开放 `/embed/home`、`/embed/gallery`、`/embed/show`，供其他网站用 iframe 嵌入。对应的首页、画廊、展映也必须开启 |
| `embed.allowed_origins` | `[]` | 允许嵌入本站的其他网站，JSON 数组，最多 32 个 |

开启后，本站自身默认可以嵌入；设置了 `site.domain` 时，该域名及其子域名的 HTTPS 页面也可以。其他网站需要加入 `embed.allowed_origins`，例如：

```json
["https://portal.example.com", "https://*.trusted.example.net"]
```

- 每项是一个 HTTPS 网站地址，可带端口，不能带路径、账号密码，不能是 IP 或 HTTP。每项最多 320 字符，去重后的列表以空格连接时总长最多 4096 字符。
- `*.` 开头表示该域名下的所有子域名，但不包括域名本身。只填写你信任的网站，不要对公共托管平台的整个域名使用通配。
- 这个列表还用于图片防盗链和 `/random` 的频率限制豁免，这两项不受 `embed.enabled` 影响。Referer 可以伪造，所以它只是轻量限制，不是身份验证。

`/random` 和三档公开图片的匿名 CORS 使用 `*`，不由这个列表控制，见[跨站读取](api/random.md#跨站读取)。

嵌入的页面始终以访客身份显示，没有管理功能和原图入口。宿主网站可以通过[宿主光标协议](api/embed-cursor.md)显示自定义光标，通过[嵌入安全区协议](api/embed-safe-area.md)调整嵌入页在手机全面屏上避开的边距。

## 上传与导入

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `ingestion.max_file_size_mb` | `100` | 单张原图的大小上限（MiB），大于 0、最大 200。上传和导入共用 |
| `ingestion.max_long_edge` | `32000` | 原图长边上限（像素），300–32000。超过直接拒绝，不会先缩小 |
| `ingestion.list_page_size` | `20` | 上传、导入和批量编辑列表每页条数，1–100 |
| `ingestion.commit_concurrency` | `8` | 服务器同时入库的图片数，1–16。调高会增加数据库、存储和内存压力 |
| `upload.max_items` | `200` | 每批上传的文件数，1–1000 |
| `upload.browser_concurrency` | `2` | 每个浏览器页面同时上传的文件数，1–8 |
| `upload.raw_concurrency` | `5` | 服务器同时接收的上传数，所有用户共享，1–8 |
| `import.keep_original_link` | `["url", "jsonl", "weibo"]` | 哪些导入方式保留原图链接：`url` 链接导入、`jsonl` 清单导入、`weibo` 微博导入。`[]` 表示都不保留 |
| `import.auto_import` | `true` | 解析没有问题时自动开始导入；设为 `false` 时先显示解析结果，由管理员确认 |
| `import.fetch_timeout_seconds` | `30` | 下载一张图片的超时时间，5–300 秒 |
| `import.max_items` | `200` | 每批链接或清单导入的条数，1–1000 |
| `weibo.max_items` | `10` | 每批微博链接数（按帖子计，不是图片数），1–50 |
| `weibo.source_enabled` | `true` | 把微博帖子页面记为图片来源 |
| `weibo.request_delay_seconds` | `[2, 5]` | 相邻两次微博请求之间随机等待的秒数 `[最短, 最长]`，每项 0–60，最短不能大于最长 |

保留的原图链接只有管理员能看到。原图链接和微博来源是否保留，以任务首次提交时的设置为准；已经提交的任务重试时沿用原来的选择。修改设置不会改动已入库的图片。

## 图片处理

每张图片入库时生成大、中、小三种尺寸的 WebP 文件：小图用于画廊、展映和后台列表，中图用于图片详情和随机图默认尺寸，大图是详情标题打开的完整图片。

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `normalize.concurrency` | `2` | 服务器同时处理的图片数，1–8 |
| `normalize.quality_step` | `5` | 文件超过目标大小时，每次降低的质量值，1–20 |

每种尺寸有四个配置项，路径为 `normalize.<large|medium|small>.<字段>`：

| 字段 | large 默认（范围） | medium 默认（范围） | small 默认（范围） | 含义 |
| --- | --- | --- | --- | --- |
| `quality` | 80（50–100） | 80（50–100） | 80（50–100） | 初始压缩质量 |
| `min_quality` | 60（1–80） | 60（1–80） | 60（1–80） | 最低质量，不能高于初始质量 |
| `max_long_edge` | 4200（512–16000） | 2200（256–8000） | 600（128–2000） | 长边上限（像素） |
| `max_size_kb` | 700（256–5120） | 350（128–2560） | 60（8–1280） | 目标文件大小（KiB） |

处理规则：

- 图片按比例缩小到长边上限以内，不会放大。
- 从初始质量开始压缩，超过目标大小就按 `quality_step` 降低质量；降到最低质量仍超出时也照常入库。
- 长边和目标大小都必须满足 small ≤ medium ≤ large，否则无法保存。
- 原图本身是 WebP、长边不超限且小于 large 的目标大小时，large 直接使用原文件。

## 后台、登录与日志

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `admin.login_background` | `""` | 登录页背景图，留空使用本站随机图；可填以 `/` 开头的站内路径（如[自定义静态资源](#自定义静态资源)）或 HTTPS 地址，最多 2048 字符 |
| `admin.image_page_size` | `60` | 后台图片列表每页数量，10–200 |
| `admin.recent_uploads` | `16` | 后台概览中“最近上传”的数量，1–60 |
| `security.session_ttl_seconds` | `604800` | 登录有效期（默认 7 天），300–31536000。登录或页面重新验证登录状态时续期 |
| `security.login_failure_window_seconds` | `60` | 同一 IP + 用户名的登录次数统计时长，30–300 秒 |
| `security.login_max_failures` | `5` | 上述时长内允许的登录尝试次数，3–500。登录成功后清零 |
| `security.login_global_window_seconds` | `180` | 全站登录次数统计时长，60–600 秒 |
| `security.login_global_max_attempts` | `10` | 上述时长内全站允许的登录尝试总数，5–1000。多人使用时应留足余量 |
| `security.random_window_seconds` | `60` | `/random` 频率限制的统计时长，1–3600 秒 |
| `security.random_max_requests` | `60` | 每个 IP 在统计时长内可从 `/random` 取得的图片张数，1–10000。不带 `limit` 的请求计 1 张；`limit` 不超过“本项 ÷ `random_limit_max_requests`”（向下取整，至少 1）时按 `limit` 计张数 |
| `security.random_limit_max_requests` | `10` | 每个 IP 在统计时长内，`limit` 超过上述分界值的 `/random` 请求次数上限，1–10000。默认分界值为 60 ÷ 10 = 6 |
| `altcha.enabled` | `true` | 登录时进行人机验证（自托管的 ALTCHA）。关闭后账号密码校验和次数限制仍然有效 |
| `altcha.ttl_seconds` | `300` | 一次验证的有效期，90–3600 秒 |
| `altcha.cost` | `5000` | 验证计算量，1000–100000。值越大计算越慢，在手机上尤其明显 |
| `altcha.counter_range` | `[2000, 5000]` | 每次验证工作量的随机范围 `[最小, 最大]`，每项 100–100000，最小不能大于最大，且 `cost × 最大值` 不超过 100000000 |
| `log.level` | `"WARN"` | 日志级别：`DEBUG`、`INFO`、`WARN`、`ERROR`、`OFF`。可在后台「日志」页直接修改 |
| `log.max_size_mb` | `10` | 日志文件达到这个大小（MiB）后换新文件，大于 0、最大 1024 |
| `log.max_files` | `5` | 保留的历史日志文件数，1–100 |

`/random` 的两种请求分别计数，超出后返回 `429` 和 `Retry-After`。来自本站或 `embed.allowed_origins` 中网站的请求（按 Referer 判断）不计数。访客 IP 取自反向代理设置的 `X-Real-IP` 或 `X-Forwarded-For`，配置方法见[安装与维护](DEPLOY.md#配置域名与-https)。

日志会自动隐去密码、密钥、Cookie、令牌等敏感信息，单条附加信息最多 8 KiB。

## 环境变量

Docker Compose 从 `.env` 读取变量，但只有在 `compose.yaml` 的 `environment` 中列出的变量才会传给容器。修改后执行 `docker compose up -d` 重新创建容器。

### 数据库、管理员与时区

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DATABASE_PASSWORD` | 无，必填 | 数据库密码，使用随机强密码 |
| `DATABASE_NAME` | 必填，Compose 默认 `imageshow` | 数据库名 |
| `DATABASE_USER` | 必填，Compose 默认 `imageshow` | 数据库用户名 |
| `DATABASE_HOST` | `postgresql` | 数据库地址，默认连接 Compose 内置的数据库 |
| `DATABASE_PORT` | `5432` | 数据库端口 |
| `REDIS_HOST` | `redis` | Redis 地址，默认连接 Compose 内置的 Redis |
| `REDIS_PORT` | `6379` | Redis 端口 |
| `REDIS_DB` | `0` | ImageShow 专用的 Redis 逻辑库编号（0–15），不要与其他程序共用 |
| `REDIS_PASSWORD` | `""` | Redis 密码，留空表示不认证。内置 Redis 在私有网络中，不需要密码 |
| `ADMIN_USERNAME` | 必填，Compose 默认 `admin` | 第一个超级管理员的用户名，1–32 位，只能用字母、数字和连字符，首尾不能是连字符，会转为小写 |
| `ADMIN_PASSWORD` | 无，必填 | 第一个超级管理员的密码，8–128 位，需同时包含字母和数字 |
| `TZ` | `UTC` | 服务器时区，如 `Asia/Shanghai`；导入图片的时间没有指定时区时，按此时区解释 |

- 数据库名、用户名和密码同时用于应用和内置数据库。连接已有数据库时填写它的实际信息；修改这些变量不会改动已有数据库的账号。
- 管理员账号只在数据库中还没有超级管理员时创建，之后修改变量不会改变已有账号。默认 Compose 仍要求这两个密码非空，请一直保留。
- 默认 `compose.yaml` 向应用传入数据库名、用户名、密码、管理员变量和 `SITE_DOMAIN`。`DATABASE_HOST`、`REDIS_*`、`TZ` 等需要自己加到 `environment` 中。

### 用环境变量设置初始配置

本页的每个配置项都可以用环境变量设置初始值。变量名就是配置路径转为大写、`.` 换成 `_`，例如 `site.home.enabled` 对应 `SITE_HOME_ENABLED`，`normalize.medium.quality` 对应 `NORMALIZE_MEDIUM_QUALITY`。完整列表见仓库中的 [.env.example](../.env.example)。

在这些初始配置变量中，默认 `compose.yaml` 只传入 `SITE_DOMAIN`。使用其他初始配置变量时，先写进 `.env`，再加到 `compose.yaml`：

```yaml
services:
  imageshow:
    environment:
      SITE_ROOT: ${SITE_ROOT:?set SITE_ROOT}
      EMBED_ALLOWED_ORIGINS: ${EMBED_ALLOWED_ORIGINS:?set EMBED_ALLOWED_ORIGINS}
```

写法要求：布尔值只能是 `true` 或 `false`；数字前后不能有空格；数组使用 JSON 格式。例如：

```ini
SITE_ROOT=gallery
SITE_DESCRIPTION=""
WEIBO_REQUEST_DELAY_SECONDS='[0,0]'
EMBED_ALLOWED_ORIGINS='["https://portal.example.com","https://*.trusted.example.net"]'
```

再次提醒：这些变量只在配置文件不存在时使用。已经安装过的站点请在后台或配置文件中修改。
