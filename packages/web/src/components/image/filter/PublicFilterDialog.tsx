import { useId, useMemo, useRef, useState, type RefObject } from "react";
import { publicTagGroupLimit, type GalleryFacetsDto } from "@imageshow/shared/browser";
import { DialogFrame } from "../../feedback/DialogFrame.js";
import { OverlayScrollbar } from "../../layout/OverlayScrollbar.js";
import { PublicFilterSection, publicFilterIcons } from "./PublicFilterSection.js";
import { PublicFilterChips } from "./PublicFilterChips.js";
import { Icon } from "../../icon/Icon.js";
import { useGalleryStats } from "../../../lib/api/site-queries.js";
import { usePublicFilterScroll } from "../../../hooks/usePublicFilterScroll.js";
import { useMediaQuery } from "../../../hooks/useMediaQuery.js";
import { usePublicFilterStats } from "../../../hooks/usePublicFilterStats.js";
import { useRefreshGlint, useRefreshGlintRun } from "../../../hooks/useRefreshGlint.js";
import {
  facetSuggestions,
  matchFacetText,
  normalizeFacetSearchQuery
} from "../../../lib/ui/facet-input.js";
import { useFacetSearchMatcher } from "../../../hooks/useFacetSearchMatcher.js";
import { useImeSearchInput } from "../../../hooks/useImeSearchInput.js";
import type { FacetOption } from "../../../lib/types.js";
import { galleryStatsSearch, type GalleryFilters } from "../../../lib/gallery/gallery-query.js";
import type { GallerySelectorField } from "../../../lib/gallery/gallery-selectors.js";
import {
  createPublicFilterDraft,
  publicDraftFilters,
  publicFilterChips,
  groupPublicFilterChips,
  publicFilterLabels,
  publicFilterDeviceLabels,
  publicFilterSections,
  resolvePublicFilterTag,
  createTagSelection,
  validatePublicFilterEdit,
  type PublicFilterChip,
  type PublicFilterDraft,
  type PublicFilterSectionKey,
  type TagSelection
} from "../../../lib/gallery/public-filter-draft.js";
import "../../../styles/public-filter-dialog.css";

const fixedOptions = {
  device: [
    { slug: "", display_name: "不限设备" },
    { slug: "auto", display_name: publicFilterDeviceLabels.auto },
    { slug: "pc", display_name: publicFilterDeviceLabels.pc },
    { slug: "mb", display_name: publicFilterDeviceLabels.mb }
  ],
  brightness: [
    { slug: "", display_name: "不限明暗" },
    { slug: "light", display_name: "亮色图片" },
    { slug: "dark", display_name: "暗色图片" }
  ]
};

function filterOptions(
  options: readonly FacetOption[],
  query: string,
  section: Exclude<PublicFilterSectionKey, "device" | "brightness">,
  matchName: typeof matchFacetText
) {
  if (!query || publicFilterLabels[section].includes(query)) return [...options];
  return facetSuggestions(options, query, undefined, matchName, Infinity);
}

export function PublicFilterDialog({
  filters,
  unresolvedTags,
  unresolvedSelectors,
  facets,
  facetsLoading,
  facetsError,
  retryVocabulary,
  returnFocusRef,
  onClose,
  onApply,
  view
}: {
  filters: GalleryFilters;
  unresolvedTags: string[];
  unresolvedSelectors?: Partial<Record<GallerySelectorField, string[]>>;
  facets: GalleryFacetsDto | undefined;
  facetsLoading: boolean;
  facetsError: unknown;
  retryVocabulary: () => void;
  returnFocusRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  onApply: (filters: GalleryFilters) => void;
  view: "gallery" | "show";
}) {
  const id = useId();
  const titleRef = useRef<HTMLHeadingElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const directoryRef = useRef<HTMLElement | null>(null);
  const directoryFrameRef = useRef<HTMLDivElement | null>(null);
  const scrollFrameRef = useRef<HTMLDivElement | null>(null);
  const applyingRef = useRef(false);
  const [draft, setDraft] = useState(() =>
    createPublicFilterDraft(filters, unresolvedTags, unresolvedSelectors)
  );
  const [query, setQuery] = useState("");
  const { matchName, status: pinyinStatus } = useFacetSearchMatcher(true);
  const [selectionError, setSelectionError] = useState("");
  const [revealChip, setRevealChip] = useState<Pick<
    PublicFilterChip,
    "section" | "value" | "groupId"
  > | null>(null);
  const [closing, setClosing] = useState(false);
  const totals = useGalleryStats("", !closing);
  const tag = resolvePublicFilterTag(draft, facets);
  const activeTagGroup = tag.selection.groups.find((group) => group.id === tag.selection.activeId)!;
  const tagLocked = draft.tag.kind === "unresolved" && Boolean(tag.error);
  const chips = publicFilterChips(draft, tag.selection, facets);
  const normalizedQuery = normalizeFacetSearchQuery(query);
  const options = useMemo(() => {
    const activeTags = new Set(
      totals.data?.tags.filter((item) => item.image_count > 0).map((item) => item.slug)
    );
    return {
      device: fixedOptions.device,
      brightness: fixedOptions.brightness,
      theme: filterOptions(facets?.themes ?? [], normalizedQuery, "theme", matchName),
      tag: filterOptions(
        (facets?.tags ?? []).filter((item) => activeTags.has(item.slug)),
        normalizedQuery,
        "tag",
        matchName
      ),
      author: filterOptions(facets?.authors ?? [], normalizedQuery, "author", matchName)
    };
  }, [facets, normalizedQuery, totals.data, matchName]);
  const pinyinPending = /[a-zü]/i.test(normalizedQuery) && pinyinStatus === "loading";
  const directorySections = publicFilterSections.filter(
    (section) => !normalizedQuery || (section !== "device" && section !== "brightness")
  );
  const visibleSections = directorySections.filter(
    (section) => !normalizedQuery || options[section].length
      || (section === "tag" && !totals.data)
  );
  const { scrollRef, activeSection, goToSection, rememberPosition } = usePublicFilterScroll(
    visibleSections
      .map((section) => `${section}:${options[section].map((item) => item.slug).join(",")}`)
      .join("|"),
    Boolean(normalizedQuery)
  );
  const searchInput = useImeSearchInput(query, (value) => {
    if (!normalizedQuery && normalizeFacetSearchQuery(value)) rememberPosition();
    setQuery(value);
  });

  let nextFilters: GalleryFilters | null = null;
  let draftError = tag.error;
  try {
    nextFilters = publicDraftFilters(draft, tag.selection);
  } catch (error) {
    draftError = error instanceof Error ? error.message : "筛选条件无法识别";
  }
  const selectedTagGroups = tag.selection.groups.filter((group) => group.selected.length);
  const tagScope =
    activeTagGroup.mode === "all" && activeTagGroup.selected.length
      ? selectedTagGroups.findIndex((group) => group.id === activeTagGroup.id) + 1
      : null;
  const statsSearch = nextFilters
    ? galleryStatsSearch(nextFilters, window.navigator.userAgent, tagScope)
    : "";
  const matching = usePublicFilterStats(statsSearch, !closing && !draftError);
  const previewUpdating = !draftError && matching.isUpdating;
  const counts = draftError ? undefined : matching.displayData;
  const matchingCount = counts?.matching_images;
  const availabilityUnverified = matching.availabilityUnverified || Boolean(draftError);
  const reduceMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const [sheetEntered, setSheetEntered] = useState(false);
  const refreshGlintRun = useRefreshGlintRun(previewUpdating);
  const glint = useRefreshGlint(refreshGlintRun, previewUpdating, reduceMotion);

  const edit = (next: PublicFilterDraft) => {
    if (applyingRef.current) return false;
    try {
      validatePublicFilterEdit(next, tag.selection);
    } catch (error) {
      setSelectionError(error instanceof Error ? error.message : "无法应用此条件");
      return false;
    }
    setSelectionError("");
    setDraft(next);
    return true;
  };
  const setTag = (selection: TagSelection) =>
    edit({ ...draft, tag: { kind: "selection", selection } });
  const updateTagGroup = (changes: Partial<Pick<typeof activeTagGroup, "mode" | "selected">>) =>
    setTag({
      ...tag.selection,
      groups: tag.selection.groups.map((group) =>
        group.id === tag.selection.activeId ? { ...group, ...changes } : group
      )
    });
  const finishTagGroup = () => {
    if (!activeTagGroup.selected.length || tagLocked) return;
    const empty = tag.selection.groups.find((group) => !group.selected.length);
    if (!empty && tag.selection.groups.length >= publicTagGroupLimit) return;
    const id =
      empty?.id ??
      Array.from({ length: publicTagGroupLimit }, (_, index) => index + 1).find(
        (id) => !tag.selection.groups.some((group) => group.id === id)
      )!;
    const groups = empty
      ? tag.selection.groups
      : [...tag.selection.groups, { id, mode: activeTagGroup.mode, selected: [] }];
    if (setTag({ groups, activeId: id, grouped: true })) {
      setRevealChip({ section: "tag", value: "", groupId: activeTagGroup.id });
    }
  };
  const deleteTagGroup = (id: number) => {
    const groups = tag.selection.groups.filter((group) => group.id !== id);
    setTag(
      groups.length
        ? {
            ...tag.selection,
            groups,
            activeId: tag.selection.activeId === id ? groups.at(-1)!.id : tag.selection.activeId
          }
        : createTagSelection()
    );
  };
  const remove = ({ section, value, groupId }: PublicFilterChip) => {
    if (groupId !== undefined) {
      deleteTagGroup(groupId);
      return;
    }
    if (section === "device" || section === "brightness") edit({ ...draft, [section]: "" });
    else if (section === "tag")
      setTag({
        ...tag.selection,
        groups: tag.selection.groups.map((group) => ({
          ...group,
          selected: group.selected.filter((slug) => slug !== value)
        }))
      });
    else
      edit({
        ...draft,
        [section]: {
          ...draft[section],
          selected: draft[section].selected.filter((slug) => slug !== value)
        }
      });
  };
  const toggle = (section: PublicFilterSectionKey, slug: string) => {
    if (section === "device" || section === "brightness") {
      if (edit({ ...draft, [section]: slug }) && slug) setRevealChip({ section, value: slug });
      return;
    }
    const selection = section === "tag" ? activeTagGroup : draft[section];
    const selected = selection.selected.includes(slug)
      ? selection.selected.filter((item) => item !== slug)
      : [...selection.selected, slug];
    const accepted =
      section === "tag"
        ? updateTagGroup({ selected })
        : edit({ ...draft, [section]: { ...draft[section], selected } });
    if (accepted && !selection.selected.includes(slug))
      setRevealChip({
        section,
        value: slug,
        ...(section === "tag" && tag.selection.grouped ? { groupId: activeTagGroup.id } : {})
      });
  };
  const reset = () => edit(createPublicFilterDraft());

  const renderSection = (section: PublicFilterSectionKey) => (
    <PublicFilterSection
      key={section}
      section={section}
      id={id}
      draft={draft}
      tag={tag}
      tagLocked={tagLocked}
      options={options[section]}
      facets={facets}
      facetsLoading={facetsLoading}
      totals={totals}
      counts={counts}
      availabilityUnverified={availabilityUnverified}
      normalizedQuery={normalizedQuery}
      matchName={matchName}
      edit={edit}
      setTag={setTag}
      updateTagGroup={updateTagGroup}
      finishTagGroup={finishTagGroup}
      deleteTagGroup={deleteTagGroup}
      toggle={toggle}
    />
  );

  return (
    <DialogFrame
      className="modal public-filter-dialog"
      colorContext="public"
      titleId={`${id}-title`}
      initialFocusRef={titleRef}
      returnFocusRef={returnFocusRef}
      onClose={onClose}
      prepareClose={() => {
        setClosing(true);
        return onClose;
      }}
    >
      {({ requestClose }) => (
        <article
          className="public-filter-sheet"
          onAnimationEnd={(event) => {
            if (event.target === event.currentTarget && event.animationName === "modal-pop")
              setSheetEntered(true);
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (event.key === "Escape" && searchInput.text) {
              event.preventDefault();
              event.stopPropagation();
              searchInput.reset();
            }
            const target = event.target as HTMLElement;
            if (event.key === "/" && !target.closest("input, textarea, [contenteditable='true']")) {
              event.preventDefault();
              searchRef.current?.focus();
            }
          }}
        >
          <header className="public-filter-heading">
            <span className="public-filter-brand-icon">
              <Icon name="filter-3-line" />
            </span>
            <div className="public-filter-title">
              <h2 ref={titleRef} tabIndex={-1} id={`${id}-title`}>
                筛选图片
              </h2>
              <p>浏览全部选项，或搜索你想看的内容。</p>
            </div>
            <button
              type="button"
              className="public-filter-icon-button"
              aria-label="取消并关闭筛选"
              onClick={() => requestClose()}
            >
              <Icon name="close-line" />
            </button>
          </header>
          <div className="public-filter-search-area">
            <div className="public-filter-search">
              <Icon name="search-line" />
              <input
                ref={searchRef}
                type="search"
                {...searchInput.inputProps}
                aria-label="搜索筛选选项"
                placeholder="搜索主题、标签或作者…"
              />
              {searchInput.text ? (
                <button
                  type="button"
                  className="public-filter-search-accessory"
                  aria-label="清空搜索"
                  onClick={() => {
                    searchInput.reset();
                    searchRef.current?.focus();
                  }}
                >
                  <Icon name="close-line" />
                </button>
              ) : (
                <kbd className="public-filter-search-accessory">/</kbd>
              )}
            </div>
          </div>
          <div className="public-filter-selection">
            <span className="public-filter-selected-count">
              已选 <b>{chips.length}</b>
            </span>
            <PublicFilterChips
              chips={groupPublicFilterChips(chips, tag.selection)}
              revealChip={revealChip}
              returnFocusRef={titleRef}
              onRemove={remove}
              emptyLabel={draftError ? "筛选条件待处理" : "尚未选择，浏览全部图片"}
            />
            <button
              type="button"
              className="public-filter-text-button"
              disabled={!chips.length && !draftError}
              onClick={reset}
            >
              清空
            </button>
            {glint.active && (sheetEntered || reduceMotion) && (
              <i
                className="public-filter-refresh"
                aria-hidden="true"
                onAnimationIteration={(event) => {
                  if (event.animationName === "public-filter-refresh") glint.finishCycle();
                }}
              />
            )}
          </div>
          <div className="public-filter-body">
            <div ref={directoryFrameRef} className="public-filter-directory-frame">
              <nav ref={directoryRef} className="public-filter-directory" aria-label="筛选目录">
                <span className="public-filter-directory-caption">筛选目录</span>
                {directorySections.map((section) => {
                  const count = chips.filter((chip) => chip.section === section).length;
                  return (
                    <button
                      key={section}
                      type="button"
                      aria-controls={`${id}-${section}`}
                      aria-current={activeSection === section ? "location" : undefined}
                      disabled={!visibleSections.includes(section)}
                      onClick={() => goToSection(section)}
                    >
                      <Icon name={publicFilterIcons[section]} />
                      <span>
                        <strong>{publicFilterLabels[section]}</strong>
                        <small>
                          {normalizedQuery
                            ? `${options[section].length} 项匹配`
                            : count
                              ? `已选 ${count} 项`
                              : "不限"}
                        </small>
                      </span>
                      {count > 0 && <b>{count}</b>}
                    </button>
                  );
                })}
                <p className="public-filter-directory-hint">向下滚动浏览全部</p>
              </nav>
              <OverlayScrollbar
                targetRef={directoryRef}
                containerRef={directoryFrameRef}
                tone="dark"
                enableOnTouch
              />
            </div>
            <div ref={scrollFrameRef} className="public-filter-scroll-frame">
              <div
                ref={scrollRef}
                className="public-filter-scroll"
                tabIndex={0}
                aria-label="筛选选项目录"
              >
                {pinyinPending && (
                  <div className="public-filter-notice" role="status">
                    正在加载拼音搜索…
                  </div>
                )}
                {pinyinStatus === "error" && (
                  <div className="public-filter-notice" role="status">
                    拼音搜索加载失败，仍可按名称或 slug 搜索。
                    <button
                      type="button"
                      title="刷新会清除尚未应用的筛选条件"
                      onClick={() => window.location.reload()}
                    >
                      刷新页面重试
                    </button>
                  </div>
                )}
                {Boolean(facetsError) && (
                  <div className="public-filter-notice" role="status">
                    {facets
                      ? "目录更新失败，暂时显示已加载的选项。"
                      : "主题、标签和作者目录暂时无法读取。"}
                    <button type="button" onClick={retryVocabulary}>
                      重新读取
                    </button>
                  </div>
                )}
                {tag.error && (
                  <div className="public-filter-notice is-error" role="alert">
                    <strong>标签条件需要处理</strong>
                    <p>{tag.error}</p>
                    {draft.tag.kind === "unresolved" && <code>{draft.tag.values.join(" · ")}</code>}
                    <div>
                      <button type="button" onClick={retryVocabulary}>
                        重新读取词表
                      </button>
                      <button type="button" onClick={() => setTag(createTagSelection())}>
                        清除标签条件
                      </button>
                    </div>
                  </div>
                )}
                {(["theme", "author"] as const)
                  .filter((field) => draft[field].unresolved)
                  .map((field) => (
                    <div key={field} className="public-filter-notice is-error" role="alert">
                      <strong>{publicFilterLabels[field]}条件需要处理</strong>
                      <p>原有链接条件无效，请清除后重新选择。</p>
                      <code>{draft[field].unresolved!.join(" · ")}</code>
                      <div>
                        <button
                          type="button"
                          onClick={() =>
                            edit({ ...draft, [field]: { mode: "include", selected: [] } })
                          }
                        >
                          清除{publicFilterLabels[field]}条件
                        </button>
                      </div>
                    </div>
                  ))}
                {draftError &&
                  !tag.error &&
                  !draft.theme.unresolved &&
                  !draft.author.unresolved && (
                    <p className="public-filter-notice is-error" role="alert">
                      {draftError}
                    </p>
                  )}
                {!normalizedQuery && (
                  <div className="public-filter-fixed-group">
                    {renderSection("device")}
                    {renderSection("brightness")}
                  </div>
                )}
                {normalizedQuery &&
                  !pinyinPending &&
                  facets &&
                  totals.data &&
                  !options.theme.length &&
                  !options.tag.length &&
                  !options.author.length && (
                    <div className="public-filter-empty">
                      <strong>没有匹配的主题、标签或作者</strong>
                      <p>试试其他名称或清空搜索。</p>
                      <button type="button" onClick={() => searchInput.reset()}>
                        清空搜索
                      </button>
                    </div>
                  )}
                {visibleSections
                  .filter((section) => section !== "device" && section !== "brightness")
                  .map(renderSection)}
              </div>
              <OverlayScrollbar
                targetRef={scrollRef}
                containerRef={scrollFrameRef}
                tone="dark"
                enableOnTouch
              />
            </div>
          </div>
          <footer className="public-filter-footer">
            <div className="public-filter-result" aria-live="polite">
              <div className="public-filter-result-status">
                {selectionError ? (
                  <span title={selectionError}>{selectionError}</span>
                ) : draftError ? (
                  <span>请先处理筛选条件</span>
                ) : matchingCount === undefined ? (
                  <span>{matching.isError ? "暂无法统计" : "匹配数量更新中…"}</span>
                ) : (
                  <span>
                    匹配 <strong>{matchingCount.toLocaleString()}</strong> 张
                  </span>
                )}
                {!draftError && matching.isError && (
                  <button
                    type="button"
                    onClick={() => {
                      void matching.refetch();
                    }}
                  >
                    重试
                  </button>
                )}
              </div>
              <small>
                {!draftError && matching.isError
                  ? "统计更新失败，已有数量仅供参考"
                  : `应用后更新${view === "show" ? "展映" : "画廊"}`}
              </small>
            </div>
            <button type="button" className="public-filter-cancel" onClick={() => requestClose()}>
              取消
            </button>
            <button
              type="button"
              className="public-filter-apply"
              disabled={Boolean(draftError) || closing}
              onClick={() => {
                if (applyingRef.current || draftError) return;
                applyingRef.current = true;
                setClosing(true);
                const snapshot = publicDraftFilters(draft, tag.selection);
                requestClose(() => onApply(snapshot));
              }}
            >
              {view === "show" ? "应用到展映" : "查看图片"}
              <Icon name="arrow-right-line" />
            </button>
          </footer>
        </article>
      )}
    </DialogFrame>
  );
}
