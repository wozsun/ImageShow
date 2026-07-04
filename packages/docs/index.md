---
layout: home
hero:
  name: ImageShow
  text: 自托管图库 + 随机图 API
  tagline: 从部署、配置、上传处理到随机图接口，一处掌握。文档随应用一起构建发布，适合运维、排障和二次开发时快速定位。
  actions:
    - theme: brand
      text: 快速开始
      link: /guide/getting-started
    - theme: alt
      text: 了解架构
      link: /guide/architecture
features:
  - icon: 🖼️
    title: 图库与后台
    details: 上传、导入、分类、批量编辑、回收站，按设备、亮度、主题、标签和作者组织图片。
  - icon: 🎲
    title: 随机图 API
    details: /random 按分类与筛选条件返回图片，可直接作为随机图链接或外部服务图片源。
  - icon: 🧩
    title: 多后端存储
    details: 本地磁盘、S3 兼容对象存储与 WebDAV 并存，每张图片记录自身所在后端。
  - icon: ⚙️
    title: 配置可热加载
    details: 常用配置由后台管理，进阶配置落在 config.json，读取配置文件后即时生效。
  - icon: 🔄
    title: 异步处理队列
    details: 缩略图补建、移动清理、缓存重建和上传清理进入后台任务队列。
  - icon: 🛡️
    title: Host 隔离
    details: 主站、随机图、静态资源、代理链接和文档站按子域隔离，降低跨域与 Cookie 风险。
---
<section class="home-section">
  <div class="home-section__header">
    <p class="home-section__eyebrow">Reading path</p>
    <h2 class="home-section__title">按你的目标进入对应文档</h2>
    <p class="home-section__description">文档不要求从头读完。部署、配置、理解上传链路、接入随机图 API 是四条最常用路径。</p>
  </div>
  <div class="docs-map-grid">
    <a class="docs-map-card" href="/guide/getting-started">
      <span class="docs-card-kicker">01</span>
      <h3>先跑起来</h3>
      <p>准备 Docker Compose、初始化管理员账号，并确认主站、后台、画廊和随机图入口。</p>
    </a>
    <a class="docs-map-card" href="/guide/configuration">
      <span class="docs-card-kicker">02</span>
      <h3>调整配置</h3>
      <p>理解 config.json、环境变量、上传标准化、缩略图、首页与安全配置的职责边界。</p>
    </a>
    <a class="docs-map-card" href="/guide/flows">
      <span class="docs-card-kicker">03</span>
      <h3>看懂流程</h3>
      <p>追踪本地上传、链接下载、代理链接、提交入库、删除生命周期和缓存策略。</p>
    </a>
    <a class="docs-map-card" href="/guide/random-api">
      <span class="docs-card-kicker">04</span>
      <h3>接入 API</h3>
      <p>使用随机图接口的设备、亮度、主题、标签、作者和返回模式筛选参数。</p>
    </a>
  </div>
</section>

<section class="home-section">
  <div class="home-section__header">
    <p class="home-section__eyebrow">System map</p>
    <h2 class="home-section__title">一张图理解运行边界</h2>
    <p class="home-section__description">ImageShow 把元数据、缓存和图片字节拆成三层；上传 prepare 在请求内生成候选对象，其余持久维护任务由后台 Worker 承接。</p>
  </div>
  <div class="docs-workflow-grid">
    <div class="docs-workflow-step">
      <span class="docs-step-index">A</span>
      <h3>PostgreSQL 是真相源</h3>
      <p>图片元数据、配置、任务、标签、主题、作者、管理员和存储后端注册表都以数据库为准。</p>
    </div>
    <div class="docs-workflow-step">
      <span class="docs-step-index">B</span>
      <h3>Redis 只做加速层</h3>
      <p>随机池、筛选项、读缓存和去重历史可以重建；Redis 异常时读路径回退到 PostgreSQL。</p>
    </div>
    <div class="docs-workflow-step">
      <span class="docs-step-index">C</span>
      <h3>存储后端可并存</h3>
      <p>Local、S3 与 WebDAV 都是命名后端；每张图片通过 storage_slug 解析自己的原图和缩略图。</p>
    </div>
  </div>
</section>
