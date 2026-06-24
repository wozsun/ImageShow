import { defineConfig } from "vitepress";

// VitePress builds the docs into .vitepress/dist. That output is copied into the
// server bundle (dist/docs) by packages/server/scripts/copy-assets.mjs and served
// on docs.<APP_DOMAIN> by packages/server/src/routes/docs.ts — so the docs ship and
// deploy together with the app. base stays "/" because the docs host serves at root.
export default defineConfig({
  lang: "zh-CN",
  title: "ImageShow 文档",
  description: "ImageShow 自托管图库与随机图 API 的使用与部署文档。",
  cleanUrls: false,
  themeConfig: {
    nav: [
      { text: "指南", link: "/guide/getting-started" }
    ],
    sidebar: [
      {
        text: "开始",
        items: [
          { text: "简介", link: "/" },
          { text: "快速开始", link: "/guide/getting-started" }
        ]
      },
      {
        text: "部署",
        items: [
          { text: "配置说明", link: "/guide/configuration" },
          { text: "单容器与反向代理", link: "/guide/deployment" },
          { text: "子域名", link: "/guide/subdomains" }
        ]
      },
      {
        text: "使用",
        items: [
          { text: "存储：本地 / S3", link: "/guide/storage" },
          { text: "随机图 API", link: "/guide/random-api" },
          { text: "安全", link: "/guide/security" }
        ]
      }
    ]
  }
});
