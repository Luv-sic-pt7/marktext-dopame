import { failure } from './transport'

export interface DocumentsService {
  status(): Promise<{ available: boolean; reason?: string; mode: 'proposal-preview' }>
  describe(auth: string): Promise<unknown>
  invoke(auth: string, request: unknown): Promise<unknown>
  getTask(auth: string, taskId: string): Promise<unknown>
  cancelTask(auth: string, taskId: string): Promise<unknown>
  listEvents(auth: string, cursor?: string, limit?: number): Promise<unknown>
  requestPairing(input: { name: string }): Promise<unknown>
  claimPairing(pairingId: string, claimSecret: string): Promise<unknown>
}

export interface AgentTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  execute(input: unknown): Promise<unknown>
}

/** Credentials stay in the trusted transport closure; model inputs contain only document requests. */
export function createAgentClient(service: DocumentsService, credential: string) {
  if (!credential || credential.length > 4096) throw failure('UNAUTHENTICATED', 'A paired credential is required.')
  return {
    describe: () => service.describe(credential),
    invoke: (request: unknown) => service.invoke(credential, request),
    getTask: (taskId: string) => service.getTask(credential, taskId),
    cancelTask: (taskId: string) => service.cancelTask(credential, taskId),
    listEvents: (cursor?: string, limit?: number) => service.listEvents(credential, cursor, limit),
    tools(requestSchema: Record<string, unknown>): AgentTool[] {
      return [{
        name: 'marktext_documents_invoke',
        description: 'Read an authorized snapshot or submit a draft, proposal or artifact task. This tool cannot approve or save documents.',
        inputSchema: requestSchema,
        execute: request => service.invoke(credential, request)
      }, {
        name: 'marktext_documents_get_task',
        description: 'Query the durable result of an authorized document task.',
        inputSchema: {
          type: 'object', additionalProperties: false, required: ['taskId'],
          properties: { taskId: { type: 'string', minLength: 1, maxLength: 256 } }
        },
        execute: input => {
          if (!input || typeof input !== 'object' || Array.isArray(input)
            || Object.keys(input).length !== 1 || typeof (input as { taskId?: unknown }).taskId !== 'string'
            || !(input as { taskId: string }).taskId || (input as { taskId: string }).taskId.length > 256) {
            return Promise.reject(failure('INVALID_ARGUMENT', 'Expected a taskId.'))
          }
          return service.getTask(credential, (input as { taskId: string }).taskId)
        }
      }]
    },
    registration: {
      available: false,
      reason: 'A production system Agent tool registrar and protected approval scope have not been verified.'
    }
  }
}
