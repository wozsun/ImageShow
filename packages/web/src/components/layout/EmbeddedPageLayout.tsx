import { Component, type ReactNode } from "react";
import { Outlet } from "react-router";
import type { AnalyticsBridge } from "@imageshow/shared/browser";
import { trackAnalytics } from "../../lib/analytics/analytics.js";
import { useEmbeddedCursorBridge } from "./useEmbeddedCursorBridge.js";
import { useEmbeddedSafeArea } from "./useEmbeddedSafeArea.js";
import "../../styles/embed-cursor.css";

/** Wraps embedded pages; the routes render it only while embedding is enabled. */
export function EmbeddedPageLayout() {
  return (
    <>
      <HostBridgeBoundary bridge="cursor">
        <CursorBridge />
      </HostBridgeBoundary>
      <HostBridgeBoundary bridge="safe_area">
        <SafeAreaBridge />
      </HostBridgeBoundary>
      <Outlet />
    </>
  );
}

function CursorBridge() {
  useEmbeddedCursorBridge();
  return null;
}

function SafeAreaBridge() {
  useEmbeddedSafeArea();
  return null;
}

/**
 * The host protocols are optional: a bridge that fails stops alone and the
 * page keeps running without it.
 */
class HostBridgeBoundary extends Component<
  { bridge: AnalyticsBridge; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error("[ImageShow] 嵌入协议已停用", error);
    trackAnalytics({ event: "bridge_failed", bridge: this.props.bridge });
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}
