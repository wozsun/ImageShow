import {
  basicTagValue,
  detectDeviceFromUserAgent,
  publicTagGroupLimit,
  type GalleryFacetsDto,
  type GalleryStatsDto
} from "@imageshow/shared/browser";
import { Icon, type IconName } from "../../icon/Icon.js";
import { MatchedText } from "../../data-display/FacetSuggestionLabel.js";
import { OverflowMarqueeText } from "../../data-display/OverflowMarqueeText.js";
import { publicFilterOptionState } from "../../../lib/gallery/public-filter-options.js";
import { matchFacetText } from "../../../lib/ui/facet-input.js";
import type { FacetOption } from "../../../lib/types.js";
import {
  publicFilterLabels,
  publicFilterSections,
  type PublicFilterDraft,
  type PublicFilterSectionKey,
  type TagSelection
} from "../../../lib/gallery/public-filter-draft.js";

export const publicFilterIcons: Record<PublicFilterSectionKey, IconName> = {
  device: "slideshow-3-line",
  brightness: "contrast-2-line",
  theme: "image-line",
  tag: "hashtag",
  author: "user-3-line"
};
function optionCount(
  stats: GalleryStatsDto | undefined,
  section: PublicFilterSectionKey,
  slug: string
): number | undefined {
  if (!stats) return undefined;
  if (section === "device") {
    const device = slug === "auto" ? detectDeviceFromUserAgent(window.navigator.userAgent) : slug;
    return device
      ? stats.devices.find((item) => item.device === device)?.image_count
      : stats.devices.reduce((sum, item) => sum + item.image_count, 0);
  }
  if (section === "brightness")
    return slug
      ? stats.brightnesses.find((item) => item.brightness === slug)?.image_count
      : stats.brightnesses.reduce((sum, item) => sum + item.image_count, 0);
  return stats[section === "theme" ? "themes" : section === "tag" ? "tags" : "authors"].find(
    (item) => item.slug === slug
  )?.image_count;
}

type Props = {
  section: PublicFilterSectionKey;
  id: string;
  draft: PublicFilterDraft;
  tag: { selection: TagSelection };
  tagLocked: boolean;
  options: readonly FacetOption[];
  facets: GalleryFacetsDto | undefined;
  facetsLoading: boolean;
  totals: { data: GalleryStatsDto | undefined; isError: boolean; refetch: () => unknown };
  counts: GalleryStatsDto | undefined;
  availabilityUnverified: boolean;
  normalizedQuery: string;
  matchName: typeof matchFacetText;
  edit: (draft: PublicFilterDraft) => boolean;
  setTag: (selection: TagSelection) => boolean;
  updateTagGroup: (
    changes: Partial<Pick<TagSelection["groups"][number], "mode" | "selected">>
  ) => boolean;
  finishTagGroup: () => void;
  deleteTagGroup: (id: number) => void;
  toggle: (section: PublicFilterSectionKey, slug: string) => void;
};

export function PublicFilterSection({
  section,
  id,
  draft,
  tag,
  tagLocked,
  options,
  facets,
  facetsLoading,
  totals,
  counts,
  availabilityUnverified,
  normalizedQuery,
  matchName,
  edit,
  setTag,
  updateTagGroup,
  finishTagGroup,
  deleteTagGroup,
  toggle
}: Props) {
  const activeTagGroup = tag.selection.groups.find((group) => group.id === tag.selection.activeId)!;
  const isFixed = section === "device" || section === "brightness";
  const selected = isFixed
    ? [draft[section]]
    : section === "tag"
      ? activeTagGroup.selected
      : draft[section].selected;
  const mode = isFixed ? null : section === "tag" ? activeTagGroup.mode : draft[section].mode;
  const modeChoices =
    section === "tag"
      ? [
          { value: "any", label: "包含任一 · 或" },
          { value: "all", label: "同时包含 · 且" }
        ]
      : [
          { value: "include", label: "包含" },
          { value: "exclude", label: "排除" }
        ];
  return (
    <section
      id={`${id}-${section}`}
      data-filter-section={section}
      className={`public-filter-section public-filter-section-${section}`}
      aria-labelledby={`${id}-${section}-title`}
    >
      <div className="public-filter-section-heading">
        <h3 id={`${id}-${section}-title`}>
          <span>{String(publicFilterSections.indexOf(section) + 1).padStart(2, "0")}</span>
          {publicFilterLabels[section]} {!isFixed && <small>{options.length}</small>}
        </h3>
        {!isFixed && (
          <div className="public-filter-section-actions">
            {section === "tag" && (
              <button
                type="button"
                className="public-filter-group-button"
                disabled={
                  tagLocked ||
                  !activeTagGroup.selected.length ||
                  (tag.selection.groups.length >= publicTagGroupLimit &&
                    !tag.selection.groups.some((group) => !group.selected.length))
                }
                title="将当前标签成组，继续选择下一组"
                onClick={finishTagGroup}
              >
                成组
              </button>
            )}
            <div
              className="public-filter-mode"
              role="group"
              aria-label={`${publicFilterLabels[section]}匹配方式`}
            >
              {modeChoices.map((choice) => (
                <button
                  key={choice.value}
                  type="button"
                  aria-pressed={mode === choice.value}
                  disabled={section === "tag" ? tagLocked : Boolean(draft[section].unresolved)}
                  onClick={() => {
                    if (section === "tag")
                      updateTagGroup({ mode: choice.value === "all" ? "all" : "any" });
                    else if (section === "theme" || section === "author")
                      edit({
                        ...draft,
                        [section]: {
                          ...draft[section],
                          mode: choice.value === "exclude" ? "exclude" : "include"
                        }
                      });
                  }}
                >
                  {choice.label}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
      {!isFixed && (
        <p className="public-filter-section-description">
          {section === "tag"
            ? tag.selection.grouped
              ? "点击组条目切换编辑；点击标签加入或移出当前组，框内数字表示所属组。"
              : "“或”匹配任意一个标签，“且”同时匹配所有标签；点击“成组”继续添加另一组。"
            : mode === "exclude"
              ? `隐藏已选${publicFilterLabels[section]}的图片；不选则不限${publicFilterLabels[section]}。`
              : `可多选，显示任一已选${publicFilterLabels[section]}的图片；不选则不限${publicFilterLabels[section]}。`}
        </p>
      )}
      {section === "tag" && tag.selection.grouped && (
        <div className="public-filter-tag-groups" role="group" aria-label="标签分组">
          <p className="public-filter-group-hint">
            组间满足任一 · 或{" "}
            <span>
              正在编辑第 {tag.selection.activeId} 组 · 最多 {publicTagGroupLimit} 组
            </span>
          </p>
          {tag.selection.groups.map((group) => {
            const names = group.selected.map(
              (slug) => facets?.tags.find((option) => option.slug === slug)?.display_name || slug
            );
            const text = names.join(group.mode === "all" ? " & " : " / ") || "选择标签";
            const value = basicTagValue(group.selected, group.mode);
            const count = counts?.tag_groups?.find((entry) => entry.tag === value)?.image_count;
            const countLabel = count === undefined ? "— 张" : `${count.toLocaleString()} 张`;
            return (
              <div key={group.id} className="public-filter-tag-group">
                <button
                  type="button"
                  aria-pressed={group.id === tag.selection.activeId}
                  disabled={tagLocked}
                  aria-label={`编辑第 ${group.id} 组：${group.mode === "all" ? "同时包含" : "包含任一"}，${text}${value ? `，${countLabel}` : ""}`}
                  onClick={() => setTag({ ...tag.selection, activeId: group.id })}
                >
                  <b>{group.id}</b>
                  <small>{group.mode === "all" ? "且" : "或"}</small>
                  <OverflowMarqueeText text={text} />
                  {value && (
                    <small
                      className="public-filter-group-count"
                      title="当前设备、明暗、主题和作者条件下的本组匹配数"
                    >
                      {countLabel}
                    </small>
                  )}
                </button>
                <button
                  type="button"
                  className="public-filter-group-remove"
                  disabled={tagLocked}
                  aria-label={`删除第 ${group.id} 组`}
                  onClick={() => deleteTagGroup(group.id)}
                >
                  <Icon name="close-line" />
                </button>
              </div>
            );
          })}
        </div>
      )}
      {!isFixed && !facets ? (
        <p className="public-filter-muted">
          {facetsLoading ? "正在读取目录…" : "目录暂不可用，可先调整其他条件。"}
        </p>
      ) : section === "tag" && !totals.data ? (
        <div className="public-filter-notice" role="status">
          {totals.isError ? (
            <>
              标签目录暂时无法读取。
              <button
                type="button"
                onClick={() => {
                  void totals.refetch();
                }}
              >
                重新读取
              </button>
            </>
          ) : (
            "正在读取标签目录…"
          )}
        </div>
      ) : !options.length ? (
        <p className="public-filter-muted">暂无{publicFilterLabels[section]}选项</p>
      ) : (
        <div
          className={`public-filter-options ${isFixed ? "is-segmented" : section === "tag" ? "is-tags" : ""}`}
        >
          {options.map((option) => {
            const checked = selected.includes(option.slug);
            const memberships =
              section === "tag" && tag.selection.grouped
                ? tag.selection.groups.filter((group) => group.selected.includes(option.slug))
                : [];
            const count = optionCount(counts, section, option.slug);
            const { disabled: unavailable, locked } = publicFilterOptionState({
              selected: checked,
              count,
              unverified: availabilityUnverified,
              unrestricted: isFixed && option.slug === ""
            });
            const name = option.display_name || option.slug;
            if (isFixed)
              return (
                <button
                  key={option.slug}
                  data-filter-option={option.slug}
                  type="button"
                  className="public-filter-segment"
                  aria-pressed={checked}
                  disabled={unavailable}
                  aria-disabled={locked || unavailable || undefined}
                  title={count === undefined ? name : `${name}：${count.toLocaleString()} 张`}
                  onClick={() => {
                    if (!locked) toggle(section, option.slug);
                  }}
                >
                  {name}
                </button>
              );
            const displayMatch = normalizedQuery ? matchName(name, normalizedQuery) : null;
            const slugMatch = normalizedQuery ? matchFacetText(option.slug, normalizedQuery) : null;
            return (
              <button
                key={option.slug}
                data-filter-option={option.slug}
                type="button"
                aria-pressed={checked}
                className={`public-filter-option${checked && mode === "exclude" ? " is-excluded" : ""}`}
                aria-label={
                  section === "tag" && tag.selection.grouped
                    ? `${name}；${memberships.length ? `属于第 ${memberships.map((group) => group.id).join("、")} 组；` : ""}${checked ? "移出" : "加入"}第 ${tag.selection.activeId} 组`
                    : undefined
                }
                disabled={unavailable || (section === "tag" && tagLocked)}
                aria-disabled={
                  locked || unavailable || (section === "tag" && tagLocked) || undefined
                }
                onClick={() => {
                  if (!locked) toggle(section, option.slug);
                }}
              >
                {section !== "tag" && (
                  <span className="public-filter-option-icon">
                    <Icon name={publicFilterIcons[section]} />
                  </span>
                )}
                {section === "tag" && (
                  <span className="public-filter-tag-mark" aria-hidden="true">
                    #
                  </span>
                )}
                <span className="public-filter-option-label">
                  <OverflowMarqueeText text={name}>
                    <MatchedText text={name} match={displayMatch} />
                  </OverflowMarqueeText>
                  <OverflowMarqueeText as="small" text={option.slug}>
                    <MatchedText text={option.slug} match={slugMatch} />
                  </OverflowMarqueeText>
                </span>
                <small className="public-filter-option-count">
                  {count === undefined ? "—" : `${count.toLocaleString()} 张`}
                </small>
                {memberships.length ? (
                  <span
                    className="public-filter-group-marks"
                    aria-hidden="true"
                    style={{
                      gridTemplateColumns: `repeat(${Math.min(3, memberships.length)}, 12px)`
                    }}
                  >
                    {memberships.map((group) => (
                      <span
                        key={group.id}
                        className={group.id === tag.selection.activeId ? "is-current" : undefined}
                      >
                        {group.id}
                      </span>
                    ))}
                  </span>
                ) : (
                  <span className="public-filter-check" aria-hidden="true">
                    {checked ? (mode === "exclude" ? "−" : "✓") : ""}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}
