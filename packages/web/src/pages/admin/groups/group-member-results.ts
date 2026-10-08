import type { ImageGroupAddResultDto } from "@imageshow/shared/browser";

const groupMemberResultLabels: Record<ImageGroupAddResultDto["status"], string> = {
  added: "已加入",
  already_member: "已在组内",
  not_found: "未找到或在回收站中",
  invalid_id: "不是有效的图片 ID",
  group_limit: "已达每张图的分组上限"
};

const failureDetailLimit = 3;

function isJoined(item: ImageGroupAddResultDto) {
  return item.status === "added" || item.status === "already_member";
}

/** 按结果分类计数；有未加入的图片时再列出前几个 ID，其余只给总数。 */
export function groupMemberAddSummary(items: ImageGroupAddResultDto[]) {
  const counts = Object.entries(groupMemberResultLabels).flatMap(([status, label]) => {
    const count = items.filter((item) => item.status === status).length;
    return count ? [`${label} ${count} 张`] : [];
  });
  const failed = items.filter((item) => !isJoined(item));
  if (!failed.length) return { complete: true, message: counts.join("；") };
  const shown = failed.slice(0, failureDetailLimit).map((item) => item.id).join("、");
  const more = failed.length > failureDetailLimit ? ` 等 ${failed.length} 张` : "";
  return { complete: false, message: `${counts.join("；")}。未加入：${shown}${more}` };
}

export function groupMemberRemoveSummary(requested: number, removed: number) {
  if (!removed) return "这些图片已不在组内";
  return removed < requested
    ? `已移出 ${removed} 张图片；${requested - removed} 张已不在组内`
    : `已移出 ${removed} 张图片`;
}
