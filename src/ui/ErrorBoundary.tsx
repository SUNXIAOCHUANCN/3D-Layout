import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  err: string | null
}

/** 全局错误边界：把未捕获的渲染错误直接显示在页面上（开发期排查用），避免整页白屏无声崩溃 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { err: null }

  static getDerivedStateFromError(e: Error): State {
    return { err: `${e.message}\n\n${e.stack ?? ''}` }
  }

  componentDidCatch(_e: Error, _info: ErrorInfo): void {
    // 错误已渲染到页面；保持无声（生产可在此上报）
  }

  render(): ReactNode {
    if (this.state.err) {
      return (
        <pre className="crash-report">
          渲染错误：
          {this.state.err}
        </pre>
      )
    }
    return this.props.children
  }
}
