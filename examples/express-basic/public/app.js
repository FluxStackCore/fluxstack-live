// Express + @fluxstack/live — Client Application
//
// Uses the @fluxstack/live-client browser bundle (IIFE → window.FluxstackLive)

const { LiveConnection, LiveComponentHandle } = FluxstackLive

// ===== Logging =====

function log(msg, type = 'info') {
  const el = document.getElementById('log')
  const d = document.createElement('div')
  d.className = 'log-entry ' + type
  d.textContent = new Date().toLocaleTimeString() + ' ' + msg
  el.prepend(d)
  if (el.children.length > 80) el.removeChild(el.lastChild)
}

// ===== Connection =====

const connection = new LiveConnection({
  url: 'ws://' + location.host + '/api/live/ws',
  debug: false,
})

connection.onStateChange(function (state) {
  const statusEl = document.getElementById('status')
  if (state.connected) {
    statusEl.textContent = 'Connected'
    statusEl.className = 'status connected'
    log('Connected', 'success')
  } else if (state.connecting) {
    statusEl.textContent = 'Connecting...'
    statusEl.className = 'status disconnected'
  } else {
    statusEl.textContent = 'Disconnected'
    statusEl.className = 'status disconnected'
    log('Disconnected', 'error')
  }
})

// ===== Counter Component =====

const counter = new LiveComponentHandle(connection, 'Counter', {
  initialState: { count: 0, lastAction: null },
  debug: false,
})

counter.onStateChange(function (state) {
  if (state.count !== undefined) {
    document.getElementById('count').textContent = state.count
  }
})

counter.onError(function (err) {
  log('Counter error: ' + err, 'error')
})

function counterAction(action) {
  counter.call(action).catch(function (e) {
    log('Counter: ' + e.message, 'error')
  })
}

// ===== Shared Counter Component =====

const shared = new LiveComponentHandle(connection, 'SharedCounter', {
  initialState: { count: 0, lastUser: null, viewers: 0 },
  debug: false,
})

shared.onStateChange(function (state) {
  if (state.count !== undefined) {
    document.getElementById('sharedCount').textContent = state.count
  }
  if (state.viewers !== undefined) {
    document.getElementById('sharedViewers').textContent = state.viewers
  }
  if (state.lastUser !== undefined && state.lastUser) {
    document.getElementById('sharedLastUser').textContent = 'last action by ' + state.lastUser
  }
})

shared.onError(function (err) {
  log('SharedCounter error: ' + err, 'error')
})

function sharedAction(action) {
  shared.call(action).catch(function (e) {
    log('SharedCounter: ' + e.message, 'error')
  })
}

// ===== Chat Component =====

var chat = null
var pendingRoom = ''

function createChat(roomId) {
  pendingRoom = roomId

  chat = new LiveComponentHandle(connection, 'ChatRoom', {
    initialState: { messages: [], users: [], currentRoom: '', username: '' },
    autoMount: true,
    debug: false,
  })

  chat.onStateChange(function (state, delta) {
    updateChatUI(delta || state)
  })

  chat.onError(function (err) {
    log('Chat error: ' + err, 'error')
  })

  // Wait for mount, then set username and join room
  var checkMounted = setInterval(async function () {
    if (!chat.mounted) return
    clearInterval(checkMounted)

    var username = document.getElementById('usernameInput').value
      || 'User-' + Math.random().toString(36).slice(2, 5)

    try {
      await chat.call('setUsername', { username: username })
      await chat.call('joinRoom', { roomId: pendingRoom })
      log('Joined room: ' + pendingRoom, 'success')
    } catch (e) {
      log('Join failed: ' + e.message, 'error')
    }
  }, 50)
}

function esc(s) {
  var d = document.createElement('div')
  d.textContent = s
  return d.innerHTML
}

function updateChatUI(state) {
  if (state.messages !== undefined) {
    var el = document.getElementById('messages')
    el.innerHTML = ''
    for (var i = 0; i < state.messages.length; i++) {
      var m = state.messages[i]
      var d = document.createElement('div')
      if (m.user === 'System') {
        d.className = 'msg system'
        d.textContent = m.text
      } else {
        d.className = 'msg'
        d.innerHTML = '<span class="user">' + esc(m.user) + ':</span> ' + esc(m.text) + '<span class="time">' + esc(m.time) + '</span>'
      }
      el.appendChild(d)
    }
    el.scrollTop = el.scrollHeight
  }
  if (state.users !== undefined) {
    document.getElementById('usersBar').innerHTML = 'Users: <span>' + state.users.map(esc).join(', ') + '</span>'
  }
  if (state.currentRoom !== undefined && state.currentRoom) {
    document.querySelectorAll('.room-btn').forEach(function (b) {
      b.classList.toggle('active', b.textContent === state.currentRoom)
    })
  }
}

function joinChatRoom(roomId) {
  if (!chat) {
    // First time - mount chat component, then join
    document.getElementById('chatSetup').style.display = 'none'
    document.getElementById('chatUI').style.display = 'block'
    createChat(roomId)
  } else {
    // Already mounted - switch rooms
    chat.call('joinRoom', { roomId: roomId }).catch(function (e) {
      log('Join failed: ' + e.message, 'error')
    })
  }
}

function leaveChat() {
  if (chat) {
    chat.call('leaveRoom').catch(function () {})
    chat.destroy()
    chat = null
  }
  document.getElementById('chatSetup').style.display = 'flex'
  document.getElementById('chatUI').style.display = 'none'
  document.getElementById('messages').innerHTML = ''
}

function sendChat() {
  var input = document.getElementById('chatInput')
  var text = input.value.trim()
  if (!text || !chat) return
  chat.call('sendMessage', { text: text }).catch(function (e) {
    log('Send failed: ' + e.message, 'error')
  })
  input.value = ''
}

// ===== Stats polling =====

setInterval(async function () {
  try {
    var s = await fetch('/api/live/stats').then(function (r) { return r.json() })
    document.getElementById('statsBar').textContent =
      'Components: ' + s.components.components +
      '  |  Connections: ' + s.connections.activeConnections +
      '  |  Rooms: ' + s.rooms.totalRooms
  } catch (e) { /* ignore */ }
}, 3000)
