import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  brightnesses as imageBrightnesses,
  devices as imageDevices,
  type IngestionVocabularyDto
} from "@imageshow/shared/browser";
import { FacetSelector } from "./FacetSelector.js";
import { AdminIcon } from "../../../components/icon/AdminIcon.js";
import { SelectMenu } from "../../../components/form/SelectMenu.js";
import {
  brightnessOptionLabel,
  deviceOptionLabel
} from "../../../lib/ui/select-options.js";
import { AnchoredMenuDismissSignalContext } from "../../../hooks/useAnchoredMenu.js";
import { useDismissiblePanel } from "../../../hooks/useDismissiblePanel.js";

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

const imageAdminDoubleRowMaxWidth = 947;

function isImageAdminDoubleRowWidth(width: number) {
  return width > 0 && width <= imageAdminDoubleRowMaxWidth;
}

// 各排布的 DOM 顺序与视觉顺序一致，键盘焦点按看到的顺序移动。
const singleRowFilterGroups = {
  primary: ["device", "brightness", "theme"],
  secondary: ["tag", "author"]
} as const satisfies Record<string, readonly (keyof ImageAdminFilterValues)[]>;

const doubleRowFilterGroups = {
  primary: ["device", "brightness", "author"],
  secondary: ["theme", "tag"]
} as const satisfies Record<string, readonly (keyof ImageAdminFilterValues)[]>;

// 窄屏面板两列：多选的标签独占最后一行。
const mobileFilterGroups = {
  primary: ["device", "brightness", "theme"],
  secondary: ["author", "tag"]
} as const satisfies Record<string, readonly (keyof ImageAdminFilterValues)[]>;

function imageAdminFilterDomGroups(mobileLayout: boolean, doubleRowLayout: boolean) {
  if (mobileLayout) return mobileFilterGroups;
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
      setMeasuredDoubleRowLayout((current) => (current === next ? current : next));
    };
    update();

    const observer = new ResizeObserver(update);
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
  mobileLayout,
  disabled,
  onChange,
  onClear,
  leadingControls
}: {
  value: ImageAdminFilterValues;
  vocabulary?: IngestionVocabularyDto;
  mobileLayout: boolean;
  disabled: boolean;
  onChange: (key: keyof ImageAdminFilterValues, value: string) => void;
  onClear: () => void;
  leadingControls?: (doubleRow: boolean) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const clearFiltersRef = useRef<HTMLButtonElement | null>(null);
  const { filterBarRef, doubleRowLayout } = useImageAdminDoubleRowLayout(!mobileLayout);
  const disclosure = useDismissiblePanel({
    open,
    onOpenChange: setOpen,
    enabled: mobileLayout,
    resetKey: mobileLayout,
    auxiliarySurfaceRef: clearFiltersRef
  });
  const activeCount =
    (value.device ? 1 : 0) +
    (value.brightness ? 1 : 0) +
    (value.theme ? 1 : 0) +
    (value.tag ? 1 : 0) +
    (value.author ? 1 : 0);
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
      <div key="device" className="image-list-filter-field image-list-filter-device">
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
      </div>
    ),
    brightness: (
      <div key="brightness" className="image-list-filter-field image-list-filter-brightness">
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
      </div>
    ),
    theme: (
      <div key="theme" className="image-list-filter-field image-list-filter-theme">
        <FacetSelector
          options={vocabulary?.themes ?? []}
          value={value.theme}
          onChange={(next) => onChange("theme", next)}
          noun="主题"
          disabled={disabled}
          ariaLabel="主题"
          controlId="admin-image-theme-facet"
        />
      </div>
    ),
    tag: (
      <div key="tag" className="image-list-filter-field image-list-filter-tag">
        <FacetSelector
          selectionMode="any-all"
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
      <div key="author" className="image-list-filter-field image-list-filter-author">
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
  const filterGroups = imageAdminFilterDomGroups(mobileLayout, doubleRowLayout);

  return (
    <>
      {leadingControls?.(mobileLayout || doubleRowLayout)}
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
            onClick={() =>
              open
                ? disclosure.setOpen(false, { restoreFocus: true })
                : disclosure.setOpen(true)
            }
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
        <AnchoredMenuDismissSignalContext
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
        </AnchoredMenuDismissSignalContext>
      </div>
    </>
  );
}
