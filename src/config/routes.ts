export const Routes = {
  HOME: '/',
  // Universal, backward-compatible entry: lists every account, infers the
  // terminal mode (CFD vs Futuros) from the selected account's `provider`.
  // Existing SSO deep-links from kai-frontend point here — keep it working
  // exactly as before (Phase 6 spec §6: don't break `?account=` flow).
  TRADING_TERMINAL: '/trading/terminal',
  // Deep-linkable, route-scoped entries (Phase 6). Same page/shell as
  // TRADING_TERMINAL, but the account selector is filtered to the route's
  // provider (futures → rithmic, cfd → everything else / mt5).
  TRADING_FUTURES: '/trading/futuros',
  TRADING_CFD: '/trading/cfd',
} as const;
