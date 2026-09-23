import { useId, useMemo, useRef, useState, type RefObject } from "react";
import { detectDeviceFromUserAgent, publicTagGroupLimit, type GalleryFacetsDto, type GalleryStatsDto } from "@imageshow/shared/browser";
import { DialogFrame } from "../../feedback/DialogFrame.js";
import { OverlayScrollbar } from "../../layout/OverlayScrollbar.js";
import { PublicFilterChips } from "./PublicFilterChips.js";
import { Icon, type IconName } from "../../icon/Icon.js";
import { MatchedText } from "../../data-display/FacetSuggestionLabel.js";
import { OverflowMarqueeText } from "../../data-display/OverflowMarqueeText.js";
import { useGalleryStats } from "../../../lib/api/site-queries.js";
import { usePublicFilterScroll } from "../../../hooks/usePublicFilterScroll.js";
import { useMediaQuery } from "../../../hooks/useMediaQuery.js";
import { usePublicFilterStats } from "../../../hooks/usePublicFilterStats.js";
import { useRefreshGlint, useRefreshGlintRun } from "../../../hooks/useRefreshGlint.js";
import { publicFilterOptionState } from "../../../lib/gallery/public-filter-options.js";
import { facetSuggestions, matchFacetText, normalizeFacetSearchQuery } from "../../../lib/ui/facet-input.js";
import { useFacetSearchMatcher } from "../../../hooks/useFacetSearchMatcher.js";
import { useImeSearchInput } from "../../../hooks/useImeSearchInput.js";
import type { FacetOption } from "../../../lib/types.js";
import { galleryStatsSearch, type GalleryFilters } from "../../../lib/gallery/gallery-query.js";
import {
  createPublicFilterDraft, publicDraftFilters, publicFilterChips, publicFilterLabels, publicFilterDeviceLabels,
  publicFilterSections, resolvePublicFilterTag,
  createTagSelection,
  type PublicFilterChip, type PublicFilterDraft, type PublicFilterSection, type TagSelection
} from "../../../lib/gallery/public-filter-draft.js";
import "../../../styles/public-filter-dialog.css";

const icons: Record<PublicFilterSection, IconName> = {
  device: "slideshow-3-line", brightness: "contrast-2-line", theme: "image-line",
  tag: "hashtag", author: "user-3-line"
};
const fixedOptions = {
  device: [
    { slug: "", display_name: "不限设备" },
    { slug: "auto", display_name: publicFilterDeviceLabels.auto },
    { slug: "pc", display_name: publicFilterDeviceLabels.pc }, { slug: "mb", display_name: publicFilterDeviceLabels.mb }
  ],
  brightness: [
    { slug: "", display_name: "不限明暗" }, { slug: "light", display_name: "亮色图片" },
    { slug: "dark", display_name: "暗色图片" }
  ]
};

function filterOptions(options: readonly FacetOption[], query: string,
  section: Exclude<PublicFilterSection, "device" | "brightness">, matchName: typeof matchFacetText) {
  if (!query || publicFilterLabels[section].includes(query)) return [...options];
  return facetSuggestions(options, query, undefined, matchName, Infinity);
}

function optionCount(stats: GalleryStatsDto | undefined, section: PublicFilterSection, slug: string): number | undefined {
  if (!stats) return undefined;
  if (section === "device") {
    const device = slug === "auto" ? detectDeviceFromUserAgent(window.navigator.userAgent) : slug;
    return device ? stats.devices.find((item) => item.device === device)?.image_count
      : stats.devices.reduce((sum, item) => sum + item.image_count, 0);
  }
  if (section === "brightness") return slug
    ? stats.brightnesses.find((item) => item.brightness === slug)?.image_count
    : stats.brightnesses.reduce((sum, item) => sum + item.image_count, 0);
  return stats[section === "theme" ? "themes" : section === "tag" ? "tags" : "authors"]
    .find((item) => item.slug === slug)?.image_count;
}

export function PublicFilterDialog({
  filters, unresolvedTags, facets, facetsLoading, facetsError, retryVocabulary,
  returnFocusRef, onClose, onApply, view
}: {
  filters: GalleryFilters;
  unresolvedTags: string[];
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
  const [draft, setDraft] = useState(() => createPublicFilterDraft(filters, unresolvedTags));
  const [query, setQuery] = useState("");
  const { matchName, status: pinyinStatus } = useFacetSearchMatcher(true);
  const [selectionError, setSelectionError] = useState("");
  const [revealChip, setRevealChip] = useState<Pick<PublicFilterChip, "section" | "value"> | null>(null);
  const [closing, setClosing] = useState(false);
  const totals = useGalleryStats("", !closing);
  const tag = resolvePublicFilterTag(draft, facets);
  const activeTagGroup = tag.selection.groups.find((group) => group.id === tag.selection.activeId)!;
  const tagLocked = draft.tag.kind === "unresolved" && Boolean(tag.error);
  const chips = publicFilterChips(draft, tag.selection, facets);
  const normalizedQuery = normalizeFacetSearchQuery(query);
  const options = useMemo(() => {
    const activeTags = new Set(totals.data?.tags.filter((item) => item.image_count > 0).map((item) => item.slug));
    return {
      device: fixedOptions.device,
      brightness: fixedOptions.brightness,
      theme: filterOptions(facets?.themes ?? [], normalizedQuery, "theme", matchName),
      tag: filterOptions((facets?.tags ?? []).filter((item) => activeTags.has(item.slug)), normalizedQuery, "tag", matchName),
      author: filterOptions(facets?.authors ?? [], normalizedQuery, "author", matchName)
    };
  }, [facets, normalizedQuery, totals.data, matchName]);
  const pinyinPending = /[a-zü]/i.test(normalizedQuery) && pinyinStatus === "loading";
  const directorySections = publicFilterSections.filter((section) => !normalizedQuery || (section !== "device" && section !== "brightness"));
  const visibleSections = directorySections.filter((section) => !normalizedQuery || options[section].length
    || (section === "tag" && !totals.data));
  const { scrollRef, activeSection, goToSection, rememberPosition } = usePublicFilterScroll(
    visibleSections.map((section) => `${section}:${options[section].map((item) => item.slug).join(",")}`).join("|"),
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
  const statsSearch = nextFilters ? galleryStatsSearch(nextFilters, window.navigator.userAgent) : "";
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
      const selection = next.tag.kind === "selection" ? next.tag.selection : tag.selection;
      publicDraftFilters(next, selection);
      setSelectionError("");
      setDraft(next);
      return true;
    } catch (error) {
      setSelectionError(error instanceof Error ? error.message : "无法应用此条件");
      return false;
    }
  };
  const setTag = (selection: TagSelection) => edit({ ...draft, tag: { kind: "selection", selection } });
  const updateTagGroup = (changes: Partial<Pick<typeof activeTagGroup, "mode" | "selected">>) => setTag({
    ...tag.selection,
    groups: tag.selection.groups.map((group) => group.id === tag.selection.activeId ? { ...group, ...changes } : group)
  });
  const finishTagGroup = () => {
    if (!activeTagGroup.selected.length || tagLocked) return;
    const empty = tag.selection.groups.find((group) => !group.selected.length);
    if (empty) {
      setTag({ ...tag.selection, grouped: true, activeId: empty.id });
      return;
    }
    if (tag.selection.groups.length >= publicTagGroupLimit) return;
    const id = Array.from({ length: publicTagGroupLimit }, (_, index) => index + 1)
      .find((id) => !tag.selection.groups.some((group) => group.id === id))!;
    setTag({ groups: [...tag.selection.groups, { id, mode: activeTagGroup.mode, selected: [] }], activeId: id, grouped: true });
  };
  const deleteTagGroup = (id: number) => {
    const groups = tag.selection.groups.filter((group) => group.id !== id);
    setTag(groups.length ? { ...tag.selection, groups,
      activeId: tag.selection.activeId === id ? groups.at(-1)!.id : tag.selection.activeId } : createTagSelection());
  };
  const remove = (section: PublicFilterSection, value: string) => {
    if (section === "device" || section === "brightness") edit({ ...draft, [section]: "" });
    else if (section === "tag") setTag({ ...tag.selection, groups: tag.selection.groups.map((group) => ({
      ...group, selected: group.selected.filter((slug) => slug !== value)
    })) });
    else edit({ ...draft, [section]: { ...draft[section], selected: draft[section].selected.filter((slug) => slug !== value) } });
  };
  const toggle = (section: PublicFilterSection, slug: string) => {
    if (section === "device" || section === "brightness") {
      if (edit({ ...draft, [section]: slug }) && slug) setRevealChip({ section, value: slug });
      return;
    }
    const selection = section === "tag" ? activeTagGroup : draft[section];
    const selected = selection.selected.includes(slug)
      ? selection.selected.filter((item) => item !== slug) : [...selection.selected, slug];
    const accepted = section === "tag" ? updateTagGroup({ selected })
      : edit({ ...draft, [section]: { ...draft[section], selected } });
    if (accepted && !selection.selected.includes(slug)) setRevealChip({ section, value: slug });
  };
  const reset = () => edit(createPublicFilterDraft());

  const renderSection = (section: PublicFilterSection) => {
    const isFixed = section === "device" || section === "brightness";
    const selected = isFixed ? [draft[section]] : section === "tag" ? activeTagGroup.selected : draft[section].selected;
    const mode = isFixed ? null : section === "tag" ? activeTagGroup.mode : draft[section].mode;
    const modeChoices = section === "tag"
      ? [{ value: "any", label: "包含任一 · 或" }, { value: "all", label: "同时包含 · 且" }]
      : [{ value: "include", label: "包含" }, { value: "exclude", label: "排除" }];
    return <section key={section} id={`${id}-${section}`} data-filter-section={section}
      className={`public-filter-section public-filter-section-${section}`} aria-labelledby={`${id}-${section}-title`}>
      <div className="public-filter-section-heading"><h3 id={`${id}-${section}-title`}>
        <span>{String(publicFilterSections.indexOf(section) + 1).padStart(2, "0")}</span>
        {publicFilterLabels[section]} {!isFixed && <small>{options[section].length}</small>}</h3>
        {!isFixed && <div className="public-filter-section-actions">
          {section === "tag" && <button type="button" className="public-filter-group-button"
            disabled={tagLocked || !activeTagGroup.selected.length || (tag.selection.groups.length >= publicTagGroupLimit
              && !tag.selection.groups.some((group) => !group.selected.length))}
            title="将当前标签成组，继续选择下一组" onClick={finishTagGroup}>成组</button>}
          <div className="public-filter-mode" role="group" aria-label={`${publicFilterLabels[section]}匹配方式`}>
          {modeChoices.map((choice) => <button key={choice.value} type="button" aria-pressed={mode === choice.value}
            disabled={section === "tag" && draft.tag.kind === "unresolved" && Boolean(tag.error)}
            onClick={() => {
              if (section === "tag") updateTagGroup({ mode: choice.value === "all" ? "all" : "any" });
              else if (section === "theme" || section === "author") edit({ ...draft, [section]: {
                ...draft[section], mode: choice.value === "exclude" ? "exclude" : "include"
              } });
            }}>{choice.label}</button>)}
        </div></div>}
      </div>
      {!isFixed && <p className="public-filter-section-description">{section === "tag"
        ? tag.selection.grouped
          ? "点击组条目切换编辑；点击标签加入或移出当前组，框内数字表示所属组。"
          : "“或”匹配任意一个标签，“且”同时匹配所有标签；点击“成组”继续添加另一组。"
        : mode === "exclude"
          ? `隐藏已选${publicFilterLabels[section]}的图片；不选则不限${publicFilterLabels[section]}。`
          : `可多选，显示任一已选${publicFilterLabels[section]}的图片；不选则不限${publicFilterLabels[section]}。`}</p>}
      {section === "tag" && tag.selection.grouped && <div className="public-filter-tag-groups" role="group" aria-label="标签分组">
        <p className="public-filter-group-hint">组间满足任一 · 或 <span>正在编辑第 {tag.selection.activeId} 组 · 最多 {publicTagGroupLimit} 组</span></p>
        {tag.selection.groups.map((group) => {
          const names = group.selected.map((slug) => facets?.tags.find((option) => option.slug === slug)?.display_name || slug);
          const text = names.join(group.mode === "all" ? " & " : " / ") || "选择标签";
          return <div key={group.id} className="public-filter-tag-group">
            <button type="button" aria-pressed={group.id === tag.selection.activeId} disabled={tagLocked}
              aria-label={`编辑第 ${group.id} 组：${group.mode === "all" ? "同时包含" : "包含任一"}，${text}`}
              onClick={() => setTag({ ...tag.selection, activeId: group.id })}>
              <b>{group.id}</b><small>{group.mode === "all" ? "且" : "或"}</small><span title={text}>{text}</span>
            </button>
            <button type="button" className="public-filter-group-remove" disabled={tagLocked}
              aria-label={`删除第 ${group.id} 组`} onClick={() => deleteTagGroup(group.id)}><Icon name="close-line" /></button>
          </div>;
        })}
      </div>}
      {!isFixed && !facets ? <p className="public-filter-muted">{facetsLoading ? "正在读取目录…" : "目录暂不可用，可先调整其他条件。"}</p>
        : section === "tag" && !totals.data ? <div className="public-filter-notice" role="status">
          {totals.isError ? <>标签目录暂时无法读取。<button type="button" onClick={() => { void totals.refetch(); }}>重新读取</button></>
            : "正在读取标签目录…"}
        </div>
        : !options[section].length ? <p className="public-filter-muted">暂无{publicFilterLabels[section]}选项</p>
        : <div className={`public-filter-options ${isFixed ? "is-segmented" : section === "tag" ? "is-tags" : ""}`}>
          {options[section].map((option) => {
            const checked = selected.includes(option.slug);
            const memberships = section === "tag" && tag.selection.grouped
              ? tag.selection.groups.filter((group) => group.selected.includes(option.slug)) : [];
            const count = optionCount(counts, section, option.slug);
            const { disabled: unavailable, locked } = publicFilterOptionState({
              selected: checked, count, unverified: availabilityUnverified, unrestricted: isFixed && option.slug === ""
            });
            const name = option.display_name || option.slug;
            if (isFixed) return <button key={option.slug} data-filter-option={option.slug} type="button"
              className="public-filter-segment" aria-pressed={checked}
              disabled={unavailable} aria-disabled={locked || unavailable || undefined}
              title={count === undefined ? name : `${name}：${count.toLocaleString()} 张`}
              onClick={() => { if (!locked) toggle(section, option.slug); }}>{name}</button>;
            const displayMatch = normalizedQuery ? matchName(name, normalizedQuery) : null;
            const slugMatch = normalizedQuery ? matchFacetText(option.slug, normalizedQuery) : null;
            return <button key={option.slug} data-filter-option={option.slug} type="button"
              aria-pressed={checked} className={`public-filter-option${checked && mode === "exclude" ? " is-excluded" : ""}`}
              data-group-member={memberships.length ? "" : undefined}
              aria-label={section === "tag" && tag.selection.grouped
                ? `${name}；${memberships.length ? `属于第 ${memberships.map((group) => group.id).join("、")} 组；` : ""}${checked ? "移出" : "加入"}第 ${tag.selection.activeId} 组` : undefined}
              disabled={unavailable || (section === "tag" && tagLocked)}
              aria-disabled={locked || unavailable || (section === "tag" && tagLocked) || undefined}
              onClick={() => { if (!locked) toggle(section, option.slug); }}>
              {section !== "tag" && <span className="public-filter-option-icon"><Icon name={icons[section]} /></span>}
              {section === "tag" && <span className="public-filter-tag-mark" aria-hidden="true">#</span>}
              <span className="public-filter-option-label">
                <OverflowMarqueeText text={name}><MatchedText text={name} match={displayMatch} /></OverflowMarqueeText>
                <OverflowMarqueeText as="small" text={option.slug}><MatchedText text={option.slug} match={slugMatch} /></OverflowMarqueeText>
              </span>
              <small className="public-filter-option-count">{count === undefined ? "—" : `${count.toLocaleString()} 张`}</small>
              {memberships.length ? <span className="public-filter-group-marks" aria-hidden="true"
                style={{ gridTemplateColumns: `repeat(${Math.min(3, memberships.length)}, 12px)` }}>
                {memberships.map((group) => <span key={group.id} className={group.id === tag.selection.activeId ? "is-current" : undefined}>{group.id}</span>)}
              </span> : <span className="public-filter-check" aria-hidden="true">{checked ? mode === "exclude" ? "−" : "✓" : ""}</span>}
            </button>;
          })}
        </div>}
    </section>;
  };

  return (
    <DialogFrame className="modal public-filter-dialog" colorContext="public" titleId={`${id}-title`}
      initialFocusRef={titleRef} returnFocusRef={returnFocusRef} onClose={onClose}
      prepareClose={() => { setClosing(true); return onClose; }}>
      {({ requestClose }) => (
        <article className="public-filter-sheet" onAnimationEnd={(event) => {
          if (event.target === event.currentTarget && event.animationName === "modal-pop") setSheetEntered(true);
        }} onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (event.key === "Escape" && searchInput.text) {
            event.preventDefault(); event.stopPropagation(); searchInput.reset();
          }
          const target = event.target as HTMLElement;
          if (event.key === "/" && !target.closest("input, textarea, [contenteditable='true']")) {
            event.preventDefault(); searchRef.current?.focus();
          }
        }}>
          <header className="public-filter-heading">
            <span className="public-filter-brand-icon"><Icon name="filter-3-line" /></span>
            <div className="public-filter-title"><h2 ref={titleRef} tabIndex={-1} id={`${id}-title`}>筛选图片</h2>
              <p>浏览全部选项，或搜索你想看的内容。</p></div>
            <button type="button" className="public-filter-icon-button" aria-label="取消并关闭筛选"
              onClick={() => requestClose()}><Icon name="close-line" /></button>
          </header>
          <div className="public-filter-search-area">
          <div className="public-filter-search">
            <Icon name="search-line" />
            <input ref={searchRef} type="search" {...searchInput.inputProps} aria-label="搜索筛选选项"
              placeholder="搜索主题、标签或作者…" />
            {searchInput.text ? <button type="button" className="public-filter-search-accessory" aria-label="清空搜索"
              onClick={() => { searchInput.reset(); searchRef.current?.focus(); }}><Icon name="close-line" /></button>
              : <kbd className="public-filter-search-accessory">/</kbd>}
          </div>
          </div>
          <div className="public-filter-selection">
            <span className="public-filter-selected-count">已选 <b>{chips.length}</b></span>
            <PublicFilterChips chips={chips} revealChip={revealChip} returnFocusRef={titleRef} onRemove={remove}
              emptyLabel={tag.error ? "标签条件待处理" : "尚未选择，浏览全部图片"} />
            <button type="button" className="public-filter-text-button" disabled={!chips.length && !tag.error} onClick={reset}>清空</button>
            {glint.active && (sheetEntered || reduceMotion) && <i className="public-filter-refresh" aria-hidden="true"
              onAnimationIteration={(event) => {
                if (event.animationName === "public-filter-refresh") glint.finishCycle();
              }} />}
          </div>
          <div className="public-filter-body">
            <div ref={directoryFrameRef} className="public-filter-directory-frame">
            <nav ref={directoryRef} className="public-filter-directory" aria-label="筛选目录">
              <span className="public-filter-directory-caption">筛选目录</span>
              {directorySections.map((section) => {
                const count = chips.filter((chip) => chip.section === section).length;
                return <button key={section} type="button" aria-controls={`${id}-${section}`}
                  aria-current={activeSection === section ? "location" : undefined}
                  disabled={!visibleSections.includes(section)} onClick={() => goToSection(section)}>
                  <Icon name={icons[section]} /><span><strong>{publicFilterLabels[section]}</strong>
                    <small>{normalizedQuery ? `${options[section].length} 项匹配` : count ? `已选 ${count} 项` : "不限"}</small></span>
                  {count > 0 && <b>{count}</b>}
                </button>;
              })}
              <p className="public-filter-directory-hint">向下滚动浏览全部</p>
            </nav>
            <OverlayScrollbar targetRef={directoryRef} containerRef={directoryFrameRef} tone="dark" enableOnTouch />
            </div>
            <div ref={scrollFrameRef} className="public-filter-scroll-frame">
            <div ref={scrollRef} className="public-filter-scroll" tabIndex={0} aria-label="筛选选项目录">
              {pinyinPending && <div className="public-filter-notice" role="status">正在加载拼音搜索…</div>}
              {pinyinStatus === "error" && <div className="public-filter-notice" role="status">
                拼音搜索加载失败，仍可按名称或 slug 搜索。
                <button type="button" title="刷新会清除尚未应用的筛选条件" onClick={() => window.location.reload()}>刷新页面重试</button>
              </div>}
              {Boolean(facetsError) && <div className="public-filter-notice" role="status">
                {facets ? "目录更新失败，暂时显示已加载的选项。" : "主题、标签和作者目录暂时无法读取。"}
                <button type="button" onClick={retryVocabulary}>重新读取</button>
              </div>}
              {tag.error && <div className="public-filter-notice is-error" role="alert">
                <strong>标签条件需要处理</strong><p>{tag.error}</p>
                {draft.tag.kind === "unresolved" && <code>{draft.tag.values.join(" · ")}</code>}
                <div><button type="button" onClick={retryVocabulary}>重新读取词表</button>
                  <button type="button" onClick={() => setTag(createTagSelection())}>清除标签条件</button></div>
              </div>}
              {draftError && !tag.error && <p className="public-filter-notice is-error" role="alert">{draftError}</p>}
              {!normalizedQuery && <div className="public-filter-fixed-group">
                {renderSection("device")}
                {renderSection("brightness")}
              </div>}
              {normalizedQuery && !pinyinPending && facets && totals.data && !options.theme.length && !options.tag.length && !options.author.length &&
                <div className="public-filter-empty"><strong>没有匹配的主题、标签或作者</strong>
                  <p>试试其他名称或清空搜索。</p><button type="button" onClick={() => searchInput.reset()}>清空搜索</button></div>}
              {visibleSections.filter((section) => section !== "device" && section !== "brightness").map(renderSection)}
            </div>
            <OverlayScrollbar targetRef={scrollRef} containerRef={scrollFrameRef} tone="dark" enableOnTouch />
            </div>
          </div>
          <footer className="public-filter-footer">
            <div className="public-filter-result" aria-live="polite">
              <div className="public-filter-result-status">
              {selectionError ? <span title={selectionError}>{selectionError}</span>
                : draftError ? <span>请先处理筛选条件</span>
                : matchingCount === undefined ? <span>{matching.isError ? "暂无法统计" : "匹配数量更新中…"}</span>
                : <span>匹配 <strong>{matchingCount.toLocaleString()}</strong> 张</span>}
                {!draftError && matching.isError && <button type="button" onClick={() => { void matching.refetch(); }}>重试</button>}
              </div>
              <small>{!draftError && matching.isError ? "统计更新失败，已有数量仅供参考"
                : `应用后更新${view === "show" ? "展映" : "画廊"}`}</small>
            </div>
            <button type="button" className="public-filter-cancel" onClick={() => requestClose()}>取消</button>
            <button type="button" className="public-filter-apply" disabled={Boolean(draftError) || closing}
              onClick={() => {
                if (applyingRef.current || draftError) return;
                applyingRef.current = true;
                setClosing(true);
                const snapshot = publicDraftFilters(draft, tag.selection);
                requestClose(() => onApply(snapshot));
              }}>{view === "show" ? "应用到展映" : "查看图片"}<Icon name="arrow-right-line" /></button>
          </footer>
        </article>
      )}
    </DialogFrame>
  );
}
