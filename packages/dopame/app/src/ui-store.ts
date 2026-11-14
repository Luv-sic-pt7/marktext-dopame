import { defineStore } from 'pinia'
export const useUiStore = defineStore('marktext-workspace-view', {
  state: () => ({
    version: 0,
    searchOpen: false,
    find: '',
    replacement: '',
    matches: 0,
    matchIndex: 0,
    searchError: '',
    caseSensitive: false,
    wholeWord: false,
    regexp: false,
    mobilePanel: 'editor' as 'editor' | 'files' | 'tasks'
  }),
  actions: {
    touch() {
      this.version++
    }
  }
})
