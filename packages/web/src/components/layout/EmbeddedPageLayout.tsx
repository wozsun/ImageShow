import { Component, type ReactNode } from "react";
import { Outlet } from "react-router";
import { useEmbeddedCursorBridge } from "./useEmbeddedCursorBridge.js";
import { useEmbeddedSafeArea } from "./useEmbeddedSafeArea.js";
import "../../styles/embed-cursor.css";

/** Wraps embedded pages; the routes render it only while embedding is enabled. */
export function EmbeddedPageLayout() {
  return (
    <>
      <HostBridgeBoundary>
        <CursorBridge />
      </HostBridgeBoundary>
      <HostBridgeBoundary>
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
class HostBridgeBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error("[ImageShow] 嵌入协议已停用", error);
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}
