// WS protocol test for Express + @fluxstack/live
import WebSocket from 'ws'

const WS_URL = 'ws://localhost:4000/api/live/ws'
let passed = 0
let failed = 0

function assert(cond, msg) {
  if (cond) { passed++; console.log(`  PASS: ${msg}`) }
  else { failed++; console.log(`  FAIL: ${msg}`) }
}

/**
 * Send a message and wait for the ACTION_RESPONSE (by requestId)
 * plus collect any STATE_DELTA messages (by componentId) into a merged object.
 */
function sendAction(ws, msg, componentId, timeoutMs = 3000) {
  return new Promise((resolve) => {
    let response = null
    const deltas = {}
    const timer = setTimeout(() => {
      ws.removeListener('message', handler)
      resolve({ response, state: Object.keys(deltas).length > 0 ? deltas : null })
    }, timeoutMs)

    const handler = (raw) => {
      const data = JSON.parse(raw.toString())
      // ACTION_RESPONSE carries the requestId
      if (data.requestId === msg.requestId) response = data
      // STATE_DELTA carries incremental field updates
      if (data.type === 'STATE_DELTA' && data.componentId === componentId) {
        Object.assign(deltas, data.payload?.delta || {})
      }
      // Done when we have both response and at least one delta
      if (response && Object.keys(deltas).length > 0) {
        clearTimeout(timer)
        ws.removeListener('message', handler)
        resolve({ response, state: deltas })
      }
    }
    ws.on('message', handler)
    ws.send(JSON.stringify(msg))
  })
}

/**
 * Send a message and wait for the MESSAGE_RESPONSE (by requestId).
 */
function sendAndWait(ws, msg, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout: ${msg.type}`)), timeoutMs)
    const handler = (raw) => {
      const data = JSON.parse(raw.toString())
      if (data.requestId === msg.requestId) {
        clearTimeout(timer)
        ws.removeListener('message', handler)
        resolve(data)
      }
    }
    ws.on('message', handler)
    ws.send(JSON.stringify(msg))
  })
}

async function run() {
  console.log('\n=== WS Protocol Tests ===\n')

  // Test 1: Counter mount
  console.log('1) Counter mount')
  const ws1 = new WebSocket(WS_URL)
  await new Promise(r => ws1.on('open', r))

  const mount1 = await sendAndWait(ws1, {
    type: 'COMPONENT_MOUNT',
    payload: { component: 'Counter' },
    requestId: 'mount-counter-1',
    expectResponse: true,
  })
  assert(mount1.success && typeof mount1.result?.initialState?.count === 'number',
    'Counter mounted with count in state')
  const cid1 = mount1.result?.componentId

  // Test 2: Counter increment
  console.log('2) Counter increment')
  const { response: inc, state: incState } = await sendAction(ws1, {
    type: 'CALL_ACTION',
    componentId: cid1,
    action: 'increment',
    payload: {},
    requestId: 'inc-1',
    expectResponse: true,
  }, cid1)
  assert(inc?.success && incState?.count === 1,
    `Counter incremented to ${incState?.count}`)

  // Test 3: Counter decrement
  console.log('3) Counter decrement')
  const { response: dec, state: decState } = await sendAction(ws1, {
    type: 'CALL_ACTION',
    componentId: cid1,
    action: 'decrement',
    payload: {},
    requestId: 'dec-1',
    expectResponse: true,
  }, cid1)
  assert(dec?.success && decState?.count === 0,
    `Counter decremented to ${decState?.count}`)
  ws1.close()

  // Test 4: ChatRoom mount
  console.log('4) ChatRoom mount')
  const ws2 = new WebSocket(WS_URL)
  await new Promise(r => ws2.on('open', r))

  const mount2 = await sendAndWait(ws2, {
    type: 'COMPONENT_MOUNT',
    payload: { component: 'ChatRoom' },
    requestId: 'mount-chat-1',
    expectResponse: true,
  })
  assert(mount2.success && Array.isArray(mount2.result?.initialState?.messages),
    'ChatRoom mounted with messages array')
  const cid2 = mount2.result?.componentId

  // Test 5: setUsername
  console.log('5) ChatRoom setUsername')
  const { response: usr, state: usrState } = await sendAction(ws2, {
    type: 'CALL_ACTION',
    componentId: cid2,
    action: 'setUsername',
    payload: { username: 'TestUser' },
    requestId: 'usr-1',
    expectResponse: true,
  }, cid2)
  assert(usr?.success && usrState?.username === 'TestUser',
    `Username set to ${usrState?.username}`)

  // Test 6: joinRoom
  console.log('6) ChatRoom joinRoom')
  const { response: join, state: joinState } = await sendAction(ws2, {
    type: 'CALL_ACTION',
    componentId: cid2,
    action: 'joinRoom',
    payload: { roomId: 'test-room' },
    requestId: 'join-1',
    expectResponse: true,
  }, cid2)
  assert(join?.success && joinState?.currentRoom === 'test-room',
    `Joined room: ${joinState?.currentRoom}`)

  // Test 7: sendMessage
  console.log('7) ChatRoom sendMessage')
  const { response: msg, state: msgState } = await sendAction(ws2, {
    type: 'CALL_ACTION',
    componentId: cid2,
    action: 'sendMessage',
    payload: { text: 'Hello from test' },
    requestId: 'msg-1',
    expectResponse: true,
  }, cid2)
  assert(msg?.success && msgState?.messages?.length > 0,
    `Message sent, count: ${msgState?.messages?.length}`)
  ws2.close()

  console.log(`\n=== Results: ${passed}/${passed + failed} passed ===\n`)
  process.exit(failed > 0 ? 1 : 0)
}

run().catch(e => { console.error(e); process.exit(1) })
