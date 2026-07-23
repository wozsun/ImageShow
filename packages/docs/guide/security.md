# 安全

- 管理员密码使用 Node.js `node:crypto` 原生异步 Argon2id 派生，以 PHC 字符串写入 PostgreSQL；固定参数为 64 MiB 内存、3 轮、并行度 4、32 字节输出和 16 字节随机 salt。登录只接受完整匹配该策略的 PHC 参数，并使用恒定时间比较派生结果。
- 管理会话存于 Redis，Cookie 为 `HttpOnly` + `SameSite=Lax`，识别为 HTTPS 时附加 `Secure`；所有写操作要求 `X-CSRF-Token` 并校验同源。管理员密码被后台重置或账号被删除时，服务端用 `SCAN + MGET` 定向清除该账号的全部会话；自行改密会保留当前会话并清除同账号的其他会话。紧急密码恢复以 PostgreSQL 密码更新为主流程，并在 Redis 可用时使用 `SCAN` 清除全部管理员会话；Redis 故障不会阻止密码更新，但会警告旧会话尚未清除。
- Compose 内置 Redis 只连接项目私有网络、不发布宿主机端口且不设置密码。连接启用了认证的外部 Redis 时，可通过 `REDIS_PASSWORD` 向应用提供密码。
- 管理端界面偏好接口只使用鉴权会话中的用户名定位 `admin_account.preferences`，不接受客户端传入目标账号。接口只接受 shared 注册的键与值域，PATCH 在 PostgreSQL 行内原子合并并返回完整投影；JSONB 顶层必须是对象且最大 4 KiB。浏览器缓存键按用户名隔离，`localStorage` 仅承担首帧显示、断网 pending 和多标签同步，不参与鉴权，也不保存会话或 CSRF token。PostgreSQL 尚无某键时，已校验的本地值可补写一次；删除账号时偏好随该行自然删除。
- 登录失败限流：每 IP + 用户名 60 秒内 5 次失败即拦截，叠加 180 秒内 10 次尝试的全局兜底（阈值与窗口均可在 `config.json` 的 `security.*` 调整）。
- 登录前置安全验证使用完全自托管的 ALTCHA：服务端签发带 HMAC 的
  PBKDF2/SHA-256 确定性工作量挑战，登录页显示紧凑验证条并在组件加载后自动由
  浏览器求解；自动验证失败时可点击验证条手动重试。挑战签名主密钥在首次签发时
  随机生成并仅驻留当前进程内存；签名验证通过后，
  Redis 使用带 TTL 的原子 `SET NX` 消费挑战 nonce，保证同一证明在并发请求中也
  只能使用一次。挑战签发复用 `security.*` 的两组时间窗口：单来源阈值为
  `login_max_failures × 3`，全局阈值为 `login_global_max_attempts × 5`；全局计数键
  不包含来源 IP。登录密码校验继续使用原阈值。可在 `config.json` 的
  `altcha.enabled` 关闭；
  浏览器单次求解最多等待 60 秒，服务端同时限制
  `cost × counter_max <= 100000000`，挑战有效期最短 90 秒，避免可通过配置校验的
  工作量在客户端必然超时或完成后立即过期；
  登录页通过 `/api/admin/auth/me` 的 `altcha_enabled` 决定是否加载组件，最终是否
  校验仍只由服务端配置决定。应用重启会使此前已签发但尚未提交的证明失效，用户
  重新验证即可；现有登录会话不受影响。
- 公开页默认不显示后台入口，也不主动请求 `/api/admin/auth/me`；只有当前浏览器本地存在 `site_session_hint` 提示位时，顶栏才懒探测 `/api/admin/auth/me`，并仅在服务端确认已登录后显示入口。图片详情同样只在存在该提示位时请求 `/api/admin/images/:id/admin-info` 补充登录态管理信息，接口返回 401 会清除提示位并保持普通访客展示。该提示位只存在 `localStorage`，不参与鉴权，伪造它最多导致一次登录态探测或一次受保护接口的 401。
- 全站响应头包含 `X-Content-Type-Options`、`X-Frame-Options`、`Referrer-Policy`、`Cross-Origin-Opener-Policy` 与 CSP；SPA 以 report-only 模式监测脚本 Trusted Types，白名单只列出实际出现的 `imageshow-altcha-worker`、`svelte-trusted-html`、`decodeHTMLEntitiesPolicy` 与 `AGPolicy`，不放行任意策略名，也不提供放行任意脚本 URL 或 HTML 的默认策略；同源 `/api/security/csp-report` 默认只返回 204，不读取或记录报告正文。登录页在 ALTCHA 首次挂载前预设隐藏 footer 与 logo，使组件不渲染会被 Trusted Types 拒绝的动态 HTML footer；应用只接受 `site.domain` 及其一级保留/主题子域名，未知 `Host` 直接返回不可缓存的 404。
- 普通 API 请求体在解析前限制为 128 KiB；管理员偏好 PATCH 在鉴权与 CSRF 通过后使用独立的 5 KiB 传输上限，解析并规范化后的完整 JSONB 另受 4 KiB 上限约束。微博解析、JSONL 清单、批量导入会话创建和批量图片编辑分别使用独立的 1 MiB、128 MiB、256 MiB、6 MiB 上限。URL / JSONL / 微博批量入口仍受 3600 项硬上限、URL 与 JSONL 最高 1000 项及微博最高 50 条的可配置软上限，以及逐字段 schema 限制；微博链接单项最多 2048 字符，50 个最大长度字符串按最坏六字节 JSON 转义约为 0.586 MiB，因此 1 MiB 可覆盖全部合法请求并保留余量。微博解析图片不受链接软上限影响，但有固定 1000 张安全上限；逐条帖子失败不会回显响应正文或访客 Cookie。微博请求、正文读取和 JSON/JSONP 解析共用 15 秒期限，访客与帖子响应分别限制为 64 KiB 和 4 MiB，连接中断、取消及超限正文不会变成未分类 500；所有批次还共用可配置为 1–32 的进程级上游请求并发限制，排队项可取消。标题和描述在 `trim()` 后分别最多 80 和 500 个 UTF-16 code unit，普通汉字各占一个。按每个字符都产生六字节 JSON 转义的最坏合法表示计算，3600 项 batch-create 约 147.450 MiB、JSONL 外层请求约 120.537 MiB，200 项 batch-update 约 5.691 MiB；分别选择 256、128、6 MiB 梯度并保留余量。本地文件选择使用 1–1000 的前端软上限；服务端继续按配置体积逐文件流式限流，避免匿名超大请求占用服务端内存。应用层限制检查收到的请求字节，不主动解码压缩请求体；代理必须使用一致或更严格且不低于实际业务请求的限制。站点域名只接受 DNS 名称（开发环境可带端口），外部图片、来源、作者、站点资源和远端存储地址只接受 HTTPS。
- 大请求路由的中间件顺序是：Host / 安全响应头 → 普通全局 limiter 路径豁免 → 管理员会话认证 → 审计入口 → CSRF → 路由专用字节 limiter → JSON 解析 → schema / 业务处理。匿名请求因此在读取大请求体前返回 401；已登录但缺少或错误 CSRF 的请求在专用 limiter 前返回 403。limiter 同时记录实际检查或可信 `Content-Length` 声明的字节数供摘要日志使用，不保存或输出正文。
- 外部图片抓取统一走安全 fetch：只允许 `https` 且必须使用域名，不接受直接 IP；请求前和每次重定向后都校验主机，实际连接使用受控 DNS lookup 并再次校验连接地址，阻断 DNS rebinding、localhost、内网、链路本地、组播和云 metadata 地址；运行时必须启用 TLS 证书校验，证书无效时拒绝下载/代理；下载/代理会通过响应内容确认是支持的图片格式，非图片不会入库或转发。安全拒绝对外统一返回通用提示，内部 debug 日志保留拒绝原因。
- 公共画廊数据接口 `/api/images`、`/api/images/:id` 与 `/api/gallery-facets` 的**跨源保护**：借 Fetch Metadata（`Sec-Fetch-Site`）拒绝**跨站 / 同站跨源**读取，只放行同源（前端自身，含主题子域走相对 URL）、直接导航（`none`）与**不发该头**的老浏览器 / 非浏览器客户端（优雅降级，不误伤画廊）。它是跨源护栏、不是反爬墙——省略该头的客户端仍可访问，合规爬虫由 robots.txt 兜。（`/api/site-config` 不设限——它是内联进 SPA 的启动配置，需在任意首屏场景下可加载；返回内容限于公共渲染和公开交互行为，不包含安全验证开关、登录页背景、上传限制、处理并发等后台参数。）
- **robots.txt（按主机区分，默认关闭）**：由 `config.json` 的 `site.robots_enabled` 控制，**默认 `false`**——此时 `/robots.txt` 对所有主机返回 404、不提供任何抓取规则。开启后按主机区分：主站**仅放行首页**（站点描述），画廊 / 接口 / 静态资源 / 后台一律不许抓取；`static.` / `link.` / `random.` 以及各主题子域（`<主题>.<域名>`）整站禁抓；`docs.` 文档站可正常抓取。
