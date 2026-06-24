# 子域名

应用通过 `Host` 头区分子域名，反向代理只需把 `img.example.com` 与 `*.img.example.com` 都转发到应用即可（无需为子域名编写额外规则），并确保 TLS 证书覆盖通配子域名：

- `<主题>.img.example.com`：对应主题的画廊，例如 `nature.img.example.com`。
- `random.img.example.com`：等价于 `img.example.com/random`，可携带 `d`/`b`/`t`/`m` 查询参数，适合直接作为随机图链接分发。
- `static.img.example.com`：本地存储图片的独立资源域名（与主站 Cookie 隔离、单独缓存策略）。本地图片的公开链接会自动指向该域名；`/media`、`/thumbs` 对象字节仅在该域名提供，主站与主题域名不暴露这些路径。
- `docs.img.example.com`：文档站点。由 `packages/docs`（VitePress）构建，随应用一起打包发布，该域名只提供文档静态页面，不暴露 API / 主站 / 对象字节。

若站点直接使用二级域名（`site.domain` 配为 `example.com`），上述保留子域名相应变为 `random.example.com`、`static.example.com`、`docs.example.com`、`<主题>.example.com`。`static.*` 需要站点为可解析通配子域名的真实域名（本地存储图片依赖该子域名提供，请勿使用 `localhost`）。`random` / `static` / `docs` 这三个保留前缀本身也可在配置文件中通过 `site.random_subdomain` / `site.static_subdomain` / `site.docs_subdomain` 改名。
