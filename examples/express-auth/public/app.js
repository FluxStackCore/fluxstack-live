// @fluxstack/live Auth Demo — Client
//
// Tests: authenticate(), $auth.session, authorize(), $private, auto re-mount

var FLive = FluxstackLive
var useLive = FLive.useLive
var onConnectionChange = FLive.onConnectionChange
var connection = FLive.getConnection()

// ===== Logging =====

function log(msg, type) {
  type = type || 'info'
  var el = document.getElementById('log')
  var d = document.createElement('div')
  d.className = 'log-entry ' + type
  d.textContent = new Date().toLocaleTimeString() + ' ' + msg
  el.prepend(d)
  if (el.children.length > 50) el.removeChild(el.lastChild)
}

// ===== Connection =====

onConnectionChange(function (connected) {
  var s = document.getElementById('status')
  s.textContent = connected ? 'Connected' : 'Disconnected'
  s.className = 'status ' + (connected ? 'connected' : 'disconnected')
  log(connected ? 'WebSocket connected' : 'WebSocket disconnected', connected ? 'success' : 'error')
})

// ===== Auth =====

// Keep UI in sync with connection auth state
connection.onStateChange(function (state) {
  var el = document.getElementById('authStatus')
  var sessionEl = document.getElementById('sessionData')
  var logoutBtn = document.getElementById('logoutBtn')

  if (state.auth && state.auth.authenticated && state.auth.session) {
    var s = state.auth.session
    el.textContent = 'Authenticated as: ' + (s.name || s.id)
    el.className = 'auth-status authenticated'
    sessionEl.textContent = '$auth.session = ' + JSON.stringify(s, null, 2)
    sessionEl.style.display = 'block'
    logoutBtn.style.display = 'inline-block'
  } else if (!state.authenticated) {
    el.textContent = 'Not authenticated'
    el.className = 'auth-status anonymous'
    sessionEl.style.display = 'none'
    logoutBtn.style.display = 'none'
  }
})

function login(token) {
  log('Authenticating with: ' + token + '...')
  connection.authenticate({ token: token }).then(function (success) {
    if (success) {
      log('Authenticated!', 'success')
      remountProtected()
    } else {
      log('Authentication failed!', 'error')
    }
  })
}

function logout() {
  log('Logging out...')
  hideProtected()
  connection.reconnect()
}

// ===== Public Counter =====

var counter = useLive('PublicCounter', { count: 0 })

counter.on(function (state) {
  document.getElementById('count').textContent = state.count
})

counter.onError(function (err) {
  log('Counter error: ' + err, 'error')
})

function counterAction(action) {
  counter.call(action).catch(function (e) {
    log('Counter: ' + e.message, 'error')
  })
}

// ===== Protected Notes =====

var notes = null

function mountNotes() {
  if (notes) return

  notes = useLive('ProtectedNotes', { notes: [], totalNotes: 0 })

  notes.on(function (state) {
    renderNotes(state.notes || [])
  })

  notes.onError(function (err) {
    if (err && err.includes && err.includes('AUTH_DENIED')) {
      document.getElementById('notesError').textContent = 'AUTH_DENIED: ' + err
      document.getElementById('notesError').style.display = 'block'
      document.getElementById('notesContent').style.display = 'none'
    } else {
      log('Notes error: ' + err, 'error')
    }
  })

  // Wait for mount
  var check = setInterval(function () {
    if (notes.mounted) {
      clearInterval(check)
      document.getElementById('notesError').style.display = 'none'
      document.getElementById('notesContent').style.display = 'block'
      log('ProtectedNotes mounted', 'success')
    }
  }, 100)

  // Timeout
  setTimeout(function () { clearInterval(check) }, 5000)
}

function renderNotes(notesList) {
  var el = document.getElementById('notesList')
  el.innerHTML = ''
  for (var i = 0; i < notesList.length; i++) {
    var n = notesList[i]
    var d = document.createElement('div')
    d.className = 'note'
    d.innerHTML = '<span><span class="author">' + esc(n.author) + '</span>' + esc(n.text) + '</span>'
      + '<span class="del" onclick="deleteNote(' + n.id + ')">delete</span>'
    el.appendChild(d)
  }
}

function addNote() {
  var input = document.getElementById('noteInput')
  var text = input.value.trim()
  if (!text || !notes) return
  notes.call('addNote', { text: text }).then(function (r) {
    log('Note added: ' + r.note.text, 'success')
  }).catch(function (e) {
    log('addNote: ' + e.message, 'error')
  })
  input.value = ''
}

function deleteNote(noteId) {
  if (!notes) return
  notes.call('deleteNote', { noteId: noteId }).catch(function (e) {
    log('deleteNote: ' + e.message, 'error')
  })
}

function notesGetProfile() {
  if (!notes) return
  notes.call('getProfile').then(function (r) {
    document.getElementById('profileInfo').textContent = JSON.stringify(r, null, 2)
    log('getProfile: ' + r.session.name + ' (plan: ' + r.session.plan + ')', 'success')
  }).catch(function (e) {
    log('getProfile: ' + e.message, 'error')
  })
}

function notesAdminClear() {
  if (!notes) return
  notes.call('adminClear').then(function (r) {
    log('adminClear: cleared ' + r.cleared + ' notes', 'success')
  }).catch(function (e) {
    log('adminClear: ' + e.message, 'error')
  })
}

// ===== Pro Dashboard =====

var pro = null

function mountPro() {
  if (pro) return

  pro = useLive('ProDashboard', { stats: { views: 0, revenue: 0 } })

  pro.onError(function (err) {
    if (err && err.includes && err.includes('AUTH_DENIED')) {
      document.getElementById('proError').textContent = 'AUTH_DENIED: ' + err
      document.getElementById('proError').style.display = 'block'
      document.getElementById('proContent').style.display = 'none'
    } else {
      log('ProDashboard error: ' + err, 'error')
    }
  })

  var check = setInterval(function () {
    if (pro.mounted) {
      clearInterval(check)
      document.getElementById('proError').style.display = 'none'
      document.getElementById('proContent').style.display = 'block'
      log('ProDashboard mounted', 'success')
    }
  }, 100)

  setTimeout(function () { clearInterval(check) }, 5000)
}

function proGetStats() {
  if (!pro) return
  pro.call('getStats').then(function (r) {
    document.getElementById('proStats').textContent = JSON.stringify(r, null, 2)
    log('getStats: plan=' + r.plan, 'success')
  }).catch(function (e) {
    log('getStats: ' + e.message, 'error')
  })
}

// ===== Helpers =====

function esc(s) {
  var d = document.createElement('div')
  d.textContent = s
  return d.innerHTML
}

function remountProtected() {
  // Destroy old instances and recreate with fresh auth
  if (notes) { try { notes.destroy() } catch(e) {} notes = null }
  if (pro) { try { pro.destroy() } catch(e) {} pro = null }
  document.getElementById('notesError').style.display = 'none'
  document.getElementById('notesContent').style.display = 'none'
  document.getElementById('proError').style.display = 'none'
  document.getElementById('proContent').style.display = 'none'
  // Small delay to let server process auth before mounting
  setTimeout(function () {
    mountNotes()
    mountPro()
  }, 200)
}

function hideProtected() {
  if (notes) { notes.destroy(); notes = null }
  if (pro) { pro.destroy(); pro = null }
  document.getElementById('notesContent').style.display = 'none'
  document.getElementById('proContent').style.display = 'none'
  document.getElementById('notesError').style.display = 'none'
  document.getElementById('proError').style.display = 'none'
}

// Mount protected on load (will show AUTH_DENIED until login)
mountNotes()
mountPro()
