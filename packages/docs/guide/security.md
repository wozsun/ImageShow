# 安全

- 管理会话存于 Redis，Cookie 为 `HttpOnly` + `SameSite=Lax`，识别为 HTTPS 时附加 `Secure`；所有写操作要求 `X-CSRF-Token` 并校验同源。
- 登录失败限流：每 IP + 用户名 15 分钟 10 次，叠加 60 秒 30 次的全局兜底。
- 全站响应头包含 `X-Content-Type-Options`、`X-Frame-Options`、`Referrer-Policy`、`Cross-Origin-Opener-Policy` 与 CSP。
