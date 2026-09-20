# ImageShow

[![Publish Release](https://github.com/wozsun/ImageShow/actions/workflows/publish-release.yml/badge.svg)](https://github.com/wozsun/ImageShow/actions/workflows/publish-release.yml)

ImageShow 是面向个人服务器的自托管图片画廊，集图片展示、随机图 API 和轻量后台管理于一体，方便收藏、整理和分享图片。

## 功能

- **浏览与展映**：首页、瀑布流画廊、图片详情，以及瀑布流和漂浮两种自动展映模式，支持全屏观看与全面屏安全区适配。
- **分类筛选**：按设备、亮度、主题、标签和作者查找图片，支持无主题筛选和标签组合。
- **随机图 API**：按条件获取图片、跳转链接或 JSON，支持固定种子选图和完整图 / 缩略图。
- **上传与导入**：支持本地文件、URL、JSONL 和微博链接。
- **图片管理**：属性编辑、批量操作、分类维护、回收站和恢复；外部原图仅供管理员访问。
- **存储管理**：本地存储与 S3 兼容对象存储，可迁移图片并设置图片公开地址。
- **站点管理**：管理员权限、站点配置、页脚备案信息、配置包、日志、检查与页面嵌入，可设置独立静态资源地址；嵌入页支持[宿主自定义光标协作](docs/guide/embed-cursor.md)与[安全区同步](docs/guide/embed-safe-area.md)。

## 快速部署

需要 Docker 和 Docker Compose；公网访问还需域名和 HTTPS 反向代理。

1. 新建部署目录，将 [compose.yaml](compose.yaml) 和 [.env.example](.env.example) 放入其中，执行：

   ```bash
   cp .env.example .env
   ```

2. 编辑 `.env`，填写两个不同的随机强密码，并设置实际域名（不带协议或路径）：

   ```ini
   DATABASE_PASSWORD=
   ADMIN_USERNAME=admin
   ADMIN_PASSWORD=
   SITE_DOMAIN=img.example.com
   ```

   管理员密码须为 8–128 位，且同时包含字母和数字。

3. 在部署目录启动服务：

   ```bash
   docker compose pull
   docker compose up -d
   ```

4. 将域名解析到服务器，开放 `80`、`443` 端口，并配置 HTTPS 反向代理至
   `http://127.0.0.1:5518`。配置见[反向代理示例](docs/DEPLOY.md#反向代理与-https)。

打开 `https://img.example.com/admin`，使用初始账号上传图片；打开站点根地址即可浏览。
临时本机体验可将 `SITE_DOMAIN` 留空，访问 `http://127.0.0.1:5518/admin`。
数据保存在部署目录的 `data/`、`postgres/`、`redis/`，请妥善备份。

## 使用说明

[文档入口](docs/README.md) · [部署与恢复](docs/DEPLOY.md) · [配置说明](docs/CONFIG.md) · [随机图 API](docs/guide/random-api.md)

## 许可

见 [LICENSE](LICENSE)。
