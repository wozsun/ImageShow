import { useLayoutEffect, useRef, type RefObject } from "react";
import { DirectActivationButton } from "../../feedback/DirectActivationButton.js";
import { useTagScroll } from "../../form/useTagScroll.js";
import { Icon } from "../../icon/Icon.js";
import {
  publicFilterLabels,
  type PublicFilterChip
} from "../../../lib/gallery/public-filter-draft.js";
import "../../../styles/tag-scroll.css";

export function PublicFilterChips({
  chips,
  revealChip,
  emptyLabel,
  returnFocusRef,
  onRemove
}: {
  chips: PublicFilterChip[];
  revealChip: Pick<PublicFilterChip, "section" | "value" | "groupId"> | null;
  emptyLabel: string;
  returnFocusRef: RefObject<HTMLElement | null>;
  onRemove: (chip: PublicFilterChip) => void;
}) {
  const {
    wrapRef,
    scrollRef,
    backwardNavigationRef,
    forwardNavigationRef,
    scrollAvailability,
    refreshScrollAvailability,
    cancelPendingScroll,
    scrollTags
  } = useTagScroll(returnFocusRef);
  const revealedChipRef = useRef(revealChip);

  useLayoutEffect(() => {
    cancelPendingScroll();
    if (revealChip && revealChip !== revealedChipRef.current) {
      const box = scrollRef.current;
      const index = chips.findIndex(
        (chip) =>
          chip.section === revealChip.section &&
          (revealChip.groupId !== undefined
            ? chip.groupId === revealChip.groupId
            : chip.groupId === undefined && chip.value === revealChip.value)
      );
      const item = box?.children.item(index);
      if (box && item instanceof HTMLElement) {
        const boxRect = box.getBoundingClientRect();
        const itemRect = item.getBoundingClientRect();
        const style = box.ownerDocument.defaultView?.getComputedStyle(box);
        const leading = Number.parseFloat(style?.paddingLeft ?? "0") || 0;
        const trailing = Number.parseFloat(style?.paddingRight ?? "0") || 0;
        const left = itemRect.left - boxRect.left + box.scrollLeft;
        const right = left + itemRect.width;
        const availableWidth = box.clientWidth - leading - trailing;
        let target = box.scrollLeft;
        if (itemRect.width > availableWidth) {
          target =
            revealChip.groupId === undefined ? left - leading : right + trailing - box.clientWidth;
        } else if (left < box.scrollLeft + leading) {
          target = left - leading;
        } else if (right > box.scrollLeft + box.clientWidth - trailing) {
          target = right + trailing - box.clientWidth;
        }
        box.scrollLeft = Math.max(0, Math.min(box.scrollWidth - box.clientWidth, target));
      }
    }
    revealedChipRef.current = revealChip;
    refreshScrollAvailability();
  }, [chips, revealChip, scrollRef, cancelPendingScroll, refreshScrollAvailability]);

  return (
    <div ref={wrapRef} className="public-filter-chip-control">
      <DirectActivationButton
        ref={backwardNavigationRef}
        type="button"
        className="public-filter-chip-nav is-backward"
        data-tag-scroll-navigation=""
        disabled={!scrollAvailability.backward}
        aria-label="显示前一个被遮挡的已选条件"
        pointerFocus="preserve"
        onActivate={() => scrollTags(-1)}
      >
        <Icon name="arrow-down-s-line" />
      </DirectActivationButton>
      <div
        ref={scrollRef}
        className="public-filter-chips tag-input-scroll-window"
        data-scroll-backward={scrollAvailability.backward}
        data-scroll-forward={scrollAvailability.forward}
        data-dialog-horizontal-scroll-owner=""
        onScroll={refreshScrollAvailability}
      >
        {chips.map((chip) => (
          <DirectActivationButton
            key={
              chip.groupId === undefined
                ? `${chip.section}:${chip.value}`
                : `tag-group:${chip.groupId}`
            }
            type="button"
            className={chip.exclude ? "is-excluded" : undefined}
            data-tag-scroll-item=""
            aria-label={`移除${chip.groupId === undefined ? "" : `第 ${chip.groupId} 组`}${publicFilterLabels[chip.section]}条件：${chip.exclude ? "排除" : ""}${chip.label}`}
            pointerFocus="preserve"
            onActivate={() => onRemove(chip)}
          >
            <span>
              {chip.exclude ? "排除" : publicFilterLabels[chip.section]}
              {chip.groupId !== undefined && ` ${chip.groupId}`}
            </span>{" "}
            {chip.label}
            <Icon name="close-line" />
          </DirectActivationButton>
        ))}
        {!chips.length && <span className="public-filter-muted">{emptyLabel}</span>}
      </div>
      <DirectActivationButton
        ref={forwardNavigationRef}
        type="button"
        className="public-filter-chip-nav is-forward"
        data-tag-scroll-navigation=""
        disabled={!scrollAvailability.forward}
        aria-label="显示后一个被遮挡的已选条件"
        pointerFocus="preserve"
        onActivate={() => scrollTags(1)}
      >
        <Icon name="arrow-down-s-line" />
      </DirectActivationButton>
    </div>
  );
}
