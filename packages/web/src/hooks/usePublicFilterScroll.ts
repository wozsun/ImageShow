import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { PublicFilterSectionKey } from "../lib/gallery/public-filter-draft.js";

export function usePublicFilterScroll(sectionKey: string, searching: boolean) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [activeSection, setActiveSection] = useState<PublicFilterSectionKey | null>("device");
  const savedPosition = useRef<{ section: string; option?: string; offset: number } | null>(null);
  const wasSearching = useRef(searching);
  const preferredSection = useRef<PublicFilterSectionKey>("device");
  const sectionScrollFrame = useRef<number | null>(null);
  const sectionScrollTarget = useRef<number | null>(null);
  const cancelSectionScroll = useCallback(() => {
    if (sectionScrollFrame.current !== null)
      window.cancelAnimationFrame(sectionScrollFrame.current);
    sectionScrollFrame.current = null;
    sectionScrollTarget.current = null;
  }, []);
  const sections = () =>
    Array.from(scrollRef.current?.querySelectorAll<HTMLElement>("[data-filter-section]") ?? []);

  const rememberPosition = () => {
    const root = scrollRef.current;
    if (!root) return;
    const top = root.getBoundingClientRect().top;
    const section = sections().find((item) => item.getBoundingClientRect().bottom > top + 24);
    if (!section) return;
    const option = Array.from(section.querySelectorAll<HTMLElement>("[data-filter-option]")).find(
      (item) => item.getBoundingClientRect().bottom > top + 24
    );
    savedPosition.current = {
      section: section.dataset.filterSection!,
      option: option?.dataset.filterOption,
      offset: (option ?? section).getBoundingClientRect().top - top
    };
  };

  useLayoutEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    cancelSectionScroll();
    if (!searching && wasSearching.current && savedPosition.current) {
      const saved = savedPosition.current;
      const section = sections().find((item) => item.dataset.filterSection === saved.section);
      const option = Array.from(
        section?.querySelectorAll<HTMLElement>("[data-filter-option]") ?? []
      ).find((item) => item.dataset.filterOption === saved.option);
      const target = option ?? section;
      if (target)
        root.scrollTop +=
          target.getBoundingClientRect().top - root.getBoundingClientRect().top - saved.offset;
      savedPosition.current = null;
    } else if (searching && !wasSearching.current) root.scrollTop = 0;
    wasSearching.current = searching;

    let frame: number | undefined;
    const measure = () => {
      frame = undefined;
      // Directory clicks own the highlight throughout movement and at the destination,
      // including destinations clamped by the bottom of the scrollable content.
      if (sectionScrollFrame.current !== null) return;
      if (
        sectionScrollTarget.current !== null &&
        Math.abs(root.scrollTop - sectionScrollTarget.current) < 1
      )
        return;
      sectionScrollTarget.current = null;
      const items = sections();
      const top = root.getBoundingClientRect().top + 36;
      const atBottom =
        root.scrollHeight > root.clientHeight + 2 &&
        root.scrollTop + root.clientHeight >= root.scrollHeight - 3;
      const anchor = atBottom
        ? items.at(-1)
        : (items.filter((item) => item.getBoundingClientRect().top <= top).at(-1) ?? items[0]);
      // Side-by-side sections share a scroll position but keep independent directory entries.
      const row = anchor
        ? items.filter(
            (item) =>
              Math.abs(item.getBoundingClientRect().top - anchor.getBoundingClientRect().top) < 1
          )
        : [];
      const active =
        row.find((item) => item.dataset.filterSection === preferredSection.current) ?? row[0];
      const next = active?.dataset.filterSection as PublicFilterSectionKey | undefined;
      setActiveSection((current) => (current === (next ?? null) ? current : (next ?? null)));
    };
    const schedule = () => {
      if (frame === undefined) frame = window.requestAnimationFrame(measure);
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(root);
    sections().forEach((section) => observer.observe(section));
    root.addEventListener("scroll", schedule, { passive: true });
    const interactionRoot = root.parentElement ?? root;
    const manualEvents = ["wheel", "touchstart", "pointerdown", "keydown"] as const;
    for (const event of manualEvents)
      interactionRoot.addEventListener(event, cancelSectionScroll, { passive: true });
    measure();
    return () => {
      observer.disconnect();
      root.removeEventListener("scroll", schedule);
      for (const event of manualEvents)
        interactionRoot.removeEventListener(event, cancelSectionScroll);
      cancelSectionScroll();
      if (frame !== undefined) window.cancelAnimationFrame(frame);
    };
  }, [sectionKey, searching, cancelSectionScroll]);

  const goToSection = useCallback(
    (section: PublicFilterSectionKey) => {
      const root = scrollRef.current;
      const target = root?.querySelector<HTMLElement>(`[data-filter-section="${section}"]`);
      if (!root || !target) return;
      cancelSectionScroll();
      preferredSection.current = section;
      setActiveSection(section);
      const from = root.scrollTop;
      const to = Math.max(
        0,
        Math.min(
          root.scrollHeight - root.clientHeight,
          from + target.getBoundingClientRect().top - root.getBoundingClientRect().top - 24
        )
      );
      sectionScrollTarget.current = to;
      if (
        Math.abs(to - from) < 1 ||
        window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ) {
        root.scrollTop = to;
        return;
      }
      const startedAt = window.performance.now();
      const step = (now: number) => {
        const progress = Math.max(0, Math.min(1, (now - startedAt) / 160));
        root.scrollTop = from + (to - from) * (1 - (1 - progress) ** 3);
        sectionScrollFrame.current = progress < 1 ? window.requestAnimationFrame(step) : null;
      };
      sectionScrollFrame.current = window.requestAnimationFrame(step);
    },
    [cancelSectionScroll]
  );
  return { scrollRef, activeSection, goToSection, rememberPosition };
}
