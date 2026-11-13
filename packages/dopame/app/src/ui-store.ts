import { defineStore } from 'pinia'
export const useUiStore = defineStore('marktext-workspace-view', {
  state: () => ({
    version: 0,
    searchOpen: false,
    find: '',
    replacement: '',
    matches: 0,
    mobilePanel: 'editor' as 'editor' | 'files' | 'tasks'
  }),
  actions: {
    touch() {
      this.version++
    }
  }
})
