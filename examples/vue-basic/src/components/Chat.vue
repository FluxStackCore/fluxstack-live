<script setup lang="ts">
import { ref, computed, nextTick, watch, onUnmounted } from 'vue'
import { useLive } from '@fluxstack/live-vue'

interface ChatMessage {
  id: string
  user: string
  text: string
  time: number
  color: string
}

const { state, call, error, mounted } = useLive('Chat', {
  messages: [] as ChatMessage[],
  username: '',
  userColor: '',
  joined: false,
  onlineUsers: [] as { name: string; color: string }[],
  typingUsers: [] as string[],
})

const usernameInput = ref('')
const messageInput = ref('')
const messagesEl = ref<HTMLElement | null>(null)
const joining = ref(false)
const showOnline = ref(false)

// Typing indicator debounce
let typingTimer: ReturnType<typeof setTimeout> | null = null

function getInitials(name: string) {
  return name.slice(0, 2).toUpperCase()
}

// Group consecutive messages by same user
const groupedMessages = computed(() => {
  const msgs = state.messages
  const groups: { user: string; color: string; isSystem: boolean; messages: ChatMessage[] }[] = []

  for (const msg of msgs) {
    const last = groups[groups.length - 1]
    if (last && last.user === msg.user) {
      last.messages.push(msg)
    } else {
      groups.push({
        user: msg.user,
        color: msg.color || '',
        isSystem: msg.user === 'system',
        messages: [msg],
      })
    }
  }
  return groups
})

const typingText = computed(() => {
  const users = state.typingUsers
  if (!users || users.length === 0) return ''
  if (users.length === 1) return `${users[0]} digitando...`
  if (users.length === 2) return `${users[0]} e ${users[1]} digitando...`
  return `${users[0]} e outros digitando...`
})

async function joinChat() {
  if (!usernameInput.value.trim() || joining.value) return
  joining.value = true
  try {
    await call('join', { username: usernameInput.value.trim() })
  } catch (e) {
    // error is already set by useLive
  } finally {
    joining.value = false
  }
}

async function sendMessage() {
  const text = messageInput.value.trim()
  if (!text) return
  messageInput.value = ''
  try {
    await call('sendMessage', { text })
  } catch (e) {
    // error is already set
  }
}

function onInput() {
  if (typingTimer) clearTimeout(typingTimer)
  call('typing', {}).catch(() => {})
  typingTimer = setTimeout(() => {
    // typing stops after 2s of inactivity
  }, 2000)
}

function formatTime(ts: number) {
  return new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
}

// Auto-scroll on new messages
watch(
  () => state.messages.length,
  async () => {
    await nextTick()
    if (messagesEl.value) {
      messagesEl.value.scrollTop = messagesEl.value.scrollHeight
    }
  },
)

onUnmounted(() => {
  if (typingTimer) clearTimeout(typingTimer)
})
</script>

<template>
  <div class="chat">
    <!-- Join Screen -->
    <div v-if="!state.joined" class="join-screen">
      <div class="join-icon">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#38bdf8" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
        </svg>
      </div>
      <h2>Chat em Grupo</h2>
      <p class="join-desc">Entre com seu nome para participar da conversa em tempo real</p>
      <form @submit.prevent="joinChat" class="join-form">
        <input
          v-model="usernameInput"
          type="text"
          placeholder="Seu nome..."
          maxlength="20"
          :disabled="!mounted || joining"
          autofocus
        />
        <button type="submit" :disabled="!usernameInput.trim() || !mounted || joining">
          {{ joining ? 'Entrando...' : 'Entrar' }}
        </button>
      </form>
      <p v-if="!mounted" class="hint">Conectando ao servidor...</p>
    </div>

    <!-- Chat Screen -->
    <div v-else class="chat-screen">
      <!-- Header -->
      <div class="chat-header">
        <div class="header-left">
          <div class="header-icon">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
              <circle cx="9" cy="7" r="4"/>
              <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
              <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
            </svg>
          </div>
          <div>
            <span class="chat-title">Chat em Grupo</span>
            <span class="online-count" @click="showOnline = !showOnline">
              {{ state.onlineUsers.length }} online
            </span>
          </div>
        </div>
        <div class="header-right">
          <div
            class="avatar-mini"
            :style="{ background: state.userColor }"
            :title="state.username"
          >
            {{ getInitials(state.username) }}
          </div>
        </div>
      </div>

      <!-- Online Users Dropdown -->
      <div v-if="showOnline && state.onlineUsers.length > 0" class="online-panel">
        <div v-for="u in state.onlineUsers" :key="u.name" class="online-user">
          <div class="online-dot"></div>
          <span class="online-avatar" :style="{ background: u.color }">{{ getInitials(u.name) }}</span>
          <span class="online-name">{{ u.name }}</span>
          <span v-if="u.name === state.username" class="you-badge">you</span>
        </div>
      </div>

      <!-- Messages Area -->
      <div ref="messagesEl" class="messages" @click="showOnline = false">
        <div v-if="state.messages.length === 0" class="empty">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#475569" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
          </svg>
          <p>Nenhuma mensagem ainda</p>
          <p class="empty-sub">Seja o primeiro a dizer algo!</p>
        </div>

        <template v-for="(group, gi) in groupedMessages" :key="gi">
          <!-- System Messages -->
          <div v-if="group.isSystem" class="system-group">
            <div v-for="msg in group.messages" :key="msg.id" class="system-msg">
              {{ msg.text }}
            </div>
          </div>

          <!-- User Message Group -->
          <div
            v-else
            :class="['msg-group', group.user === state.username ? 'mine' : 'theirs']"
          >
            <!-- Avatar (only for others) -->
            <div v-if="group.user !== state.username" class="msg-avatar" :style="{ background: group.color }">
              {{ getInitials(group.user) }}
            </div>

            <div class="msg-col">
              <!-- Username (only for others, only first msg in group) -->
              <span v-if="group.user !== state.username" class="msg-user" :style="{ color: group.color }">
                {{ group.user }}
              </span>

              <!-- Bubbles -->
              <div
                v-for="(msg, mi) in group.messages"
                :key="msg.id"
                :class="[
                  'bubble',
                  group.user === state.username ? 'mine' : 'theirs',
                  mi === 0 ? 'first' : '',
                  mi === group.messages.length - 1 ? 'last' : '',
                ]"
              >
                <span class="bubble-text">{{ msg.text }}</span>
                <span class="bubble-time">{{ formatTime(msg.time) }}</span>
              </div>
            </div>
          </div>
        </template>

        <!-- Typing Indicator -->
        <div v-if="typingText" class="typing-indicator">
          <span class="typing-dots">
            <span></span><span></span><span></span>
          </span>
          {{ typingText }}
        </div>
      </div>

      <!-- Send Form -->
      <form @submit.prevent="sendMessage" class="send-form">
        <input
          v-model="messageInput"
          type="text"
          placeholder="Digite uma mensagem..."
          maxlength="500"
          autofocus
          @input="onInput"
        />
        <button type="submit" :disabled="!messageInput.trim()">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="22" y1="2" x2="11" y2="13"/>
            <polygon points="22 2 15 22 11 13 2 9 22 2"/>
          </svg>
        </button>
      </form>
    </div>

    <p v-if="error" class="error">{{ error }}</p>
  </div>
</template>

<style scoped>
.chat {
  margin-top: 1.5rem;
}

/* ═══════════ Join Screen ═══════════ */
.join-screen {
  text-align: center;
  padding: 1rem 0;
}
.join-icon {
  margin-bottom: .75rem;
  opacity: .8;
}
.join-screen h2 {
  font-size: 1.2rem;
  margin-bottom: .25rem;
  color: #e2e8f0;
}
.join-desc {
  color: #64748b;
  font-size: .8rem;
  margin-bottom: 1.25rem;
}
.join-form {
  display: flex;
  gap: .5rem;
}
.join-form input {
  flex: 1;
  padding: .65rem .9rem;
  border: 1px solid #334155;
  border-radius: 10px;
  background: #0f172a;
  color: #e2e8f0;
  font-size: .9rem;
  outline: none;
  transition: border-color .2s;
}
.join-form input:focus {
  border-color: #38bdf8;
}
.join-form button {
  padding: .65rem 1.4rem;
  border: none;
  border-radius: 10px;
  background: linear-gradient(135deg, #38bdf8, #818cf8);
  color: #fff;
  font-weight: 600;
  font-size: .9rem;
  cursor: pointer;
  transition: opacity .2s;
}
.join-form button:hover:not(:disabled) {
  opacity: .9;
}
.join-form button:disabled {
  opacity: .4;
  cursor: not-allowed;
}
.hint {
  color: #64748b;
  font-size: .75rem;
  margin-top: .5rem;
}

/* ═══════════ Chat Screen ═══════════ */
.chat-screen {
  display: flex;
  flex-direction: column;
  height: 460px;
  border-radius: 12px;
  overflow: hidden;
  background: #0f172a;
}

/* ═══════════ Header ═══════════ */
.chat-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: .65rem .9rem;
  background: #1a2744;
  border-bottom: 1px solid #1e3050;
}
.header-left {
  display: flex;
  align-items: center;
  gap: .6rem;
}
.header-icon {
  color: #38bdf8;
  display: flex;
}
.chat-title {
  font-weight: 600;
  font-size: .85rem;
  display: block;
  line-height: 1.2;
}
.online-count {
  font-size: .7rem;
  color: #22c55e;
  cursor: pointer;
  user-select: none;
}
.online-count:hover {
  text-decoration: underline;
}
.header-right {
  display: flex;
  align-items: center;
}
.avatar-mini {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: .6rem;
  font-weight: 700;
  color: #0f172a;
}

/* ═══════════ Online Panel ═══════════ */
.online-panel {
  background: #1a2744;
  border-bottom: 1px solid #1e3050;
  padding: .5rem .75rem;
  display: flex;
  flex-wrap: wrap;
  gap: .4rem;
}
.online-user {
  display: flex;
  align-items: center;
  gap: .35rem;
  padding: .2rem .5rem;
  background: #0f172a;
  border-radius: 16px;
  font-size: .7rem;
}
.online-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #22c55e;
}
.online-avatar {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: .5rem;
  font-weight: 700;
  color: #0f172a;
}
.online-name {
  color: #94a3b8;
}
.you-badge {
  color: #64748b;
  font-style: italic;
  font-size: .6rem;
}

/* ═══════════ Messages ═══════════ */
.messages {
  flex: 1;
  overflow-y: auto;
  padding: .6rem .75rem;
  display: flex;
  flex-direction: column;
  gap: .35rem;
}
.messages::-webkit-scrollbar { width: 4px; }
.messages::-webkit-scrollbar-track { background: transparent; }
.messages::-webkit-scrollbar-thumb { background: #1e293b; border-radius: 2px; }

.empty {
  margin: auto 0;
  text-align: center;
  color: #475569;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: .4rem;
}
.empty p {
  font-size: .85rem;
}
.empty-sub {
  font-size: .7rem !important;
  color: #334155;
}

/* System Messages */
.system-group {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: .15rem;
  margin: .4rem 0;
}
.system-msg {
  font-size: .65rem;
  color: #475569;
  font-style: italic;
  background: #1e293b55;
  padding: .15rem .6rem;
  border-radius: 10px;
}

/* Message Groups */
.msg-group {
  display: flex;
  gap: .4rem;
  max-width: 85%;
}
.msg-group.mine {
  align-self: flex-end;
  flex-direction: row-reverse;
}
.msg-group.theirs {
  align-self: flex-start;
}

.msg-avatar {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: .55rem;
  font-weight: 700;
  color: #0f172a;
  flex-shrink: 0;
  align-self: flex-end;
}

.msg-col {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.msg-user {
  font-size: .65rem;
  font-weight: 600;
  margin-left: .3rem;
  margin-bottom: 1px;
}

/* Bubbles */
.bubble {
  padding: .4rem .7rem;
  font-size: .85rem;
  line-height: 1.35;
  word-break: break-word;
  display: flex;
  align-items: flex-end;
  gap: .5rem;
  position: relative;
}
.bubble.theirs {
  background: #1e293b;
  border-radius: 4px 12px 12px 4px;
}
.bubble.theirs.first {
  border-radius: 12px 12px 12px 4px;
}
.bubble.theirs.last {
  border-radius: 4px 12px 12px 12px;
}
.bubble.theirs.first.last {
  border-radius: 12px;
}

.bubble.mine {
  background: linear-gradient(135deg, #1e3a5f, #1a2f4d);
  border-radius: 12px 4px 4px 12px;
}
.bubble.mine.first {
  border-radius: 12px 12px 4px 12px;
}
.bubble.mine.last {
  border-radius: 12px 4px 12px 12px;
}
.bubble.mine.first.last {
  border-radius: 12px;
}

.bubble-text {
  color: #e2e8f0;
  flex: 1;
}
.bubble-time {
  font-size: .55rem;
  color: #475569;
  white-space: nowrap;
  flex-shrink: 0;
}

/* ═══════════ Typing Indicator ═══════════ */
.typing-indicator {
  display: flex;
  align-items: center;
  gap: .4rem;
  font-size: .7rem;
  color: #64748b;
  padding: .2rem .4rem;
  font-style: italic;
}
.typing-dots {
  display: inline-flex;
  gap: 3px;
  align-items: center;
}
.typing-dots span {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: #64748b;
  animation: bounce 1.4s infinite ease-in-out;
}
.typing-dots span:nth-child(1) { animation-delay: 0s; }
.typing-dots span:nth-child(2) { animation-delay: .2s; }
.typing-dots span:nth-child(3) { animation-delay: .4s; }
@keyframes bounce {
  0%, 80%, 100% { transform: scale(0); opacity: .4; }
  40% { transform: scale(1); opacity: 1; }
}

/* ═══════════ Send Form ═══════════ */
.send-form {
  display: flex;
  gap: .5rem;
  padding: .6rem .75rem;
  background: #1a2744;
  border-top: 1px solid #1e3050;
}
.send-form input {
  flex: 1;
  padding: .55rem .8rem;
  border: 1px solid #293548;
  border-radius: 20px;
  background: #0f172a;
  color: #e2e8f0;
  font-size: .85rem;
  outline: none;
  transition: border-color .2s;
}
.send-form input:focus {
  border-color: #38bdf8;
}
.send-form button {
  width: 36px;
  height: 36px;
  border: none;
  border-radius: 50%;
  background: linear-gradient(135deg, #22c55e, #16a34a);
  color: #fff;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: opacity .2s, transform .1s;
}
.send-form button:hover:not(:disabled) {
  opacity: .9;
  transform: scale(1.05);
}
.send-form button:disabled {
  opacity: .3;
  cursor: not-allowed;
}

.error {
  color: #ef4444;
  text-align: center;
  margin-top: .5rem;
  font-size: .8rem;
}
</style>
