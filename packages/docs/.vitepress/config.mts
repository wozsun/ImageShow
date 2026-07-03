// 本文件配置 VitePress 文档站的站点信息、导航与构建选项。

import { defineConfig } from "vitepress";

export default defineConfig({
  lang: "zh-CN",
  title: "ImageShow",
  titleTemplate: ":title · 文档",
  description: "ImageShow 自托管图库、后台管理与随机图 API 文档。",
  cleanUrls: false,
  lastUpdated: true,
  themeConfig: {
    siteTitle: "ImageShow Docs",
    nav: [
      { text: "快速开始", link: "/guide/getting-started" },
      { text: "架构", link: "/guide/architecture" },
      { text: "配置", link: "/guide/configuration" },
      { text: "随机图 API", link: "/guide/random-api" }
    ],
    search: {
      provider: "local",
      options: {
        translations: {
          button: {
            buttonText: "搜索文档",
            buttonAriaLabel: "搜索文档"
          },
          modal: {
            displayDetails: "显示详情",
            resetButtonTitle: "清除搜索",
            backButtonTitle: "关闭搜索",
            noResultsText: "没有找到结果",
            footer: {
              selectText: "选择",
              selectKeyAriaLabel: "回车",
              navigateText: "切换",
              navigateUpKeyAriaLabel: "上箭头",
              navigateDownKeyAriaLabel: "下箭头",
              closeText: "关闭",
              closeKeyAriaLabel: "Esc"
            }
          }
        }
      }
    },
    sidebar: [
      {
        text: "开始",
        items: [
          { text: "简介", link: "/" },
          { text: "快速开始", link: "/guide/getting-started" }
        ]
      },
      {
        text: "架构与原理",
        items: [
          { text: "架构总览", link: "/guide/architecture" },
          { text: "项目结构", link: "/guide/project-structure" },
          { text: "数据库结构", link: "/guide/database" },
          { text: "功能与流程", link: "/guide/flows" }
        ]
      },
      {
        text: "配置与部署",
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
    ],
    outline: {
      label: "本页目录",
      level: [2, 3]
    },
    docFooter: {
      prev: "上一篇",
      next: "下一篇"
    },
    lastUpdated: {
      text: "最后更新"
    },
    darkModeSwitchLabel: "切换深色模式",
    returnToTopLabel: "回到顶部",
    sidebarMenuLabel: "文档菜单"
  }
});
