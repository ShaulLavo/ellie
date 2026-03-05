import {
	Component,
	type ErrorInfo,
	type ReactNode
} from 'react'

interface ErrorBoundaryProps {
	children: ReactNode
	fallback?: ReactNode
	onError?: (error: Error, errorInfo: ErrorInfo) => void
}

interface ErrorBoundaryState {
	hasError: boolean
	error: Error | null
}

export class ErrorBoundary extends Component<
	ErrorBoundaryProps,
	ErrorBoundaryState
> {
	state: ErrorBoundaryState = {
		hasError: false,
		error: null
	}

	static getDerivedStateFromError(
		error: Error
	): ErrorBoundaryState {
		return { hasError: true, error }
	}

	componentDidCatch(error: Error, errorInfo: ErrorInfo) {
		console.error('[ErrorBoundary]', error, errorInfo)
		this.props.onError?.(error, errorInfo)
	}

	handleReset = () => {
		this.setState({ hasError: false, error: null })
	}

	render() {
		if (this.state.hasError) {
			if (this.props.fallback) return this.props.fallback

			return (
				<div className="flex h-screen flex-col items-center justify-center gap-4 bg-background p-8">
					<div className="text-center space-y-2">
						<h1 className="font-display text-lg font-semibold tracking-tight">
							Something went wrong
						</h1>
						<p className="text-sm text-muted-foreground max-w-md">
							{this.state.error?.message ??
								'An unexpected error occurred.'}
						</p>
					</div>
					<button
						type="button"
						onClick={this.handleReset}
						className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
					>
						Try again
					</button>
				</div>
			)
		}

		return this.props.children
	}
}
