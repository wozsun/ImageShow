import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent
} from "react";
import { vocabularyDisplayNameMaxLength } from "@imageshow/shared/browser";
import { useAnchoredMenu } from "../../hooks/useAnchoredMenu.js";
import { useImeInputSession } from "../../hooks/useImeInputSession.js";
import { Icon } from "../icon/Icon.js";
import {
  facetSuggestions,
  normalizeFacetSearchQuery,
  parseFacetSlug
} from "../../lib/ui/facet-input.js";
import { facetDisplayName } from "../../lib/ui/formatters.js";
import {
  classifyMovementIntent,
  type ClientPoint
} from "../../lib/ui/movement-intent.js";
import type { FacetOption } from "../../lib/types.js";
import { DirectActivationButton } from "../feedback/DirectActivationButton.js";
import {
  handleSuggestionNavigationKey,
  SuggestionList,
  suggestionMenuSize
} from "./SuggestionList.js";
import {
  tagScrollAvailability,
  tagScrollContentMetrics,
  tagScrollItemMetrics,
  tagScrollNavigationTarget,
  tagVerticalWheelPixels,
  tagWheelScrollTarget,
  type TagScrollAvailability
} from "./tag-input-scroll.js";

const noTagScroll: TagScrollAvailability = {
  backward: false,
  forward: false
};

type TouchEditorFocusCandidate = {
  identifier: number;
  origin: ClientPoint;
};

function isTagEditorSurface(target: EventTarget | null) {
  return !(
    target instanceof Element
    && target.closest("button, input")
  );
}

function touchWithIdentifier(touches: TouchList, identifier: number) {
  for (let index = 0; index < touches.length; index += 1) {
    const touch = touches[index];
    if (touch?.identifier === identifier) return touch;
  }
  return null;
}

export function TagInput({ value, onChange, suggestions, disabled = false, ariaLabel, className, placeholder = "添加标签" }: {
  value: string[];
  onChange: (value: string[]) => void;
  suggestions: FacetOption[];
  disabled?: boolean;
  ariaLabel?: string;
  className?: string;
  placeholder?: string;
}) {
  const [text, setText] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);
  const [scrollAvailability, setScrollAvailability] = useState(noTagScroll);
  const scrollAvailabilityRef = useRef(noTagScroll);
  const imeSession = useImeInputSession(text);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const backwardNavigationRef = useRef<HTMLButtonElement | null>(null);
  const forwardNavigationRef = useRef<HTMLButtonElement | null>(null);
  const touchEditorFocusCandidateRef = useRef<
    TouchEditorFocusCandidate | null
  >(null);
  const choiceSettledCompositionRef = useRef(false);
  const previousDisabledRef = useRef(disabled);
  const previousEditingStateRef = useRef({
    text,
    valueLength: value.length
  });
  const listId = useId();
  const inputId = `${listId}-input`;
  const {
    open,
    closing,
    position,
    opensUp,
    menuRef,
    openMenu,
    requestClose,
    cancelClose,
    onAnimationEnd
  } = useAnchoredMenu({
    triggerRef: wrapRef,
    getSize: () => suggestionMenuSize,
    initialMaxHeight: 260,
    disabled,
    onClose: () => setActiveIndex(-1)
  });

  const refreshScrollAvailability = useCallback(() => {
    const box = scrollRef.current;
    if (!box) return;
    const next = tagScrollAvailability(box);
    const current = scrollAvailabilityRef.current;
    const unchanged = (
      current.backward === next.backward
      && current.forward === next.forward
    );
    const activeElement = box.ownerDocument.activeElement;
    const focusedNavigation = activeElement === backwardNavigationRef.current
      ? backwardNavigationRef.current
      : activeElement === forwardNavigationRef.current
        ? forwardNavigationRef.current
        : null;
    const disablingFocusedNavigation = (
      focusedNavigation !== null
      && (
        (
          focusedNavigation === backwardNavigationRef.current
          && !next.backward
        )
        || (
          focusedNavigation === forwardNavigationRef.current
          && !next.forward
        )
      )
    );
    if (disablingFocusedNavigation) {
      // The editor uses readOnly + aria-disabled for the composite disabled
      // state, so it remains a stable programmatic focus target without
      // accepting edits or participating in sequential keyboard navigation.
      inputRef.current?.focus({ preventScroll: true });
    }
    if (unchanged) return;
    if (backwardNavigationRef.current) {
      backwardNavigationRef.current.disabled = !next.backward;
    }
    if (forwardNavigationRef.current) {
      forwardNavigationRef.current.disabled = !next.forward;
    }
    scrollAvailabilityRef.current = next;
    setScrollAvailability(next);
  }, []);

  const revealEditor = useCallback(() => {
    if (disabled) return;
    const input = inputRef.current;
    const box = scrollRef.current;
    input?.focus({ preventScroll: true });
    if (!box) return;
    const target = Math.max(0, box.scrollWidth - box.clientWidth);
    if (Math.abs(target - box.scrollLeft) < 1) return;
    box.scrollLeft = target;
    refreshScrollAvailability();
  }, [disabled, refreshScrollAvailability]);

  // This local lifecycle owns only tap-to-editor promotion on non-interactive
  // chip and viewport surfaces. It never selects an axis or moves the viewport;
  // dialog scrolling and direct button activation retain those consequences.
  useEffect(() => {
    const control = wrapRef.current;
    if (!control) return;

    const onTouchStart = (event: TouchEvent) => {
      touchEditorFocusCandidateRef.current = null;
      if (
        disabled
        || event.touches.length !== 1
        || !isTagEditorSurface(event.target)
      ) {
        return;
      }
      const touch = event.changedTouches[0] ?? event.touches[0];
      if (!touch) return;
      touchEditorFocusCandidateRef.current = {
        identifier: touch.identifier,
        origin: {
          clientX: touch.clientX,
          clientY: touch.clientY
        }
      };
    };
    const onTouchMove = (event: TouchEvent) => {
      const candidate = touchEditorFocusCandidateRef.current;
      if (!candidate) return;
      const touch = touchWithIdentifier(event.touches, candidate.identifier);
      if (
        !touch
        || classifyMovementIntent(candidate.origin, touch)
      ) touchEditorFocusCandidateRef.current = null;
    };
    const onTouchEnd = (event: TouchEvent) => {
      const candidate = touchEditorFocusCandidateRef.current;
      if (!candidate) return;
      touchEditorFocusCandidateRef.current = null;
      const touch = touchWithIdentifier(
        event.changedTouches,
        candidate.identifier
      );
      if (
        !touch
        || classifyMovementIntent(candidate.origin, touch)
      ) return;

      // Prevent the compatibility focus/click in the same native touch
      // transaction. Otherwise focusing and revealing the editor can move
      // the tapped chip before hit-testing, so mobile browsers focus an
      // ancestor outside a transient panel before dispatching click.
      if (event.cancelable) event.preventDefault();
      revealEditor();
    };
    const onTouchCancel = () => {
      touchEditorFocusCandidateRef.current = null;
    };

    control.addEventListener("touchstart", onTouchStart, { passive: true });
    control.addEventListener("touchmove", onTouchMove, { passive: true });
    control.addEventListener("touchend", onTouchEnd, { passive: false });
    control.addEventListener("touchcancel", onTouchCancel, { passive: true });
    return () => {
      control.removeEventListener("touchstart", onTouchStart);
      control.removeEventListener("touchmove", onTouchMove);
      control.removeEventListener("touchend", onTouchEnd);
      control.removeEventListener("touchcancel", onTouchCancel);
    };
  }, [disabled, revealEditor]);

  useLayoutEffect(() => {
    const wasDisabled = previousDisabledRef.current;
    previousDisabledRef.current = disabled;
    if (disabled) {
      choiceSettledCompositionRef.current = false;
      imeSession.settleEditing(text);
      const input = inputRef.current;
      const control = wrapRef.current;
      const activeElement = input?.ownerDocument.activeElement;
      if (
        input
        && control
        && activeElement
        && control.contains(activeElement)
        && activeElement.matches(".tag-chip-remove")
      ) input.focus({ preventScroll: true });
      return;
    }
    const input = inputRef.current;
    if (
      wasDisabled
      && input
      && input === input.ownerDocument.activeElement
    ) {
      choiceSettledCompositionRef.current = false;
      imeSession.beginEditing();
    }
  }, [disabled]);

  useLayoutEffect(() => {
    const box = scrollRef.current;
    if (!box) return;
    const previous = previousEditingStateRef.current;
    if (
      value.length > previous.valueLength
      || (
        text !== previous.text
        && inputRef.current === box.ownerDocument.activeElement
      )
    ) box.scrollLeft = box.scrollWidth;
    previousEditingStateRef.current = {
      text,
      valueLength: value.length
    };
    refreshScrollAvailability();
  }, [disabled, refreshScrollAvailability, suggestions, text, value]);

  useEffect(() => {
    const control = wrapRef.current;
    const box = scrollRef.current;
    if (!control || !box) return;
    const ownerWindow = box.ownerDocument.defaultView;
    const onWheel = (event: WheelEvent) => {
      const finePointer = ownerWindow?.matchMedia?.("(any-pointer: fine)")
        .matches ?? true;
      if (!finePointer) return;
      const delta = tagVerticalWheelPixels({
        clientWidth: box.clientWidth,
        deltaMode: event.deltaMode,
        deltaX: event.deltaX,
        deltaY: event.deltaY
      });
      if (delta === null) return;
      if (event.cancelable) event.preventDefault();
      const target = tagWheelScrollTarget(box, delta);
      if (Math.abs(target - box.scrollLeft) < 1) return;
      box.scrollLeft = target;
      refreshScrollAvailability();
    };
    control.addEventListener("wheel", onWheel, { passive: false });
    const resizeObserver = typeof ownerWindow?.ResizeObserver === "function"
      ? new ownerWindow.ResizeObserver(refreshScrollAvailability)
      : null;
    resizeObserver?.observe(box);
    refreshScrollAvailability();
    return () => {
      control.removeEventListener("wheel", onWheel);
      resizeObserver?.disconnect();
    };
  }, [refreshScrollAvailability]);

  const query = normalizeFacetSearchQuery(text);
  const selected = new Set(value);

  const knownSlugs = new Set(suggestions.map((option) => option.slug));
  const matches = facetSuggestions(suggestions, query, selected);
  const suggestionOpen = open && matches.length > 0;

  const updateQuery = (nextText: string) => {
    setText(nextText);
    setActiveIndex(-1);
    if (!normalizeFacetSearchQuery(nextText)) {
      if (open) requestClose();
      return;
    }
    if (closing) cancelClose();
    if (!open) openMenu();
  };

  const addTag = (raw: string) => {
    const tag = parseFacetSlug(raw);
    if (
      tag === null
      || selected.has(tag)
    ) return false;
    onChange([...value, tag]);
    setText("");
    setActiveIndex(-1);
    if (open) requestClose();
    return true;
  };
  const chooseTag = (slug: string) => {
    const compositionActive = imeSession.isComposing();
    if (!addTag(slug) || !compositionActive) return;

    // Suggestion presses normally preserve focus so several tags can be
    // chosen quickly. During an active composition we instead end this focus
    // session: WebKit may still dispatch the old compositionend/input pair,
    // which the settled IME guard must reject rather than restore the query.
    choiceSettledCompositionRef.current = true;
    imeSession.settleEditing("");
    inputRef.current?.blur();
  };
  const removeTag = (tag: string) => {
    if (disabled) return;
    inputRef.current?.focus({ preventScroll: true });
    onChange(value.filter((item) => item !== tag));
  };
  const scrollTags = (direction: -1 | 1) => {
    const box = scrollRef.current;
    if (!box) return false;
    const boxRect = box.getBoundingClientRect();
    const style = box.ownerDocument.defaultView?.getComputedStyle(box);
    const paddingLeft = Number.parseFloat(style?.paddingLeft ?? "0") || 0;
    const paddingRight = Number.parseFloat(style?.paddingRight ?? "0") || 0;
    const navigationMetrics = tagScrollContentMetrics(
      box,
      paddingLeft,
      paddingRight
    );
    const contentLeft = boxRect.left + paddingLeft;
    const contentRight = boxRect.right - paddingRight;
    const backwardRect = backwardNavigationRef.current
      ?.getBoundingClientRect();
    const forwardRect = forwardNavigationRef.current
      ?.getBoundingClientRect();
    const nextScrollLeft = tagScrollNavigationTarget(
      navigationMetrics,
      [...box.querySelectorAll<HTMLElement>("[data-tag-scroll-item]")]
        .map((item) => {
          const itemRect = item.getBoundingClientRect();
          return tagScrollItemMetrics(
            boxRect.left,
            box.scrollLeft,
            itemRect,
            paddingLeft
          );
        }),
      direction,
      {
        // The whole overlaid button counts as covered, including its
        // translucent gradient edge. Reading the real overlap keeps scroll
        // behavior aligned with the control if its CSS geometry changes.
        leading: backwardRect
          ? Math.max(0, backwardRect.right - contentLeft)
          : 0,
        trailing: forwardRect
          ? Math.max(0, contentRight - forwardRect.left)
          : 0
      }
    );
    if (Math.abs(nextScrollLeft - box.scrollLeft) < 1) return false;
    box.scrollLeft = nextScrollLeft;
    refreshScrollAvailability();
    return true;
  };

  const handleKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (
      imeSession.isComposing(event.nativeEvent.isComposing)
      || event.keyCode === 229
    ) return;

    if (handleSuggestionNavigationKey(event, {
      open: suggestionOpen,
      matchCount: matches.length,
      setActiveIndex,
      openMenu: () => {
        if (matches.length) openMenu();
      },
      requestClose
    })) return;

    if (event.key === "Enter") {
      event.preventDefault();
      if (open && activeIndex >= 0 && matches[activeIndex]) addTag(matches[activeIndex].slug);
      else if (text.trim()) addTag(text);
    } else if (
      event.key === "ArrowLeft"
      && event.currentTarget.selectionStart === 0
      && event.currentTarget.selectionEnd === 0
      && scrollTags(-1)
    ) {
      event.preventDefault();
    } else if (
      event.key === "ArrowRight"
      && event.currentTarget.selectionStart === text.length
      && event.currentTarget.selectionEnd === text.length
      && scrollTags(1)
    ) {
      event.preventDefault();
    } else if (event.key === "Backspace" && !text && value.length) {
      removeTag(value[value.length - 1]);
    }
  };

  const menu = (
    <SuggestionList
      open={suggestionOpen}
      matches={matches}
      activeIndex={activeIndex}
      ariaLabel={ariaLabel}
      listId={listId}
      closing={closing}
      opensUp={opensUp}
      position={position}
      popupRef={menuRef}
      onAnimationEnd={onAnimationEnd}
      onActiveIndexChange={setActiveIndex}
      onChoose={chooseTag}
    />
  );

  const settleEditing = () => {
    if (!choiceSettledCompositionRef.current) {
      addTag(inputRef.current?.value ?? text);
    }
    choiceSettledCompositionRef.current = false;
    setText("");
    setActiveIndex(-1);
    imeSession.settleEditing("");
    if (open) requestClose();
  };

  return (
    <div
      className={`tag-input-control ${className ?? ""}`.trim()}
      ref={wrapRef}
      data-tag-input-disabled={disabled ? "" : undefined}
      onPointerDown={(event) => {
        if (disabled || event.pointerType === "touch") return;
        if (
          event.button !== 0
          || event.isPrimary === false
          || !isTagEditorSurface(event.target)
        ) return;
        event.preventDefault();
        inputRef.current?.focus({ preventScroll: true });
      }}
      onClick={(event) => {
        if (disabled || !isTagEditorSurface(event.target)) return;
        event.preventDefault();
        // Retain mouse, keyboard-generated and non-Touch-Event fallbacks.
        revealEditor();
      }}
      onBlur={(event) => {
        const nextTarget = event.relatedTarget;
        const staysInControl = (
          nextTarget instanceof Node
          && event.currentTarget.contains(nextTarget)
        );
        if (staysInControl || disabled) return;
        settleEditing();
      }}
    >
      <DirectActivationButton
        ref={backwardNavigationRef}
        type="button"
        className="tag-input-nav is-backward"
        data-tag-scroll-navigation=""
        disabled={!scrollAvailability.backward}
        aria-label={`${ariaLabel ?? "标签"}，显示前一个被遮挡标签`}
        pointerFocus="preserve"
        onActivate={() => scrollTags(-1)}
      >
        <Icon name="arrow-down-s-line" />
      </DirectActivationButton>
      <div
        ref={scrollRef}
        className="tag-input-scroll-window"
        data-dialog-horizontal-scroll-owner=""
        onScroll={refreshScrollAvailability}
      >
        {value.map((tag) => {
          const isNew = !knownSlugs.has(tag);
          return (
            <span
              key={tag}
              className={`tag-chip${isNew ? " is-new" : ""}`}
              data-tag-scroll-item=""
              title={isNew ? `「${tag}」是新标签，提交后会自动创建` : undefined}
            >
              {facetDisplayName(suggestions, tag)}
              <DirectActivationButton
                type="button"
                className="tag-chip-remove"
                aria-label={`移除标签 ${facetDisplayName(suggestions, tag)}`}
                aria-disabled={disabled || undefined}
                tabIndex={disabled ? -1 : undefined}
                pointerFocus="preserve"
                onActivate={() => removeTag(tag)}
              >
                <Icon name="close-line" />
              </DirectActivationButton>
            </span>
          );
        })}
        <input
          ref={inputRef}
          id={inputId}
          className="tag-input-field"
          data-tag-scroll-item=""
          value={text}
          maxLength={vocabularyDisplayNameMaxLength}
          onFocus={() => {
            if (disabled) return;
            choiceSettledCompositionRef.current = false;
            imeSession.beginEditing();
          }}
          onChange={(event) => {
            if (!imeSession.acceptInput(event.currentTarget) || disabled) return;
            const raw = event.currentTarget.value;
            if (imeSession.isComposing(
              (event.nativeEvent as InputEvent).isComposing
            )) {
              setText(raw);
              return;
            }
            updateQuery(raw);
          }}
          onCompositionStart={() => {
            if (disabled) return;
            imeSession.beginComposition();
          }}
          onCompositionEnd={(event) => {
            const accepted = imeSession.endComposition(event.currentTarget);
            if (disabled || !accepted) return;
            updateQuery(event.currentTarget.value);
          }}
          onKeyDown={disabled ? undefined : handleKey}
          placeholder={value.length ? "" : placeholder}
          readOnly={disabled}
          tabIndex={disabled ? -1 : undefined}
          aria-disabled={disabled || undefined}
          aria-label={ariaLabel}
          role="combobox"
          aria-expanded={suggestionOpen && !closing}
          aria-controls={suggestionOpen ? listId : undefined}
          aria-autocomplete="list"
          autoComplete="off"
        />
      </div>
      <DirectActivationButton
        ref={forwardNavigationRef}
        type="button"
        className="tag-input-nav is-forward"
        data-tag-scroll-navigation=""
        disabled={!scrollAvailability.forward}
        aria-label={`${ariaLabel ?? "标签"}，显示后一个被遮挡标签`}
        pointerFocus="preserve"
        onActivate={() => scrollTags(1)}
      >
        <Icon name="arrow-down-s-line" />
      </DirectActivationButton>
      {menu}
    </div>
  );
}
