import { Component, type ErrorInfo, type ReactNode } from 'react'

type Props = { children: ReactNode }
type State = { hasError: boolean }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false }

  static getDerivedStateFromError(_error: Error): State {
    return { hasError: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('notesci render error', error, info.componentStack)
  }

  handleReload = () => {
    this.setState({ hasError: false })
    window.location.reload()
  }

  render() {
    if (!this.state.hasError) return this.props.children
    return (
      <div
        role="alert"
        style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '24px',
          background: 'var(--paper, #f7f4ee)',
          fontFamily:
            "'Inter Tight', system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
        }}
      >
        <div
          style={{
            maxWidth: 420,
            background: '#fff',
            border: '1px solid rgba(0,0,0,0.08)',
            borderRadius: 12,
            padding: '24px 28px',
            boxShadow: '0 1px 2px rgba(0,0,0,0.04)',
          }}
        >
          <h2
            style={{
              margin: '0 0 8px',
              fontFamily: "'Source Serif 4', Georgia, serif",
              fontWeight: 600,
              fontSize: 22,
              color: '#0e1116',
            }}
          >
            Something went wrong.
          </h2>
          <p style={{ margin: '0 0 20px', color: '#444', lineHeight: 1.5 }}>
            The page hit an unexpected error. Reloading usually fixes it. If it
            keeps happening, please let us know.
          </p>
          <button
            type="button"
            onClick={this.handleReload}
            style={{
              appearance: 'none',
              border: 'none',
              background: '#0e1116',
              color: '#fff',
              padding: '10px 18px',
              borderRadius: 8,
              fontSize: 14,
              fontWeight: 500,
              cursor: 'pointer',
              letterSpacing: '-0.01em',
            }}
          >
            Reload page
          </button>
        </div>
      </div>
    )
  }
}
