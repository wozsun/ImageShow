# 配置说明

配置按持久化位置分为三类：

1. **数据库**：管理员账号；S3 的 endpoint/region/bucket/access key/secret key/根目录/public URL 等存储配置。secret key 由数据库持久化，不会返回给前端（管理页只显示「已配置」），请限制数据库与配置目录访问。
2. **配置文件** `/app/data/config.json`：站点名 / 域名 / icon / 根路径跳转 / 登录页与首页背景、监听端口、PostgreSQL 与 Redis 连接、上传与画廊参数、随机图默认模式等非敏感项。**完整字段示例**（含中英文注释、每项默认值）见仓库根的 `config.example.jsonc` —— 实际 `config.json` 为纯 JSON、不支持注释。
3. **环境变量**：仅在配置文件**首次生成**时读取；此后修改配置请使用后台设置页，或编辑配置文件后在设置页点击「读取配置文件」热加载（数据库 / Redis / 端口等连接类配置仍需重启容器）。部分进阶项只在配置文件中调整：概览「最近上传」数量；`operation_log.*_concurrency` 系列并发——`delete.finalize` / `move.cleanup` / `empty-trash` 三类清理任务的并发，加上删除主题时把图片文件搬到 `none/` 文件夹的 `theme_reassign_concurrency`，默认各 5；`link_image.fill_original_url`（外链导入时是否把链接自动填入「原图URL」，**默认 `false` 关闭**，后台上传器读取该项决定是否预填）；`site.home_enabled`（是否启用公共首页 `/home`，**默认 `true` 开启**；关闭后 `/home` 会重定向到画廊、导航不再显示「首页」入口、根路径跳转也强制改为画廊——即便 `root_redirect` 仍为 `home`）；以及 `site.docs_enabled`（是否启用文档站子域 `docs.<域名>`，**默认 `true` 开启**；关闭后该子域一律返回 404，但 `docs` 前缀仍被保留、主题不可占用）。另有两组**仅配置文件**的进阶项：`security.*`——会话有效期 `session_ttl_seconds`（默认 `604800` 秒 = 7 天）与登录限流阈值 `login_max_failures`（默认 5）/ `login_failure_window_seconds`（默认 60）/ `login_global_max_attempts`（默认 10）/ `login_global_window_seconds`（默认 180）；`thumbnail.*`——缩略图长边 `long_edge`（默认 512）与 webp 质量 `quality`（默认 75，仅影响此后新生成的缩略图）；`captcha.*`——登录验证码的 `code_length`（位数，默认 6）、`ttl_seconds`（有效期秒数，默认 60）、`noise_lines`（干扰线条数，默认 8）与 `noise_dots`（噪点数，默认 50）；其余视觉几何（间距/字号/旋转幅度等）与**字符集**（大小写字母+数字，校验不区分大小写）才是代码前部常量（`core/captcha.ts` 的 `captchaDifficulty` 与 `codeAlphabet`）；`log.*`——日志级别 `level`（`DEBUG` / `INFO` / `WARN` / `ERROR` / `OFF`，默认 `WARN`）与按大小轮转的 `max_size_mb`（默认 10）/ `max_files`（默认 5，保留的归档数 `app.log.1 … app.log.N`），日志写入 `data/log/app.log` 并同时输出到容器 stdout/stderr。以上各项改后经设置页「读取配置文件」热加载即生效。

## 环境变量

`compose.yaml` 只向容器注入少数几个变量（见仓库根 `.env.example`）：管理员初始账号 `ADMIN_USERNAME` / `ADMIN_PASSWORD`、PostgreSQL 的 `POSTGRES_DB` / `POSTGRES_USER` / `POSTGRES_PASSWORD`、站点主域名 `APP_DOMAIN`（默认 `example.com`），以及两个可选的宿主端口映射 `HOST_PORT`（默认 `5518`）/ `POSTGRES_HOST_PORT`（默认 `5432`）。它们只在 `config.json` **首次生成**时把对应字段播种进去。

其余配置项 `compose.yaml` 不再注入，请直接在 `config.json` 中设置——**完整字段清单（含每项默认值与中英文双语注释）见仓库根的 `config.example.jsonc`**。改完文件在后台「设置 → 读取配置文件」热加载即可生效（连接类的 `database` / `redis` / `port` 仍需重启容器）。
