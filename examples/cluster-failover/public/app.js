// Cluster Failover Demo — Client
//
// Uses FluxstackLive browser bundle (IIFE → window.FluxstackLive)

var useLive = FluxstackLive.useLive
var onConnectionChange = FluxstackLive.onConnectionChange
var getConnection = FluxstackLive.getConnection

var currentPort = 3001
var counter = null

// ── Logging ─────────────────────────────────────────

function log(msg, type) {
  type = type || 'info'
  var el = document.getElementById('log')
  var d = document.createElement('div')
  d.className = 'log-entry ' + type
  d.textContent = new Date().toLocaleTimeString() + '  ' + msg
  el.prepend(d)
  if (el.children.length > 50) el.removeChild(el.lastChild)
}

// ── UI Update ───────────────────────────────────────

function updateUI(state) {
  document.getElementById('count').textContent = state.count
  document.getElementById('lastServer').textContent = state.lastServer
    ? 'Last action: ' + state.lastServer
    : '-'

  var historyEl = document.getElementById('history')
  if (state.history && state.history.length > 0) {
    historyEl.innerHTML = state.history
      .slice()
      .reverse()
      .map(function (h) { return '<div class="history-entry">' + h + '</div>' })
      .join('')
  } else {
    historyEl.innerHTML = '<div class="history-empty">No actions yet</div>'
  }
}

function updateButtons() {
  document.getElementById('btnA').className = 'server-btn' + (currentPort === 3001 ? ' active' : '')
  document.getElementById('btnB').className = 'server-btn' + (currentPort === 3002 ? ' active' : '')
}

// ── Connection ──────────────────────────────────────

function connectTo(port) {
  if (port === currentPort && counter) return

  log('Switching to Server ' + (port === 3001 ? 'A' : 'B') + ' (:' + port + ')...')

  if (counter) {
    counter.destroy()
    counter = null
  }

  currentPort = port
  updateButtons()

  var url = 'ws://localhost:' + port + '/api/live/ws'
  counter = useLive('SharedCounter', { count: 0, lastServer: '', history: [] }, { url: url, debug: true })

  log('useLive created, waiting for mount...', 'info')

  counter.on(function (state) {
    log('State received: count=' + state.count + ' server=' + state.lastServer, 'success')
    updateUI(state)
  })

  counter.onError(function (err) {
    log('Error: ' + err, 'error')
  })

  // Poll for mount status (debug aid)
  var checks = 0
  var pollId = setInterval(function () {
    checks++
    if (counter && counter.mounted) {
      log('Mounted! componentId=' + counter.componentId, 'success')
      clearInterval(pollId)
    } else if (checks > 20) {
      log('Mount timeout after 10s', 'error')
      clearInterval(pollId)
    }
  }, 500)
}

// ── Actions ─────────────────────────────────────────

function doAction(action) {
  if (!counter) return
  if (!counter.mounted) {
    log(action + ' skipped: not mounted yet', 'error')
    return
  }
  counter.call(action).then(function () {
    log(action + ' via :' + currentPort, 'success')
  }).catch(function (e) {
    log(action + ' failed: ' + e.message, 'error')
  })
}

// ── Connection status ───────────────────────────────

onConnectionChange(function (connected) {
  var dot = document.getElementById('dot')
  var status = document.getElementById('status')
  dot.className = 'dot' + (connected ? ' connected' : '')
  status.textContent = connected
    ? 'Connected to :' + currentPort
    : 'Disconnected'
  log(connected ? 'Connected to :' + currentPort : 'Disconnected', connected ? 'success' : 'error')
})

// ── Init ────────────────────────────────────────────

connectTo(3001)
