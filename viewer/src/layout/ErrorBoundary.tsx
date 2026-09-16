import { Component, type ErrorInfo, type ReactNode } from "react";
import { toError } from "@/lib/errors";

/**
 * Route-level error boundary (component-inventory §1 Shell): any render error
 * inside the outlet is caught and shown as an EmptyState error variant with a
 * retry action instead of blanking the whole app.
 */
export interface ErrorBoundaryProps {
  children: ReactNode;
  /** Renders the fallback; keeps the boundary reusable in tests. */
  fallback?: (error: Error, reset: () => void) => ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { error: toError(error) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    // Console only — L1 has no telemetry sink; never swallow silently.
    console.error("Route render error:", error, info.componentStack);
  }

  private reset = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    const { error } = this.state;
    if (error) {
      if (this.props.fallback) return this.props.fallback(error, this.reset);
      return this.props.children; // No fallback provided: keep previous tree visible.
    }
    return this.props.children;
  }
}
