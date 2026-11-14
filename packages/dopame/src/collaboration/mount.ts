import { createApp } from 'vue'
import CollaborationPanel from './CollaborationPanel.vue'
import type { DocumentsService } from '../../../dopame-system/src/agentClient'
import '../style.css'

export function mountCollaboration(service: DocumentsService) {
  createApp(CollaborationPanel, { service }).mount('#app')
}
