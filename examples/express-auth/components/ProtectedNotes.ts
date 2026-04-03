// Protected component — requires authentication
// Demonstrates: static auth, $auth.session, $private, authorize()
import { LiveComponent } from '@fluxstack/live'
import type { LiveComponentAuth, LiveActionAuthMap } from '@fluxstack/live'

interface Note { id: number; text: string; author: string; createdAt: number }

interface NotesState {
  notes: Note[]
  totalNotes: number
}

interface NotesPrivate {
  ownerId: string
}

export class ProtectedNotes extends LiveComponent<NotesState, NotesPrivate> {
  static componentName = 'ProtectedNotes'
  static publicActions = ['addNote', 'deleteNote', 'getProfile', 'adminClear'] as const
  static defaultState: NotesState = { notes: [], totalNotes: 0 }

  // Requires auth to mount
  static auth: LiveComponentAuth = { required: true }

  // Per-action auth
  static actionAuth: LiveActionAuthMap = {
    // Only the note owner can delete (custom authorize with payload)
    deleteNote: {
      authorize: (auth, payload: any) => {
        // In a real app, check if the note belongs to the user
        if (!auth.session) return false
        return true // simplified — real check would verify note.author === auth.session.id
      }
    },
    // Admin-only action with custom reason
    adminClear: {
      authorize: (auth) => {
        if (!auth.hasRole('admin')) {
          return { allowed: false, reason: 'Only admins can clear all notes' }
        }
        return true
      }
    },
  }

  protected onMount() {
    // Store owner in private state (client can't see or modify)
    this.$private.ownerId = this.$auth.session?.id || 'unknown'
  }

  async addNote(payload: { text: string }) {
    const note: Note = {
      id: Date.now(),
      text: payload.text,
      author: (this.$auth.session as any)?.name || 'Anonymous',
      createdAt: Date.now(),
    }
    this.state.notes = [...this.state.notes, note]
    this.state.totalNotes = this.state.notes.length
    return { success: true, note }
  }

  async deleteNote(payload: { noteId: number }) {
    this.state.notes = this.state.notes.filter(n => n.id !== payload.noteId)
    this.state.totalNotes = this.state.notes.length
    return { success: true }
  }

  async getProfile() {
    return {
      session: {
        id: this.$auth.session?.id,
        name: (this.$auth.session as any)?.name,
        plan: (this.$auth.session as any)?.plan,
        roles: this.$auth.session?.roles,
      },
      private: {
        ownerId: this.$private.ownerId,
      }
    }
  }

  async adminClear() {
    const count = this.state.notes.length
    this.state.notes = []
    this.state.totalNotes = 0
    return { success: true, cleared: count }
  }
}
