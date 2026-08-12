# 安全

- 管理员密码使用 Node.js `node:crypto` 原生异步 Argon2id 派生，以 PHC 字符串写入 PostgreSQL；固定参数为 64 MiB 内存、3 轮、并行度 4、32 字节输出和 24 字节随机 salt，并使用恒定时间比较派生结果。登录只接受参数与长度完全匹配当前策略的哈希，不在登录路径自动改写密码记录。
- 管理会话存于 Redis，Cookie 为 `HttpOnly` + `SameSite=Lax`，识别为 HTTPS 时附加
  `Secure`；所有写操作要求 `X-CSRF-Token` 并校验同源。会话保存密码哈希的不可逆
  SHA-256 代际，key namespace 固定为 `imageshow:session:v2:`；其他 namespace 不参与认证。
  每个 payload 必须包含一至两个格式正确且互不重复的代际，缺失、空数组、非法项、重复项
  或超长数组均直接拒绝。Redis 不保存管理员账号、角色或密码代际的全局投影。每次会话认证先
  读取 Redis key，再以其中用户名对 PostgreSQL `admin_account` 做一次主键查询，比较权威
  角色、密码哈希格式和代际。PostgreSQL 查询异常统一返回
  `503 database_unavailable` 且不删除 Redis key；只有数据库明确确认账号不存在、角色或
  代际不匹配，以及 Redis 明确确认会话不存在时才返回 401。
- 自行改密在锁定账号行并验证当前密码后，重新读取当前 Redis 会话的严格 payload；只有
  身份字段一致且仍包含行锁内旧代际时，才以原始 payload 为快照原子替换为旧、新两个
  代际，再更新 PostgreSQL。会话已被重置、删除或并发改变，以及 Redis 预授权失败时，
  事务回滚且不写新密码。数据库提交完成后
  当前会话保留；其他会话只在 payload 仍包含本次事务行锁内的旧代际且不包含新代际时，
  才通过 `SCAN + MGET` 选取，并仅在 payload 仍与读取快照相同时原子删除。这样更早一轮
  延迟清理不会删除已经跨过该旧代际的新会话。清理时的 Redis 故障不改变已经
  提交的成功结果，残留会话会在下一次 PostgreSQL 代际核对时失效。后台重置和删除账号也
  携带各自行锁内的旧代际，先提交 PostgreSQL，再尽力清理持有该旧代际的目标会话；延迟
  清理不会命中之后的新代际或同名重建账号。紧急密码恢复直接更新 PostgreSQL 真值，随后在
  Redis 可用时清除全部管理员会话；Redis 故障不阻止恢复写入，目标账号旧会话仍会在下次
  认证时失效。
- 管理员授权在角色之上使用集中定义的操作权限。`/api/admin/auth/me` 返回当前会话的
  权限标识，前端据此隐藏不可用入口，但权限列表只用于界面呈现，服务端路由中间件
  才是最终授权边界。图片管理员仍可上传、编辑元数据、移入回收站和恢复图片；
  一至多张迁移存储需要 `image.storage.migrate`；明确选择或清空当前回收站范围的所有
  永久删除统一需要 `image.trash.purge`。图片管理员可以执行
  主题、标签和作者的查看、新建、编辑及排序；相应管理页不提供批量删除，单项删除
  分别需要 `theme.delete`、`tag.delete` 和 `author.delete`。图片管理员还可以执行
  数据库、存储、Redis、回收站和全部五项只读检查；存储后端迁移需要
  `storage.maintenance.migrate`，显式存储维护需要 `storage.maintenance.execute`，
  手动重建统一图片缓存需要 `cache.maintenance.rebuild`。
  以上八项高风险操作权限当前只授予超级管理员；直接构造对应单项请求同样返回 403，
  且在解析正文或进入存储维护操作前终止。
- Compose 内置 Redis 使用不固定次版本的 `redis:8` 镜像，只连接项目私有网络、不发布宿主机端口且不设置密码，并启用 AOF。ImageShow 不设置 Redis 内存上限、淘汰策略或容器硬限制，只把 `INFO MEMORY` 作为运维观测；启动与 `/readyz` 检查连接，并在自有 5 秒 TTL 探针键上实际执行 `INCREX`、`ARRING`、`ARLASTITEMS` 三项必需命令，命令存在但 ACL 拒绝执行仍视为不可用。首次校验成功前后台与公开业务都由冷启动门拒绝；运行期 Redis 故障时后台在会话读取前统一返回 `503 redis_unavailable`，不能伪装成 401 或触发浏览器清除登录状态，公开只读业务才允许有界 PostgreSQL 回源。连接启用了认证的外部 Redis 时，可通过 `REDIS_PASSWORD` 向应用提供密码。
- 管理端界面偏好接口只使用鉴权会话中的用户名定位 `admin_account.preferences`，不接受客户端传入目标账号。接口只接受 shared 注册的键与值域，PATCH 在 PostgreSQL 行内原子合并并返回完整投影；JSONB 顶层必须是对象且最大 4 KiB。浏览器缓存键按用户名隔离，`localStorage` 仅承担首帧显示、断网 pending 和多标签同步，不参与鉴权，也不保存会话或 CSRF token。PostgreSQL 尚无某键时，已校验的本地值可补写一次；删除账号时偏好随该行自然删除。
- 登录失败限流：每 IP + 用户名 60 秒内 5 次失败即拦截，叠加 180 秒内 10 次尝试的全局兜底（阈值与窗口均可在 `config.json` 的 `security.*` 调整）。两个固定窗口在一次 Redis 服务端原子操作中按来源到全局的顺序使用 `INCREX ... UBOUND ... EX ... ENX` 预留；前一窗口已拒绝时不再消耗后续共享额度。达到上限后计数不再增长，后续请求也不会延长首次建立的 TTL。
- 登录前置安全验证使用完全自托管的 ALTCHA：服务端签发带 HMAC 的
  PBKDF2/SHA-256 确定性工作量挑战，登录页显示紧凑验证条并在组件加载后自动由
  浏览器求解；自动验证失败时可点击验证条手动重试。挑战签名主密钥在首次签发时
  随机生成并仅驻留当前进程内存；签名验证通过后，
  Redis 使用带 TTL 的原子 `SET NX` 消费挑战 nonce，保证同一证明在并发请求中也
  只能使用一次。挑战签发复用 `security.*` 的两组时间窗口：单来源阈值为
  `login_max_failures × 3`，全局阈值为 `login_global_max_attempts × 5`；全局计数键
  不包含来源 IP。挑战限流同样使用 `INCREX`；来源已超限时不会再消耗全局窗口。
  登录密码校验继续使用原阈值。可在 `config.json` 的
  `altcha.enabled` 关闭；
  浏览器单次求解最多等待 60 秒，服务端同时限制
  `cost × counter_max <= 100000000`，挑战有效期最短 90 秒，避免可通过配置校验的
  工作量在客户端必然超时或完成后立即过期；
  登录页通过 `/api/admin/auth/me` 的 `altcha_enabled` 决定是否加载组件，最终是否
  校验仍只由服务端配置决定。应用重启会使此前已签发但尚未提交的证明失效，用户
  重新验证即可；现有登录会话不受影响。
- 公开页默认不显示后台入口，也不主动请求 `/api/admin/auth/me`；只有当前浏览器本地存在 `site_session_hint` 提示位时，顶栏与图片详情才共用该登录态探针，并仅在服务端确认已登录后显示管理信息和编辑入口。未登录探针只返回登录页所需的 ALTCHA 开关与背景，完全省略用户名、角色、权限、CSRF、应用版本、偏好和后台版本显示策略；确认已登录后才附带这些后台投影并建立内存中的 CSRF token。管理信息、词表、可编辑快照和保存仍分别由服务端鉴权与 CSRF 保护。任一受保护请求返回 401 都会清除 token 与提示位并恢复普通访客展示，403 会隐藏当前详情的管理入口。该提示位只存在 `localStorage`，不参与鉴权；伪造它最多触发 `/auth/me`，不会预载编辑器或取得管理数据。
- 普通响应在最终响应对象上统一补齐 `X-Content-Type-Options`、`X-Frame-Options: DENY`、`Referrer-Policy`、`Cross-Origin-Opener-Policy` 与 CSP `frame-ancestors 'none'`，直接返回的 API、静态、错误和未知 Host 响应也不会漏掉。只有服务端确认 `embed.enabled=true` 后，精确的 `/embed/home` 与 `/embed/gallery` 文档才移除 `X-Frame-Options`，并将当前 `site.domain` 的 HTTPS origin、同端口子域 host-source 以及规范化且使用 DNS 主机名的额外精确 HTTPS origin 或 `https://*.example.com` 形式的子域 host-source 写入 CSP `frame-ancestors`；隐式来源随站点配置变化，不写回或经 DTO 暴露。通配符不包含根域名，IP literal、裸 `*` 与中间通配符不进入额外白名单，也不使用已废弃且不能表达多来源的 `ALLOW-FROM`。通配符会同时授权该后缀下全部现有和未来子域，因此 `site.domain` 及额外通配符都必须处于可信 DNS 管理边界，不得把公共托管后缀作为安全边界。CSP 原生支持这类 host-source，因此响应不根据可能缺失的 `Origin` 或可被父页面关闭的 `Referer` 猜测并反射来源。禁用、未知 Host、保留子域或其他路径继续不可嵌入。SPA 以 report-only 模式同时观测完整资源策略与脚本 Trusted Types；白名单只列出实际出现的 `imageshow-altcha-worker`、`svelte-trusted-html`、`decodeHTMLEntitiesPolicy` 与 `AGPolicy`，不放行任意策略名，也不提供放行任意脚本 URL 或 HTML 的默认策略。候选策略明确覆盖 script、Worker、connect、HTTPS 图片、样式、字体、object、base 与 form；经浏览器报告验证前不直接收紧为强制策略。同源 `/api/security/csp-report` 只接受 POST，经 Fetch Metadata 拒绝跨站 / 同站跨源，声明体积上限为 64 KiB，并立即取消正文流；它不解析 JSON、不写日志、数据库或 Redis。登录页在 ALTCHA 首次挂载前预设隐藏 footer 与 logo，使组件不渲染会被 Trusted Types 拒绝的动态 HTML footer；应用只接受 `site.domain` 及配置的 `random` / `static` / `link` 子域名，未知 `Host` 直接返回不可缓存的 404。
- 反向代理或 CDN 不得对 `/embed/*` 重新注入 `X-Frame-Options`，也不得覆盖应用生成的 CSP `frame-ancestors`，否则会把已授权的 iframe 一并拦截；普通路径的拒绝策略仍由应用统一生成。若代理层必须统一添加这些头，应为两个精确嵌入路径设置例外，并保留应用响应头。

## 响应头矩阵

所有动态响应头值在写入前拒绝 CR/LF、C0/C1 控制符、零宽字符与双向控制符，随后再
经过 Fetch `Headers` 语法校验。存储或外部图片上游给出的异常 ETag、Last-Modified、
Content-Type 与缓存验证器会被省略或回退为站内类型；`Content-Range` 还会解析数值关系
并重建为规范形式，`Last-Modified` 解析后统一输出 HTTP-date，`Content-Length` 只接受
非负安全整数；无法验证的范围会先销毁已打开的读取流再返回存储错误。当前出口按下表
集中验收：

| 响应类型 | 缓存 / 验证器 | 额外边界 |
| --- | --- | --- |
| 普通 SPA HTML | `max-age=0`、内容 ETag、支持 304 | 强制禁止嵌入；完整 CSP 候选与 Trusted Types 先 report-only |
| `/embed/home`、`/embed/gallery` | `no-store`，仍带内容 ETag | 仅移除 `X-Frame-Options`，CSP 精确生成 `frame-ancestors` |
| 确定性公共 JSON API | `max-age=0`、最长 30 秒共享缓存窗口、内容弱 ETag 与 304；按入口决定 `Sec-Fetch-Site`，统一 `Vary: Accept-Encoding` | 不返回后台字段；受保护读取拒绝跨站 / 同站跨源；`shuffle` 保持 `no-store` |
| 确定性管理只读 JSON | `private, no-cache`、完整 envelope 内容弱 ETag 与 304 | 仅浏览器私有保存且每次重验证；身份鉴权先于内容生成，禁止 CDN 共享 |
| 登录、其他管理 API、错误、404、健康检查 | `no-store` 或 `private, no-store` | `auth/me`、ALTCHA、检查状态、日志、SSE、后台字节、预览、敏感配置与写接口不缓存；登录限流的 429 使用纯数字 `Retry-After` |
| CSP report、OPTIONS、204 | `no-store` | 只允许各自方法，先做 Host / Fetch Metadata 检查，取消不需要的正文；不启用 CORS |
| hash 资产、稳定图片、HEAD、206、304 | hash 资产 / 稳定图片 `immutable`；非 hash 品牌资源短缓存；ETag、Last-Modified、单 Range | 304 无正文；206 保留完整对象验证器；416 返回 `Content-Range: bytes */总长` |
| 随机 proxy / redirect / JSON | 永远 `no-store` | proxy 不声明 Range；302 的 `Location` 先校验；前两种模式带 `X-Image-Info`，JSON 只返回公开字段与实际 `count`，HEAD 不发送正文 |
| 外链原图 proxy / redirect | 公开 proxy 继承已校验源站策略或使用 fallback，URL 命名空间弱 ETag、Last-Modified 与 304；后台 `private, no-store` | HTTPS 安全抓取、GET 内容嗅探、HEAD 不保留正文、旧 URL 验证器不能命中新 URL、`Referrer-Policy: no-referrer` |
| 导入 SSE | `no-store, no-transform` | 不压缩、不缓冲，断开即清理 listener / heartbeat |
| `static.` / `link.` / `random.` 与未知子域 | 只开放各自精确出口；失败 `no-store` | 保留子域的其他路径与未知 Host 均返回带完整安全头的 404 |

稳定图片地址本身不是管理员授权边界。图片进入回收站后会退出所有公开发现入口，但已知的
`/media/*`、`/thumbs/*` 或 S3 `public_base_url` 直链仍可访问；后台列表和动作权限继续由
管理 API 独立强制。永久删除会同时清理源对象。

当前不发送 COEP 或 CORP：页面允许 HTTPS 外链图片，静态 / 随机 / 原图出口也需要被
其他站点正常引用；贸然隔离会要求所有上游同步提供 CORS/CORP，并可能破坏 ALTCHA
Worker 与嵌入页。应用没有跨源 API 契约，不返回 `Access-Control-Allow-*`；跨源父页面
只加载 iframe，iframe 内部继续同源请求本站 API。HSTS 也不由应用发送，只能由确认
掌握 TLS 与全部相关子域的最外层代理部署。
- Web 直接依赖 `react-router@8.3.0`，只使用 `<BrowserRouter>` / `<Routes>`、
  链接与位置等 Declarative Mode API，不使用 Framework / Data action、服务端
  渲染、React Server Components 或任何 unstable RSC API。当前版本已包含
  `GHSA-qwww-vcr4-c8h2` 的官方修复；将来若引入 RSC，仍须重新审查 CSRF 边界。
- 普通 API 请求体在解析前限制为 128 KiB；管理员偏好 PATCH 在鉴权与 CSRF
  通过后使用独立的 5 KiB 传输上限，解析并规范化后的完整 JSONB 另受 4 KiB
  上限约束。`/api/admin/auth/me` 只向已认证会话附带按 shared schema 规范化的
  管理员偏好，用于在后台首次绘制前确定外观；浏览器本地偏好只是首帧、离线待同步和
  多标签页缓存，不参与鉴权，也不能覆盖 PostgreSQL 权威值。完整配置、微博解析、
  JSONL 清单和批量图片编辑分别使用独立的
  1088 KiB、1 MiB、128 MiB、6 MiB 传输上限。导入会话随前端 lane 推进逐项
  创建，每个创建请求仍走普通 API 上限，不存在可一次提交全部任务的批量会话入口。
  消费 JSON 的写路由统一要求 `application/json` 或带 `+json` 后缀的媒体类型；缺失、
  空白、截断、中止或语法错误正文稳定返回 `400 invalid_json`。正文对象使用 strict
  schema 拒绝未知或已删除字段，全可选更新至少包含一个有效字段；这类在写模型接纳前
  被拒绝的请求不进入领域写入、缓存 / registry 失效或管理员操作审计。
  URL 输入窗口与 JSONL 解析最多允许 1000 项，微博输入最多 50 条；JSONL / 微博
  schema 另有
  3600 项通用硬边界，微博解析结果还有固定 1000 张图片安全上限。微博链接单项
  最多 2048 字符，50 个最大长度字符串按最坏六字节 JSON 转义约为
  0.586 MiB，因此 1 MiB 可覆盖全部合法请求并保留余量。逐条微博失败不会回显
  响应正文或访客 Cookie；微博请求、正文读取和 JSON/JSONP 解析共用 15 秒期限，
  访客与帖子响应分别限制为 64 KiB 和 4 MiB，连接中断、取消及超限正文不会变成
  未分类 500。所有微博批次还共用可配置为 1–32 的进程级上游请求并发限制，
  排队项可取消。标题和描述在 `trim()` 后分别最多 80 和 500 个 UTF-16 code
  unit，普通汉字各占一个。按每个字符都产生六字节 JSON 转义的最坏合法表示计算，
  3600 项 JSONL 外层请求约 120.537 MiB，200 项图片更新约 5.691 MiB；
  128、6 MiB 两档均覆盖合法表示并保留余量。本地文件选择使用 1–1000 的前端
  软上限；服务端继续按配置体积逐文件流式限流，避免匿名超大请求占用服务端内存。
  应用层限制检查收到的请求字节，不主动解码压缩请求体；代理必须使用一致或更严格
  且不低于实际业务请求的限制。站点域名只接受 DNS 名称（开发环境可带端口），
  外部图片、来源、作者、站点资源和远端存储地址只接受 HTTPS。
- 大请求路由的中间件顺序是：Host / 安全响应头 → 普通全局 limiter 路径豁免 → 管理员会话认证 → 审计入口 → CSRF → 路由专用字节 limiter → JSON 解析 → schema / 业务处理。匿名请求因此在读取大请求体前返回 401；已登录但缺少或错误 CSRF 的请求在专用 limiter 前返回 403。limiter 同时记录实际检查或可信 `Content-Length` 声明的字节数供摘要日志使用，不保存或输出正文。
- 外部图片抓取统一走安全 fetch：只允许 `https` 且必须使用域名，不接受直接 IP；
  请求前和每次重定向后都校验主机，实际连接使用受控 DNS lookup 并再次校验连接
  地址，阻断 DNS rebinding。连接地址按 IANA 当前
  [IPv4](https://www.iana.org/assignments/iana-ipv4-special-registry/iana-ipv4-special-registry.xhtml) /
  [IPv6](https://www.iana.org/assignments/iana-ipv6-special-registry/iana-ipv6-special-registry.xhtml)
  special-purpose registry 的 `Globally Reachable` 语义和
  [IPv6 当前地址空间](https://www.iana.org/assignments/ipv6-address-space/ipv6-address-space.xhtml)
  集中分类，更具体
  前缀优先；非 `True`、已终止、组播、位于当前全局单播范围外或无法可靠判断的地址
  均拒绝。只有
  IPv4-mapped 与 `64:ff9b::/96` 两种固定形式会提取嵌入 IPv4 并复用同一分类，
  因此代理 / Fake-IP DNS 不能借 benchmarking、私网、loopback、link-local、ULA、
  metadata、文档、translation 或 tunnel 地址绕过边界。运行时必须启用 TLS 证书
  校验，证书无效时拒绝下载 / 代理；下载 / 代理会通过响应内容确认是支持的图片格式，
  非图片不会入库或转发。安全拒绝对外统一返回通用提示，内部 debug 日志只保留拒绝
  原因、协议与规范化主机名，不记录路径、查询参数或凭据。
- 外链导入下载会为每个已通过安全校验的当前目标生成仅含 `https` origin 的
  `Referer`，用于微博图床等基础防盗链。重定向后按新目标重新生成，不透传图片
  路径、查询参数、来源页面或管理员输入的任意 Referer。
- 公共画廊数据接口 `/api/images`、`/api/images/:id`、`/api/gallery-facets` 与 `/api/gallery-stats` 的**跨源保护**：借 Fetch Metadata（`Sec-Fetch-Site`）拒绝**跨站 / 同站跨源**读取，只放行同源（前端自身）、直接导航（`none`）与**不发该头**的老浏览器 / 非浏览器客户端（优雅降级，不误伤画廊）。嵌入页中的数据请求仍由 iframe 内的同源应用发出，不增加 CORS、跨源凭据或后台写权限。它是跨源护栏、不是反爬墙——省略该头的客户端仍可访问，合规爬虫由 robots.txt 兜。（`/api/site-config` 不设限——它是内联进 SPA 的启动配置，需在任意首屏场景下可加载；返回内容只包含公开页面实际消费的站点名称、图标、根路径、首页、画廊排序、有效嵌入开关和详情行为，不包含嵌入来源列表、域名、后台版本显示策略、服务端分页默认值、随机出口默认方式、安全验证开关、登录页背景、上传限制或处理并发。）
- **robots.txt（按主机区分，默认关闭）**：由 `config.json` 的 `site.robots_enabled` 控制，**默认 `false`**——此时 `/robots.txt` 对所有主机返回 404、不提供任何抓取规则。开启后按主机区分：主站**仅放行首页**（站点描述），画廊 / 接口 / 静态资源 / 后台一律不许抓取；`static.` / `link.` / `random.` 资源域整站禁抓。最终文本带内容弱 ETag，`If-None-Match` 命中返回无正文 304；主机或首页启用配置改变正文时 ETag 同步变化。
