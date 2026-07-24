import { Component, type ReactNode } from "react";
import { QueryErrorState } from "./QueryErrorState.js";

type RouteLoadBoundaryProps = {
  children: ReactNode;
  fullPage?: boolean;
  resetKey?: string;
};

type RouteLoadBoundaryState = {
  error: unknown | null;
};

/**
 * Lazy route imports can outlive a deployment and then reference an expired
 * hashed chunk. Keep the surrounding shell usable and offer a full reload so
 * the browser can obtain the current HTML and asset graph.
 */
export class RouteLoadBoundary extends Component<
  RouteLoadBoundaryProps,
  RouteLoadBoundaryState
> {
  state: RouteLoadBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): RouteLoadBoundaryState {
    return { error };
  }

  componentDidUpdate(previousProps: RouteLoadBoundaryProps) {
    if (
      this.state.error
      && previousProps.resetKey !== this.props.resetKey
    ) {
      this.setState({ error: null });
    }
  }

  render() {
    if (this.state.error) {
      return (
        <QueryErrorState
          error={this.state.error}
          onRetry={() => window.location.reload()}
          fullPage={this.props.fullPage}
        />
      );
    }
    return this.props.children;
  }
}
