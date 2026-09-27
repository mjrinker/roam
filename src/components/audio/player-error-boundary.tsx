"use client";

import { Component, type ReactNode } from "react";

/**
 * Keeps a crash in the player UI from taking anything else down. React error
 * boundaries only catch errors from their children, so wrapping the bar here
 * means a rendering bug in it renders nothing instead of unmounting the audio
 * provider above it (which would stop the audio).
 */
export class PlayerErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error("Player UI crashed:", error);
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}
