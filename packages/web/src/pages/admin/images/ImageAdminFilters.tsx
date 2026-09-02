import { useLayoutEffect, useRef, useState } from "react";
import {
  brightnesses as imageBrightnesses,
  devices as imageDevices,
  type IngestionVocabularyDto
} from "@imageshow/shared/browser";
import { FacetSelector } from "../../../components/data-display/FacetSelector.js";
import { AdminIcon } from "../../../components/icon/AdminIcon.js";
import { SelectMenu } from "../../../components/form/SelectMenu.js";
import {
  brightnessOptionLabel,
  deviceOptionLabel
} from "../../../lib/ui/select-options.js";
import { AnchoredMenuDismissSignalContext } from "../../../hooks/useAnchoredMenu.js";
import { useDismissiblePanel } from "../../../hooks/useDismissiblePanel.js";
import type { ImageAdminView } from "./useImageAdminOperations.js";

export type ImageAdminFilterValues = {
  device: string;
  brightness: string;
  theme: string;
  tag: string;
  author: string;
};

export const emptyImageAdminFilters: ImageAdminFilterValues = {
  device: "",
  brightness: "",
  theme: "",
  tag: "",
  author: ""
};

export const imageAdminDoubleRowMaxWidth = 947;

export function isImageAdminDoubleRowWidth(width: number) {
  return width > 0 && width <= imageAdminDoubleRowMaxWidth;
}

const singleRowFilterGroups = {
  primary: ["device", "brightness", "theme"],
  secondary: ["tag", "author"]
} as const satisfies Record<string, readonly (keyof ImageAdminFilterValues)[]>;

const doubleRowFilterGroups = {
  primary: ["device", "brightness", "author"],
  secondary: ["theme", "tag"]
} as const satisfies Record<string, readonly (keyof ImageAdminFilterValues)[]>;

export function imageAdminFilterDomGroups(doubleRowLayout: boolean) {
  return doubleRowLayout ? doubleRowFilterGroups : singleRowFilterGroups;
}

function useImageAdminDoubleRowLayout(enabled: boolean) {
  const filterBarRef = useRef<HTMLDivElement | null>(null);
  const [measuredDoubleRowLayout, setMeasuredDoubleRowLayout] = useState(false);

  useLayoutEffect(() => {
    const filterBar = filterBarRef.current;
    if (!enabled || !filterBar) return;

    const update = () => {
      const width = filterBar.getBoundingClientRect().width;
      const next = isImageAdminDoubleRowWidth(width);
      setMeasuredDoubleRowLayout((current) => current === next ? current : next);
    };
    update();

    const ownerWindow = filterBar.ownerDocument.defaultView;
    if (typeof ownerWindow?.ResizeObserver !== "function") return;
    const observer = new ownerWindow.ResizeObserver(update);
    observer.observe(filterBar);
    return () => observer.disconnect();
  }, [enabled]);

  return {
    filterBarRef,
    doubleRowLayout: enabled && measuredDoubleRowLayout
  };
}

export function ImageAdminFilters({
  value,
  vocabulary,
  view,
  mobileLayout,
  disabled,
  onChange,
  onClear
}: {
  value: ImageAdminFilterValues;
  vocabulary?: IngestionVocabularyDto;
  view: ImageAdminView;
  mobileLayout: boolean;
  disabled: boolean;
  onChange: (key: keyof ImageAdminFilterValues, value: string) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const clearFiltersRef = useRef<HTMLButtonElement | null>(null);
  const { filterBarRef, doubleRowLayout } = useImageAdminDoubleRowLayout(
    !mobileLayout
  );
  const disclosure = useDismissiblePanel({
    open,
    onOpenChange: setOpen,
    enabled: mobileLayout,
    resetKey: mobileLayout,
    auxiliarySurfaceRef: clearFiltersRef
  });
  const themeDisabled = disabled || view === "unset";
  const activeCount =
    (value.device ? 1 : 0)
    + (value.brightness ? 1 : 0)
    + (view !== "unset" && value.theme ? 1 : 0)
    + (value.tag ? 1 : 0)
    + (value.author ? 1 : 0);
  const hasFilters = Boolean(
    value.device
    || value.brightness
    || value.theme
    || value.tag
    || value.author
  );
  const clearFilters = () => {
    disclosure.dismissMenus();
    onClear();
  };
  const filterControls = {
    device: (
      <label key="device" className="image-list-filter-device">
        设备
        <SelectMenu
          value={value.device}
          onChange={(next) => onChange("device", next)}
          options={[
            { value: "", label: "全部设备" },
            ...imageDevices.map((option) => ({
              value: option,
              label: deviceOptionLabel(option)
            }))
          ]}
          disabled={disabled}
          ariaLabel="设备"
        />
      </label>
    ),
    brightness: (
      <label key="brightness" className="image-list-filter-brightness">
        亮度
        <SelectMenu
          value={value.brightness}
          onChange={(next) => onChange("brightness", next)}
          options={[
            { value: "", label: "全部亮度" },
            ...imageBrightnesses.map((option) => ({
              value: option,
              label: brightnessOptionLabel(option)
            }))
          ]}
          disabled={disabled}
          ariaLabel="亮度"
        />
      </label>
    ),
    theme: (
      <div
        key="theme"
        className="image-list-filter-field image-list-filter-theme"
      >
        <label htmlFor="admin-image-theme-facet">主题</label>
        <FacetSelector
          options={vocabulary?.themes ?? []}
          value={view === "unset" ? "" : value.theme}
          onChange={(next) => onChange("theme", next)}
          noun="主题"
          disabled={themeDisabled}
          ariaLabel="主题"
          controlId="admin-image-theme-facet"
        />
      </div>
    ),
    tag: (
      <div
        key="tag"
        className="image-list-filter-field image-list-filter-tag"
      >
        <label htmlFor="admin-image-tag-facet">标签</label>
        <FacetSelector
          options={vocabulary?.tags ?? []}
          value={value.tag}
          onChange={(next) => onChange("tag", next)}
          noun="标签"
          disabled={disabled}
          ariaLabel="标签"
          controlId="admin-image-tag-facet"
        />
      </div>
    ),
    author: (
      <div
        key="author"
        className="image-list-filter-field image-list-filter-author"
      >
        <label htmlFor="admin-image-author-facet">作者</label>
        <FacetSelector
          options={vocabulary?.authors ?? []}
          value={value.author}
          onChange={(next) => onChange("author", next)}
          noun="作者"
          disabled={disabled}
          ariaLabel="作者"
          controlId="admin-image-author-facet"
        />
      </div>
    )
  };
  const filterGroups = imageAdminFilterDomGroups(doubleRowLayout);

  return (
    <div
      ref={filterBarRef}
      className={`image-list-filter-bar${open ? " filters-open" : ""}${disclosure.motionEnabled ? " filters-motion-enabled" : ""}`}
    >
      <div className="image-list-filter-actions">
        <button
          ref={disclosure.triggerRef}
          type="button"
          className="image-list-filter-toggle pressable"
          disabled={disabled}
          aria-expanded={open}
          aria-controls="admin-image-filter-panel"
          onClick={() => open
            ? disclosure.setOpen(false, { restoreFocus: true })
            : disclosure.setOpen(true)}
        >
          <AdminIcon name="filter-3-line" />
          筛选
          {activeCount > 0 && (
            <span className="image-list-filter-count">{activeCount}</span>
          )}
          <span className="image-list-filter-chevron">
            <AdminIcon name="arrow-down-s-line" />
          </span>
        </button>
        {mobileLayout && (
          <>
            <span className="image-list-filter-action-divider" aria-hidden="true" />
            <button
              ref={clearFiltersRef}
              type="button"
              className="image-list-filter-clear image-list-filter-clear-mobile pressable"
              disabled={disabled || !hasFilters}
              onClick={clearFilters}
            >
              清空
            </button>
          </>
        )}
      </div>
      <AnchoredMenuDismissSignalContext.Provider
        key={mobileLayout ? "mobile" : "desktop"}
        value={disclosure.menuDismissSignal}
      >
        <div
          ref={disclosure.panelRef}
          id="admin-image-filter-panel"
          className="image-list-filter-panel"
          role="group"
          aria-label="图片列表筛选条件"
          aria-hidden={disclosure.panelHidden}
          inert={disclosure.panelHidden}
        >
          <div className="image-list-filter-primary">
            {filterGroups.primary.map((key) => filterControls[key])}
          </div>
          <div className="image-list-filter-secondary">
            {filterGroups.secondary.map((key) => filterControls[key])}
          </div>
          {!mobileLayout && (
            <div className="image-list-filter-action">
              <span>操作</span>
              <button
                ref={clearFiltersRef}
                type="button"
                className="image-list-filter-clear pressable"
                disabled={disabled || !hasFilters}
                onClick={clearFilters}
              >
                清空
              </button>
            </div>
          )}
        </div>
      </AnchoredMenuDismissSignalContext.Provider>
    </div>
  );
}
