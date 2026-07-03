# 安全

- 管理会话存于 Redis，Cookie 为 `HttpOnly` + `SameSite=Lax`，识别为 HTTPS 时附加 `Secure`；所有写操作要求 `X-CSRF-Token` 并校验同源。
- 登录失败限流：每 IP + 用户名 60 秒内 5 次失败即拦截，叠加 180 秒内 10 次尝试的全局兜底（阈值与窗口均可在 `config.json` 的 `security.*` 调整）。
- 登录前置图形验证码（一次性，存于 Redis，校验即焚），可在 `config.json` 的 `captcha.enabled` 关闭。
- 全站响应头包含 `X-Content-Type-Options`、`X-Frame-Options`、`Referrer-Policy`、`Cross-Origin-Opener-Policy` 与 CSP。
- 外部图片抓取统一走安全 fetch：只允许 `https` 且必须使用域名，不接受直接 IP；请求前和每次重定向后都解析并校验目标 IP，阻断 localhost、内网、链路本地、组播和云 metadata 地址；运行时必须启用 TLS 证书校验，证书无效时拒绝下载/代理；下载/代理会通过响应内容确认是支持的图片格式，非图片不会入库或转发。安全拒绝对外统一返回通用提示，内部 debug 日志保留拒绝原因。
- 公共画廊数据接口 `/api/images` 与 `/api/gallery-options` 的**跨源保护**：借 Fetch Metadata（`Sec-Fetch-Site`）拒绝**跨站 / 同站跨源**读取，只放行同源（前端自身，含主题子域走相对 URL）、直接导航（`none`）与**不发该头**的老浏览器 / 非浏览器客户端（优雅降级，不误伤画廊）。它是跨源护栏、不是反爬墙——省略该头的客户端仍可访问，合规爬虫由 robots.txt 兜。（`/api/site-config` 不设限——它是内联进 SPA 的启动配置，需在任意首屏场景下可加载。）
- **robots.txt（按主机区分，默认关闭）**：由 `config.json` 的 `site.robots_enabled` 控制，**默认 `false`**——此时 `/robots.txt` 对所有主机返回 404、不提供任何抓取规则。开启后按主机区分：主站**仅放行首页**（站点描述），画廊 / 接口 / 静态资源 / 后台一律不许抓取；`static.` / `link.` / `random.` 以及各主题子域（`<主题>.<域名>`）整站禁抓；`docs.` 文档站可正常抓取。
