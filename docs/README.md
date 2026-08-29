# ImageShow 文档

这里保存可直接在仓库中阅读的维护文档，不参与 npm workspace、生产构建或运行时路由。
先按自己的身份选择入口；角色页负责给出任务路径，技术参考负责维护唯一的完整契约。

## 按角色开始

| 身份 | 适用范围 | 入口 |
| --- | --- | --- |
| 普通用户 | 浏览、筛选、图片详情、嵌入页与随机图 API | [普通用户指南](guide/roles/ordinary-user.md) |
| 图片管理员 | 日常上传 / 导入、编辑、分类、移入回收站、恢复与只读检查 | [图片管理员指南](guide/roles/image-admin.md) |
| 超级管理员 | 应用内账号、配置、存储与高风险维护 | [超级管理员指南](guide/roles/super-admin.md) |
| 实例维护者 | Compose、反向代理、数据卷、升级、健康与恢复 | [实例维护者指南](guide/roles/instance-maintainer.md) |

超级管理员是应用角色；实例维护者是部署职责，两者不会互相替代。

## 技术参考

- 入门与部署：[快速开始](guide/getting-started.md)、[生产部署](guide/deployment.md)
- 系统设计：[架构总览](guide/architecture.md)、[项目结构](guide/project-structure.md)
- 运行契约：[配置说明](guide/configuration.md)、[数据库结构](guide/database.md)、
  [存储](guide/storage.md)、[安全](guide/security.md)
- 功能出口：[功能与流程](guide/flows.md)、[随机图 API](guide/random-api.md)、
  [主机与资源子域](guide/subdomains.md)
