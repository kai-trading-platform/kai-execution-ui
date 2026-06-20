import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { AuthProvider } from "@/contexts/AuthContext";
import { MarketSocketProvider } from "@/contexts/MarketSocketContext";
import TradingTerminalPage from "@/pages/TradingTerminal";
import { Routes as routePaths } from "@/config/routes";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: false,
    },
  },
});

const App = () => (
  <ThemeProvider attribute="class" defaultTheme="dark" enableSystem={false}>
    <AuthProvider>
      <MarketSocketProvider>
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <Sonner />
            <BrowserRouter
              future={{
                v7_startTransition: true,
                v7_relativeSplatPath: true,
              }}
            >
              <Routes>
                <Route path={routePaths.HOME} element={<Navigate to={routePaths.TRADING_TERMINAL} replace />} />
                <Route path={routePaths.TRADING_TERMINAL} element={<TradingTerminalPage />} />
              </Routes>
            </BrowserRouter>
          </TooltipProvider>
        </QueryClientProvider>
      </MarketSocketProvider>
    </AuthProvider>
  </ThemeProvider>
);

export default App;
