# 安全与主机边界

修改鉴权、会话、权限、Host / 资源入口、CORS、响应头、请求体限制、外部抓取或日志时读取。

## 代理与 Host

- 只信任最外层代理覆盖后的单跳值：原始 `Host`、精确的 `http` / `https` 协议值、单个合法 IP 的 `X-Real-IP` 或 `X-Forwarded-For`；不解析 `X-Forwarded-Host`，逗号链与非法 IP 归为 `unknown`。前提是应用端口只对可信代理可达，代理覆盖而不是追加访客头。
- 主站 Host 提供 SPA、API、健康检查、唯一随机入口 `/random` 与图片入口 `/images`。显式设置 `site.domain` 时，页面与 API 只接受该 Host；配置的本地图片公开 Host 与静态资源 Host 只开放各自资源，不提供 SPA、API、外部原图或临时文件；其余 Host 返回不可缓存的 404。
- 域名为空或为 `example.com` 时接受格式合法的访问 Host，图片地址使用同源路径；绝不把请求 Host 写入配置、共享缓存或队列。这只是基础回退，不替代鉴权、CSRF 或代理配置。
- 本地图片公开 Host 只读取本地正式对象：不查询图片当前位置、不转读其他后端、不回跳公开 URL；Host 准入同步读取注册表最后发布的配置，不触发数据库查询。修改公开地址不搬文件、不重建 driver，清空后回退主站，不保留旧 Host 别名。主站 `/images` 则按图片当前位置读取，后端配置公开 URL 时 302。
- 静态资源 Host 只开放构建资源，复用主站静态响应；登录验证 Worker 始终从主站同源加载。

## 会话与鉴权

- 会话保存在 Redis（key namespace 固定 `imageshow:session:`），payload 只含身份和 1–2 个密码哈希的 SHA-256 代际，严格校验。每次认证先读 Redis，再按用户名主键查询 PG 比对角色、哈希格式与代际；Redis 不保存账号、角色或代际的全局投影。
- 失败语义：PG 查询异常返回 `503 database_unavailable` 且不删除会话；只有 PG 明确确认账号不存在、角色或代际不匹配，或 Redis 明确确认会话不存在时才返回 401。运行期 Redis 故障时后台在读取会话前统一返回 503，不能伪装成 401 而让浏览器清除登录状态。
- 续期：只有 `/api/admin/auth/me` 完成权威校验并取得响应所需投影后，才以已校验的原始 payload 执行 `SET ... IFEQ ... EX` 并续发同期限 Cookie；条件失败不创建 key。其他管理 API、SSE 心跳与原图资源只校验不续期。Web 不建立会话定时器。
- 改密：行锁内验证当前密码 → 以原始 payload 用 `IFEQ ... KEEPTTL` 原子替换为旧、新两个代际（会话已变化或 Redis 失败则回滚、不写新密码）→ 提交 PG → 其他会话仅当仍含行锁内旧代际且不含新代际时逐 key `DELEX ... IFEQ`。后台重置与删除账号同样携带行锁内旧代际，先提交 PG 再尽力清理。紧急密码恢复直接写 PG，Redis 可用时清除全部管理员会话。延迟清理不得命中新代际或同名重建账号；清理失败不改变已提交结果，残留会话在下次认证时失效。
- CSRF：受保护管理路由的所有非 GET 请求要求有效会话与 `X-CSRF-Token`。登录接口单独校验 `Origin`（存在则须同源，缺失允许）；其他写请求不统一做同源断言。Web 只使用 React Router Declarative Mode；引入 Data / Framework action、SSR 或 RSC 时须重新审查 CSRF 边界。
- 权限：页面准入与操作准入共用服务端角色能力矩阵。前端只消费 `/auth/me` 返回的 permissions 过滤导航、路由与预加载，role 只参与角色呈现及默认导航展开；服务端独立校验能力，是最终授权边界。高风险操作在解析正文或进入维护操作前返回 403，相关权限仍只授予超级管理员。
- 公开页只有本地存在 `site_session_hint` 时才探测 `/auth/me`；提示位不参与鉴权，伪造它最多触发一次探测，不会预载管理代码或取得管理数据。未登录探针只返回登录页需要的开关与背景；任一受保护请求 401 清除 CSRF token 与提示位，403 隐藏当前详情的管理入口。嵌入路由始终是访客，不挂载会话所有者。
- 偏好接口只用会话中的用户名定位账号，不接受客户端指定目标；`localStorage` 只承担首帧、离线待同步与多标签同步，不保存会话或 CSRF token，不参与鉴权，也不能覆盖 PG。
- 外部原图入口 `/images/original/<id>`：GET / HEAD 及条件请求先校验管理员会话（图片管理员与超级管理员均可），校验完成前不读取记录或访问源站；成功响应 `private, no-cache`，不继承源站公开缓存，带 `Vary: Cookie, User-Agent`。公开详情的 `original_url` 只对有效管理员非空，访客为 `null`；详情 `private, no-cache` + `Vary: Cookie`，共享数据库行后按请求身份独立投影，禁止共享缓存。

## 登录防护

- 密码使用原生 Argon2id 固定参数与恒定时间比较；登录只接受与当前策略完全一致的哈希，不在登录路径自动改写密码记录。
- 登录限流（来源 + 用户名、全局）在一次 Redis 原子操作中按来源→全局顺序预留，来源已拒绝时不消耗全局额度；成功登录清除该组合计数；达到上限后计数停止增长，不延长已建立的 TTL。
- ALTCHA 完全自托管：签名主密钥只在进程内存（重启使未提交的证明失效，不影响已有会话）；签名验证后用 Redis `SET NX` 带 TTL 一次性消费 nonce；挑战签发另有限流。服务端限制工作量上界与最短有效期，避免可通过配置校验却必然超时或过期。是否校验只由服务端配置决定。

## 资源与跨源

- 防盗链：主站三档图片与本地公开 Host 在读取对象、跳转、Range 与条件请求处理前校验 Referer。空 Referer 有意放行（直接访问与 `no-referrer` 加载）；白名单与随机豁免同源（本站 HTTPS origin、同端口子域、`embed.allowed_origins`，不受 `embed.enabled` 控制）；URL 解析后匹配，通配要求子域边界且不含根域；其他来源返回不可缓存的 `403 image_referer_forbidden`；响应带 `Vary: Referer`。它只约束到达应用的请求，S3 / CDN 直链和忽略 Vary 的 CDN 不受控。外部原图按会话授权，静态资产不校验 Referer。
- 稳定图片 URL 不是授权边界：回收站图片的已知直链仍可访问，永久删除才清理对象。
- CORS：主站业务 API 没有跨源读取契约，不返回 `Access-Control-Allow-*`；外部原图不开放 CORS。例外是主站三档图片、本地图片与静态资源 Host（`*`、无凭据、暴露 ETag / Content-Range / Accept-Ranges）、主站 `/asset/` 运维图片以及 `/random`。
- `publicSiteCors` 装配在 Host / 冷启动边界之前以覆盖错误响应；资源预检只允许 GET / HEAD 与 Range、条件请求头，不支持的预检返回 403；实际请求仍执行 Referer 校验。
- `/asset/` 只在主站提供、不校验 Referer，响应以 `default-src 'none'; style-src 'unsafe-inline'; sandbox` 覆盖默认 CSP，避免直接打开的 SVG 在本站源执行脚本。
- 公共图片数据 API 用 `Sec-Fetch-Site` 拒绝跨站 / 同站跨源读取，放行同源、`none` 与不发该头的客户端；它是跨源护栏，不是反爬措施。`/api/site-config` 内联进 SPA 启动且不设限，因此只能投影公开页面实际消费的字段。
- 不发送 COEP / CORP：会破坏 HTTPS 外链图片、公开出口被其他站点引用、ALTCHA Worker 与嵌入页。不发送 HSTS：只能由确认掌握全部相关主机 TLS 的最外层代理部署。
- 安全响应头在最终响应对象上统一补齐，覆盖 API、静态、错误与未知 Host 响应。只有服务端确认 `embed.enabled` 后，三个精确嵌入路径才移除 `X-Frame-Options` 并生成 `frame-ancestors`（`site.domain` 的 HTTPS origin、同端口子域、额外的 DNS 精确 origin 或子域通配；拒绝 IP、裸 `*` 与中间通配）。不根据 `Origin` / `Referer` 反射来源；嵌入授权按来源而非父页面路径。
- 脚本 CSP 为同源脚本（加配置的静态资源 origin）、同源 Worker、`object-src 'none'`、`base-uri 'self'`。当前不设 `default-src`、`img-src`、`connect-src`、`style-src`、`form-action`，修改前须评估外链图片、展映纹理与嵌入的影响。
- 嵌入 postMessage 协议（光标、安全区）只接受直接父窗口，首次有效连接后锁定精确来源并校验实例 ID，拒绝 opaque origin，不依赖 Referer，不暴露白名单，不传图片、账号、会话或 DOM，也不提供业务能力。安全区上报只读取子文档自身的原生值，不回传宿主下发值，避免反馈循环。

## 外部抓取（SSRF）

- 统一安全 fetch：只允许 `https` 与域名（拒绝 IP 字面量）；请求前与每次重定向后校验主机；受控 DNS lookup 后再校验实际连接地址，阻断 rebinding。DNS 结果先按声明 family 严格校验格式（拒绝 zone ID 与裸 IPv4-compatible 写法）。地址按 IANA special-purpose registry 的 Globally Reachable 语义与当前全局单播范围分类，最长前缀优先、默认拒绝；只有 IPv4-mapped 与 `64:ff9b::/96` 提取嵌入 IPv4 复用同一分类。TLS 证书校验必须启用；按内容嗅探确认图片格式。对外统一通用提示，debug 日志只记录原因、协议与规范化主机名。
- 导入下载为每个通过校验的目标生成只含 https origin 的 Referer，重定向后重新生成，不透传路径、查询或管理员输入的 Referer。
- 原图代理把请求取消贯穿到抓取，取消不触发代理 fallback；共享的直连探测不因单个调用者取消而中止，也不把取消缓存为“不可直连”。

## 请求体与输入

- 中间件顺序：Host / 安全响应头 → 会话认证 → 审计 → CSRF → 所属档位的字节 limiter → JSON 解析 → schema / 业务。匿名大请求在读取正文前 401；缺少 CSRF 在 limiter 前 403。
- 请求体按档位限制字节，档位上限按最坏合法 JSON 转义计算并保留余量；应用不解码压缩请求体，代理须使用一致或更严格的限制。
- JSON 写路由只接受 `application/json` 或 `+json`；空、截断或语法错误统一 `400 invalid_json`；strict schema 拒绝未知字段，全可选更新至少要有一个有效字段；被拒绝的请求不进入领域写入、缓存失效或审计。
- 外部图片、来源、作者、站点资源与远端存储地址只接受 HTTPS；URL 规范化原样保留路径、查询与签名。
- 动态响应头写入前拒绝控制符、零宽与双向控制符；上游异常的 ETag、Last-Modified、Content-Type、Content-Range、Content-Length 被省略、回退或重建为规范形式。
- 管理员可配置的文本按文字渲染；页脚的受限 HTML 只重建文字、HTTPS 链接与换行。

## 缓存头原则

- 缓存策略全部由应用生成，反向代理不重复实现。公开列表短共享缓存（每日随机页收口至当日剩余时间）；详情与确定性管理只读 JSON 为 `private, no-cache` + 内容 ETag；随机、登录、写接口、SSE、错误与健康检查不缓存；hash 资产与稳定图片 `immutable`。权限、可见性、404 与周期判断先于条件验证。
- 含实时测量值的响应（如概览的 Redis 占用）保持普通私有读取，不为 304 固定表示。

## 日志

- 服务端日志、浏览器错误上报与密码 CLI 共用 shared 中的纯清洗规则：明确敏感字段不保留原值，URL 只留协议与主机；按字段的明确含义处理，不按 source、original、key 子串批量清除（保留定位所需的图片、任务、对象键）；不执行 getter / toJSON；有界摘要并以有效 JSON 截断。请求 ID 由服务端生成，不采用客户端关联号；只记录路由模板。
- 清洗无法识别自由文本中的秘密：调用方只传诊断所需信息，不传完整配置、请求对象、正文或凭据。
