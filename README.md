# ImageShow

[![Publish Release](https://github.com/wozsun/ImageShow/actions/workflows/publish-release.yml/badge.svg)](https://github.com/wozsun/ImageShow/actions/workflows/publish-release.yml)

ImageShow 是一个可以部署在自己服务器上的图片画廊，用来收藏、整理、浏览和分享图片。

## 可以做什么

- **浏览图片**：在画廊中查看图片，或以瀑布流、漂浮、星群三种方式自动展映，支持手机和电脑。
- **整理收藏**：按横竖分类、明暗、主题、标签和作者查找图片，也能组合或排除条件。
- **添加图片**：上传本地文件，通过图片链接、微博链接或批量清单导入。
- **管理图库**：编辑图片信息、批量整理，移入回收站的图片可以恢复。
- **分享图片**：分享筛选后的画廊和展映页面，将画廊嵌入其他网站，或通过随机图片链接为网页配图。
- **管理自己的站点**：设置名称、首页文案和管理员权限，选择本地或云端存储。

## 开始使用

准备一台装有 Docker 的服务器，按照[安装说明](docs/DEPLOY.md#首次安装)完成安装，登录后台添加图片，再从首页进入画廊或展映。

## 文档

- 部署：[安装与维护](docs/DEPLOY.md)、[配置参考](docs/CONFIG.md)
- 接入：[随机图 API](docs/api/random.md)、[嵌入页面](docs/api/embed.md)，以及嵌入页的[宿主光标协议](docs/api/embed-cursor.md)和[安全区协议](docs/api/embed-safe-area.md)

## 许可

见 [LICENSE](LICENSE)。
