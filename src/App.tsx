import { BrowserRouter, Routes, Route, Navigate, useSearchParams } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ConfirmDialogProvider } from "@/components/ConfirmDialogProvider";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { AuthProvider, useAuth } from "@/contexts/AuthContext";
import { MarketSocketProvider } from "@/contexts/MarketSocketContext";
import TradingTerminalPage from "@/pages/TradingTerminal";
import LoginPage from "@/pages/Login";
import { Routes as routePaths } from "@/config/routes";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: false,
    },
  },
});

function HomeRedirect() {
  const [searchParams] = useSearchParams();
  const account = searchParams.get("account");
  const to = account
    ? `${routePaths.TRADING_TERMINAL}?account=${encodeURIComponent(account)}`
    : routePaths.TRADING_TERMINAL;
  return <Navigate to={to} replace />;
}

/**
 * Gates protected routes. While the session bootstrap is in flight we show a
 * spinner (avoids flashing the login screen before a cookie-based session
 * resolves); once settled, unauthenticated users get the login screen rendered
 * in place so the current URL — including the ?account= param — is preserved.
 */
function RequireAuth({ children }: { children: ReactNode }) {
  const { isAuthenticated, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return <LoginPage />;
  }

  return <>{children}</>;
}

const App = () => (
  <ErrorBoundary>
  <ThemeProvider attribute="class" defaultTheme="dark" enableSystem={false}>
    <AuthProvider>
      <MarketSocketProvider>
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <ConfirmDialogProvider>
            <Sonner />
            <BrowserRouter
              future={{
                v7_startTransition: true,
                v7_relativeSplatPath: true,
              }}
            >
              <Routes>
                <Route path={routePaths.HOME} element={<HomeRedirect />} />
                <Route
                  path={routePaths.TRADING_TERMINAL}
                  element={
                    <RequireAuth>
                      <TradingTerminalPage />
                    </RequireAuth>
                  }
                />
              </Routes>
            </BrowserRouter>
            </ConfirmDialogProvider>
          </TooltipProvider>
        </QueryClientProvider>
      </MarketSocketProvider>
    </AuthProvider>
  </ThemeProvider>
  </ErrorBoundary>
);

export default App;
