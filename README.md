# ImageShow

ImageShow 是一个面向个人服务器的图片展示、图库管理与随机图 API 服务。它提供公开首页与瀑布流画廊、后台上传管理、本地与 S3 兼容对象存储（多后端并存）、Redis 随机池缓存，以及一键 Docker 部署。

## 功能

- 公开首页与画廊，可按设备、亮度、主题筛选。
- 主题子域名（如 `nature.img.example.com`），以及 `random.*`、`static.*`、`docs.*` 三个保留子域名。
- `/random` 随机图 API，支持 `d`/`b`/`t`/`m` 参数；`/img-count` 提供随机池统计。
- 后台图片上传、编辑、删除、回收站、重复 MD5 检查。
- **存储多后端并存**：本地目录与 S3 兼容对象存储可同时使用，每张图片记录自己所在后端，可单张或批量在后端之间迁移。
- WebP 缩略图，数据库 / 存储 / Redis 自检与存储迁移工具。

## 文档

部署、配置、子域名、存储、随机图 API、安全等完整说明见文档站点（`packages/docs`，VitePress 构建，随应用一起发布，访问 `docs.<你的域名>`）。本地预览：

```bash
npm install
npm run dev -w @imageshow/docs
```

## 许可

见 [LICENSE](LICENSE)。
