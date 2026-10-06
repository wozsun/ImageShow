import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode
} from "react";
import { createPortal } from "react-dom";
import { ActionFeedback } from "./ActionFeedback.js";
import type { ActionFeedbackState } from "../../lib/ui/action-feedback.js";

const actionFeedbackTargetBrand = Symbol("ActionFeedbackTarget");

export type ActionFeedbackTarget = {
  readonly [actionFeedbackTargetBrand]: true;
  readonly label: string;
};

type ActionFeedbackRegionRegistry = {
  hosts: ReadonlyMap<ActionFeedbackTarget, HTMLElement>;
  register: (target: ActionFeedbackTarget, host: HTMLElement | null) => void;
};

const ActionFeedbackRegionContext = createContext<ActionFeedbackRegionRegistry | null>(null);

function createActionFeedbackTarget(label = "action-feedback"): ActionFeedbackTarget {
  return Object.freeze({
    [actionFeedbackTargetBrand]: true as const,
    label
  });
}

export function useActionFeedbackTarget(label?: string) {
  const [target] = useState(() => createActionFeedbackTarget(label));
  return target;
}

export function ActionFeedbackProvider({ children }: { children: ReactNode }) {
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

  const registry = useMemo<ActionFeedbackRegionRegistry>(
    () => ({
      hosts,
      register
    }),
    [hosts, register]
  );

  return (
    <ActionFeedbackRegionContext value={registry}>
      {children}
    </ActionFeedbackRegionContext>
  );
}

function useActionFeedbackRegistry() {
  const registry = useContext(ActionFeedbackRegionContext);
  if (!registry) {
    throw new Error("ActionFeedback components must be rendered inside ActionFeedbackProvider");
  }
  return registry;
}

/** 页面反馈区，放在页头副标题所在的网格区域，消息出现时临时替换副标题。 */
export function ActionFeedbackRegion({
  target,
  className = ""
}: {
  target: ActionFeedbackTarget;
  className?: string;
}) {
  const { register } = useActionFeedbackRegistry();
  const bindHost = useCallback(
    (host: HTMLDivElement | null) => {
      register(target, host);
    },
    [register, target]
  );
  const classes = ["action-feedback-region", className].filter(Boolean).join(" ");
  return <div ref={bindHost} className={classes} data-feedback-region={target.label} />;
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
  const { hosts } = useActionFeedbackRegistry();
  const host = hosts.get(target);
  if (!host) return null;

  return createPortal(
    <ActionFeedback feedback={feedback} onClose={onClose} />,
    host,
    feedback.id
  );
}
