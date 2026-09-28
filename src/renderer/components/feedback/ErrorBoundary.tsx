import { Component, type ErrorInfo, type ReactNode } from 'react'

export interface ErrorBoundaryProps {
  children: ReactNode
  /** Default: reload the window (main reloads the same display's page). */
  onReload?: () => void
}

interface ErrorBoundaryState {
  failed: boolean
}

/**
 * The last line of defence for a desktop window: a render error anywhere below shows a small
 * glass alert with a Reload button instead of a blank desktop (the layer would otherwise hide the
 * real desktop behind an empty window). Files and layout are untouched — they live in main.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { failed: false }

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { failed: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Forwarded to main's log file by the renderer console bridge.
    console.error('renderer: the desktop crashed', error, info.componentStack)
  }

  private reload = (): void => {
    if (this.props.onReload) this.props.onReload()
    else window.location.reload()
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children
    return (
      <div className="flex h-screen items-center justify-center p-6">
        <div
          role="alert"
          className="glass flex max-w-sm flex-col items-center gap-3 p-6 text-center"
        >
          <h1 className="text-[15px] font-semibold text-text-primary">
            Taskyard hit a problem drawing your desktop
          </h1>
          <p className="text-[12px] text-text-secondary">
            Your files are safe: nothing on disk was changed. Reload to draw the desktop again.
          </p>
          <button
            type="button"
            onClick={this.reload}
            className="rounded-[10px] bg-gradient-to-r from-accent-2 to-accent-1 px-3.5 py-1.5 text-[13px] font-semibold text-black outline-none hover:brightness-110 focus-visible:ring-2 focus-visible:ring-text-primary"
          >
            Reload
          </button>
        </div>
      </div>
    )
  }
}
