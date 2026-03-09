// ── Cluster-Failover Demo (Vanilla JS) ──────────────

export const CLUSTER = {
  // Counter display
  count: '#count',
  lastServer: '#lastServer',
  history: '#history',
  historyEntry: '.history-entry',

  // Connection
  dot: '#dot',
  dotConnected: '#dot.connected',
  status: '#status',

  // Server buttons
  btnA: '#btnA',
  btnB: '#btnB',

  // Action buttons
  btnInc: '.btn-inc',
  btnDec: '.btn-dec',
  btnReset: '.btn-reset',

  // Log
  log: '#log',
  logEntry: '.log-entry',
  logSuccess: '.log-entry.success',
  logError: '.log-entry.error',
} as const

// ── React App (FluxStack) ───────────────────────────

export const REACT = {
  nav: {
    counter: 'a:has-text("Counter")',
    form: 'a:has-text("Form")',
    chat: 'a:has-text("Chat")',
    roomChat: 'a:has-text("Room Chat")',
    todo: 'a:has-text("Todo")',
    auth: 'a:has-text("Auth")',
  },
} as const
