# 安全

- 管理会话存于 Redis，Cookie 为 `HttpOnly` + `SameSite=Lax`，识别为 HTTPS 时附加 `Secure`；所有写操作要求 `X-CSRF-Token` 并校验同源。
- 登录失败限流：每 IP + 用户名 60 秒内 5 次失败即拦截，叠加 180 秒内 10 次尝试的全局兜底（阈值与窗口均可在 `config.json` 的 `security.*` 调整）。
- 登录前置图形验证码（一次性，存于 Redis，校验即焚），可在 `config.json` 的 `captcha.enabled` 关闭。
- 全站响应头包含 `X-Content-Type-Options`、`X-Frame-Options`、`Referrer-Policy`、`Cross-Origin-Opener-Policy` 与 CSP。
