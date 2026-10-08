export const imageGroupMembershipLimit = 50;
export const imageGroupBatchLimit = 200;

export type ImageGroupDto = {
  slug: string;
  display_name: string;
  sort_order: number;
  image_count: number;
};

export type ImageGroupListResponseDto = { items: ImageGroupDto[] };
type ImageGroupAddStatus =
  | "added"
  | "already_member"
  | "not_found"
  | "invalid_id"
  | "group_limit";
export type ImageGroupAddResultDto = { id: string; status: ImageGroupAddStatus };
export type ImageGroupAddResponseDto = { items: ImageGroupAddResultDto[] };
