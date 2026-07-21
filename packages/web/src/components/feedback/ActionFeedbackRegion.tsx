import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode
} from "react";
import { createPortal } from "react-dom";
import {
  ActionFeedback,
  type ActionFeedbackState
} from "./ActionFeedback.js";

const actionFeedbackTargetBrand = Symbol("ActionFeedbackTarget");

export type ActionFeedbackTarget = {
  readonly [actionFeedbackTargetBrand]: true;
  readonly label: string;
};

export type ActionFeedbackRegionVariant = "page" | "card";

type ActionFeedbackRegionRegistry = {
  fallbackHost: HTMLElement | null;
  hosts: ReadonlyMap<ActionFeedbackTarget, HTMLElement>;
  register: (target: ActionFeedbackTarget, host: HTMLElement | null) => void;
};

const ActionFeedbackRegionContext = createContext<ActionFeedbackRegionRegistry | null>(null);

function createActionFeedbackTarget(
  label = "action-feedback"
): ActionFeedbackTarget {
  return Object.freeze({
    [actionFeedbackTargetBrand]: true as const,
    label
  });
}

export function useActionFeedbackTarget(label?: string) {
  const [target] = useState(() => createActionFeedbackTarget(label));
  return target;
}

function resolveActionFeedbackHost(
  target: ActionFeedbackTarget,
  hosts: ReadonlyMap<ActionFeedbackTarget, HTMLElement>,
  fallbackHost: HTMLElement | null
) {
  return hosts.get(target) ?? fallbackHost;
}

export function ActionFeedbackProvider({ children }: { children: ReactNode }) {
  const [fallbackHost, setFallbackHost] = useState<HTMLElement | null>(null);
  const [hosts, setHosts] = useState<ReadonlyMap<ActionFeedbackTarget, HTMLElement>>(
    () => new Map()
  );

  const register = useCallback((target: ActionFeedbackTarget, host: HTMLElement | null) => {
    setHosts((current) => {
      const currentHost = current.get(target) ?? null;
      if (currentHost === host) return current;

      const next = new Map(current);
      if (host) next.set(target, host);
      else next.delete(target);
      return next;
    });
  }, []);

  const registry = useMemo<ActionFeedbackRegionRegistry>(() => ({
    fallbackHost,
    hosts,
    register
  }), [fallbackHost, hosts, register]);

  const fallback = typeof document === "undefined"
    ? null
    : createPortal(
      <div
        ref={setFallbackHost}
        className="action-feedback-region action-feedback-fallback-region"
        data-feedback-fallback="true"
      />,
      document.body
    );

  return (
    <ActionFeedbackRegionContext.Provider value={registry}>
      {children}
      {fallback}
    </ActionFeedbackRegionContext.Provider>
  );
}

function useActionFeedbackRegistry() {
  const registry = useContext(ActionFeedbackRegionContext);
  if (!registry) {
    throw new Error("ActionFeedback components must be rendered inside ActionFeedbackProvider");
  }
  return registry;
}

export function ActionFeedbackRegion({
  target,
  variant,
  className = ""
}: {
  target: ActionFeedbackTarget;
  variant: ActionFeedbackRegionVariant;
  className?: string;
}) {
  const { register } = useActionFeedbackRegistry();
  const bindHost = useCallback((host: HTMLDivElement | null) => {
    register(target, host);
  }, [register, target]);
  const classes = [
    "action-feedback-region",
    `is-${variant}`,
    className
  ].filter(Boolean).join(" ");
  return (
    <div
      ref={bindHost}
      className={classes}
      data-feedback-region={target.label}
    />
  );
}

export function ActionFeedbackOutlet({
  feedback,
  target,
  onClose
}: {
  feedback: ActionFeedbackState;
  target: ActionFeedbackTarget;
  onClose?: () => void;
}) {
  const { fallbackHost, hosts } = useActionFeedbackRegistry();
  const host = resolveActionFeedbackHost(target, hosts, fallbackHost);
  if (!host) return null;

  return createPortal(
    <ActionFeedback feedback={feedback} onClose={onClose} />,
    host,
    feedback.id
  );
}
