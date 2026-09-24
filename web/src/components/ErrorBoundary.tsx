import React, { Component, ErrorInfo, ReactNode } from "react";
import { Icon } from "../lib/icons";

interface Props {
  children: ReactNode;
  fallback?: ReactNode | ((error: Error, reset: () => void) => ReactNode);
  title?: string;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("ErrorBoundary caught an unhandled error:", error, errorInfo);
  }

  private reset = () => {
    this.setState({ hasError: false, error: null });
  };

  public render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        if (typeof this.props.fallback === "function") {
          return this.props.fallback(this.state.error || new Error("Unknown render error"), this.reset);
        }
        return this.props.fallback;
      }

      return (
        <div className="card" style={{
          padding: "16px",
          margin: "12px 0",
          border: "1px solid var(--danger, #ef4444)",
          background: "var(--danger-tint, rgba(239, 68, 68, 0.1))",
          borderRadius: "var(--radius-card, 12px)",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", color: "var(--danger, #ef4444)", fontWeight: 600 }}>
            <Icon name="triangle-alert" size={16} />
            <span>{this.props.title || "渲染组件时发生异常"}</span>
          </div>
          <p style={{ margin: "8px 0 12px", fontSize: "12px", color: "var(--text-2, #94a3b8)", fontFamily: "var(--font-mono, monospace)" }}>
            {this.state.error?.message || "未捕获的渲染异常"}
          </p>
          <button className="btn sm ghost" onClick={this.reset} style={{ fontSize: "12px" }}>
            <Icon name="refresh-cw" size={12} /> 重试渲染
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
