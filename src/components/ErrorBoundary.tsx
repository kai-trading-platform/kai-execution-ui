import React from "react";

interface State {
  error: Error | null;
}

/**
 * App-level error boundary. Without it, a render error in any route (e.g. the
 * trading terminal or chart) unmounts the whole tree and leaves a blank white
 * screen with no recovery. This catches it and offers a reload.
 */
export class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  State
> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("Unhandled render error:", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background p-6 text-center">
          <h1 className="text-lg font-semibold text-foreground">
            Algo salió mal
          </h1>
          <p className="max-w-md text-sm text-muted-foreground">
            La interfaz encontró un error inesperado. Tus posiciones y órdenes no
            se ven afectadas. Recarga para continuar.
          </p>
          <button
            onClick={() => window.location.reload()}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90"
          >
            Recargar
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
