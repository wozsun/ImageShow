import type { ImageGroupAddResultDto } from "@imageshow/shared/browser";

export const groupMemberResultLabels: Record<ImageGroupAddResultDto["status"], string> = {
  added: "已加入",
  already_member: "已在组内",
  not_found: "未找到或在回收站中",
  invalid_id: "不是有效的图片 ID",
  group_limit: "已达每张图的分组上限"
};
