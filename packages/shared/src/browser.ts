/**
 * 浏览器安全共享契约。
 *
 * 这里是 Web 与 Server 共同消费的 DTO、枚举和限制的唯一入口。完整运行时
 * 默认配置只由包根入口导出，浏览器代码不得从根入口导入。
 */
export * from "./browser/common.ts";
export * from "./browser/settings.ts";
export * from "./browser/images.ts";
export * from "./browser/storage.ts";
export * from "./browser/ingestion.ts";
export * from "./browser/admin.ts";
