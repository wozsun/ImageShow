import type {
  ImageUpdateItemInputDto,
  ImageUpdateItemResultDto,
  ImageUpdateResponseDto
} from "@imageshow/shared/browser";
import type {
  EditableImageSnapshot,
  ImageDraft
} from "../../../lib/types.js";
import {
  normalizeAuthor,
  normalizeTheme
} from "../../../lib/upload/upload-utils.js";

export type ImageMetadataUpdate = ImageUpdateItemInputDto;

export type ImageMetadataSessionState = {
  activeIds: string[];
  baselineItems: EditableImageSnapshot[];
  drafts: Record<string, ImageDraft>;
};

export type ImageMetadataSaveAttempt = {
  activeIds: string[];
  items: ImageMetadataUpdate[];
  response: ImageUpdateResponseDto | null;
};

export type ImageMetadataSaveReport = ImageUpdateResponseDto & {
  responseReceived: boolean;
  snapshotFailed: boolean;
  unavailableIds: string[];
};

export type ImageMetadataCardSaveState =
  | "saved"
  | "failed"
  | "pending"
  | null;

export type ImageMetadataSaveOutcome = {
  attempt: ImageMetadataSaveAttempt;
  authoritativeItems: EditableImageSnapshot[] | null;
  report: ImageMetadataSaveReport;
};

export type ImageMetadataChanges = Record<keyof ImageDraft, boolean>;

const imageDraftFields = [
  "title",
  "description",
  "source",
  "original",
  "device",
  "brightness",
  "theme",
  "author",
  "tags"
] as const satisfies readonly (keyof ImageDraft)[];

function draftFromImage(item: EditableImageSnapshot): ImageDraft {
  return {
    title: item.title,
    description: item.description,
    source: item.source,
    original: item.original,
    device: item.device,
    brightness: item.brightness,
    theme: item.theme === "none" ? "" : item.theme,
    author: item.author === "none" ? "" : item.author,
    tags: [...item.tags]
  };
}

function draftsFromImages(items: EditableImageSnapshot[]) {
  return Object.fromEntries(
    items.map((item) => [item.id, draftFromImage(item)])
  );
}

export function createImageMetadataSession(
  items: EditableImageSnapshot[]
): ImageMetadataSessionState {
  return {
    activeIds: items.map((item) => item.id),
    baselineItems: items,
    drafts: draftsFromImages(items)
  };
}

function tagsChanged(draftTags: string[], savedTags: string[]) {
  return JSON.stringify([...draftTags].sort())
    !== JSON.stringify([...savedTags].sort());
}

export function fieldsChangedFor(
  item: EditableImageSnapshot,
  draft: ImageDraft
): ImageMetadataChanges {
  return {
    title: draft.title !== item.title,
    description: draft.description !== item.description,
    source: draft.source !== item.source,
    original: draft.original !== item.original,
    device: draft.device !== item.device,
    brightness: draft.brightness !== item.brightness,
    theme: normalizeTheme(draft.theme) !== normalizeTheme(item.theme),
    author: normalizeAuthor(draft.author)
      !== normalizeAuthor(item.author === "none" ? "" : item.author),
    tags: tagsChanged(draft.tags, item.tags ?? [])
  };
}

export function changedMetadataUpdate(
  item: EditableImageSnapshot,
  draft: ImageDraft,
  changed: ImageMetadataChanges
): ImageMetadataUpdate {
  const update: ImageMetadataUpdate = { id: item.id };
  if (changed.title) update.title = draft.title;
  if (changed.description) update.description = draft.description;
  if (changed.source) update.source = draft.source;
  if (changed.original) update.original = draft.original;
  if (changed.device) update.device = draft.device;
  if (changed.brightness) update.brightness = draft.brightness;
  if (changed.theme) update.theme = normalizeTheme(draft.theme);
  if (changed.author) update.author = normalizeAuthor(draft.author);
  if (changed.tags) update.tags = draft.tags;
  return update;
}

function valuesEqual(
  field: keyof ImageDraft,
  left: ImageDraft[keyof ImageDraft],
  right: ImageDraft[keyof ImageDraft]
) {
  if (field === "tags") {
    return !tagsChanged(left as string[], right as string[]);
  }
  if (field === "theme") {
    return normalizeTheme(left as string) === normalizeTheme(right as string);
  }
  if (field === "author") {
    return normalizeAuthor(left as string) === normalizeAuthor(right as string);
  }
  return left === right;
}

function draftStillHasSubmittedIntent(
  field: keyof ImageDraft,
  draft: ImageDraft,
  update: ImageMetadataUpdate
) {
  const submitted = update[field] as ImageDraft[keyof ImageDraft];
  return valuesEqual(field, draft[field], submitted);
}

function submittedIntentMatchesSnapshot(
  field: keyof ImageDraft,
  update: ImageMetadataUpdate,
  item: EditableImageSnapshot
) {
  const submitted = update[field] as ImageDraft[keyof ImageDraft];
  const authoritativeDraft = draftFromImage(item);
  // auto 是重新识别命令，不是 PostgreSQL 的持久值。具体分类无法证明命令已经
  // 执行；只有服务端明确返回 updated 时才能清除，failed 或响应丢失都保留草稿。
  if (
    (field === "device" || field === "brightness")
    && submitted === "auto"
  ) {
    return false;
  }
  return valuesEqual(field, submitted, authoritativeDraft[field]);
}

function updateMatchesSnapshot(
  update: ImageMetadataUpdate,
  item: EditableImageSnapshot
) {
  return imageDraftFields.every((field) => (
    !Object.hasOwn(update, field)
    || submittedIntentMatchesSnapshot(field, update, item)
  ));
}

export function createImageMetadataSaveReport(
  attempt: ImageMetadataSaveAttempt,
  authoritativeItems: EditableImageSnapshot[] | null
): ImageMetadataSaveReport {
  const authoritativeById = new Map(
    (authoritativeItems ?? []).map((item) => [item.id, item])
  );
  const responseReceived = attempt.response !== null;
  let response = attempt.response;
  if (!response) {
    const results: ImageUpdateItemResultDto[] = attempt.items.map((update) => {
      const item = authoritativeById.get(update.id);
      return item && updateMatchesSnapshot(update, item)
        ? { id: update.id, status: "updated" }
        : {
            id: update.id,
            status: "failed",
            code: "save_unconfirmed",
            message: "Image update could not be confirmed"
          };
    });
    const updated = results.filter((result) => result.status === "updated").length;
    response = {
      updated,
      failed: results.length - updated,
      results
    };
  }
  return {
    ...response,
    responseReceived,
    snapshotFailed: authoritativeItems === null,
    unavailableIds: authoritativeItems === null
      ? []
      : attempt.activeIds.filter((id) => !authoritativeById.has(id))
  };
}

/**
 * Projects the last save attempt onto one editor card. A successful mutation
 * whose authoritative reread is unavailable is deliberately not called
 * successful yet: the retained draft can be reconciled without resubmitting.
 */
export function imageMetadataCardSaveState(
  report: ImageMetadataSaveReport | null,
  imageId: string
): ImageMetadataCardSaveState {
  if (!report) return null;
  if (report.unavailableIds.includes(imageId)) return "failed";
  const result = report.results.find((candidate) => candidate.id === imageId);
  if (!result) return null;
  if (report.snapshotFailed) {
    return report.responseReceived && result.status === "failed"
      ? "failed"
      : "pending";
  }
  if (result.status === "failed") return "failed";
  return "saved";
}

export function reconcileImageMetadataSession(
  state: ImageMetadataSessionState,
  attempt: ImageMetadataSaveAttempt,
  authoritativeItems: EditableImageSnapshot[]
): ImageMetadataSessionState {
  const oldBaselineById = new Map(
    state.baselineItems.map((item) => [item.id, item])
  );
  const authoritativeById = new Map(
    authoritativeItems.map((item) => [item.id, item])
  );
  const updateById = new Map(attempt.items.map((item) => [item.id, item]));
  const resultById = new Map(
    (attempt.response?.results ?? []).map((result) => [result.id, result])
  );
  const drafts = { ...state.drafts };

  for (const item of authoritativeItems) {
    const authoritativeDraft = draftFromImage(item);
    const currentDraft = drafts[item.id] ?? authoritativeDraft;
    const oldBaseline = oldBaselineById.get(item.id);
    const update = updateById.get(item.id);
    const result = resultById.get(item.id);
    const changedBefore = oldBaseline
      ? fieldsChangedFor(oldBaseline, currentDraft)
      : Object.fromEntries(
          imageDraftFields.map((field) => [field, false])
        ) as ImageMetadataChanges;
    const nextDraft = { ...currentDraft };
    const writableDraft = nextDraft as Record<keyof ImageDraft, unknown>;

    for (const field of imageDraftFields) {
      const submitted = Boolean(update && Object.hasOwn(update, field));
      if (!submitted) {
        if (!changedBefore[field]) writableDraft[field] = authoritativeDraft[field];
        continue;
      }
      if (!update || !draftStillHasSubmittedIntent(field, currentDraft, update)) {
        // 回读失败后用户可能继续编辑；新意图不属于上一轮提交，必须保留。
        continue;
      }
      if (
        result?.status === "updated"
        || submittedIntentMatchesSnapshot(field, update, item)
      ) {
        writableDraft[field] = authoritativeDraft[field];
      }
    }
    drafts[item.id] = nextDraft;
  }

  for (const id of Object.keys(drafts)) {
    if (!authoritativeById.has(id)) delete drafts[id];
  }

  return {
    activeIds: state.activeIds.filter((id) => authoritativeById.has(id)),
    baselineItems: authoritativeItems,
    drafts
  };
}

export function restoreImageMetadataDrafts(
  state: ImageMetadataSessionState
): ImageMetadataSessionState {
  const baselineById = new Map(
    state.baselineItems.map((item) => [item.id, item])
  );
  const drafts = { ...state.drafts };
  for (const id of state.activeIds) {
    const item = baselineById.get(id);
    if (item) drafts[id] = draftFromImage(item);
  }
  return { ...state, drafts };
}
