import { Component } from 'react';

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
    // Keep console logging for debugging.
    console.error('UI crashed:', error, info);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    const { hasError, error } = this.state;
    if (hasError) {
      return (
        <div className="min-h-screen bg-[#f4f6fb] flex items-center justify-center p-6">
          <div className="max-w-md w-full bg-white rounded-2xl shadow-card p-6 text-center">
            <h1 className="text-lg font-bold text-[#050505]">Something went wrong</h1>
            <p className="text-sm text-[#6D6E71] mt-2">
              The app hit a runtime error. Please share the message below so we can fix it.
            </p>
            <div className="mt-4 text-left bg-gray-50 border border-gray-100 rounded-xl p-3 text-xs text-[#6D6E71] break-words">
              {error?.message || 'Unknown error'}
            </div>
            <button
              onClick={this.handleReset}
              className="mt-4 px-4 py-2 rounded-lg bg-[#8BC53D] text-white text-sm font-semibold hover:bg-[#476E2C] transition-colors"
            >
              Try again
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
