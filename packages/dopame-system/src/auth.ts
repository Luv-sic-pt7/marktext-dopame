import { createHash, randomBytes } from 'node:crypto'

export interface ResourceScope {
  workspaceId: string
  docId?: string
  artifactId?: string
  workflowId?: string
  purpose?: string
}

export interface GrantInput {
  principalId: string
  scope: ResourceScope
  actions: string[]
  expiresAt: string
  delegationDepth?: number
}

export interface ApprovalBinding {
  action: string
  workspaceId: string
  targetId: string
  digest: string
  documentEpoch?: string
  expectedRevision?: string
  proposalDigest?: string
  proposalId?: string
  sideEffects: string[]
}

export interface ApprovalEvidence {
  ticketId: string
  principalId: string
  expiresAt: string
  policyVersion: string
  binding: ApprovalBinding
}

/** Implementations belong to a trusted host; RPC, renderer flags and DOM events cannot issue evidence. */
export interface ApprovalPort {
  verify(ticket: string, expected: ApprovalBinding): ApprovalEvidence | null
}

export function opaqueSecret() {
  return randomBytes(32).toString('base64url')
}

export function digest(value: unknown): string {
  const serialized = typeof value === 'string' ? value : canonical(value)
  return createHash('sha256').update(serialized).digest('hex')
}

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>
    return `{${Object.keys(object).sort().filter(key => object[key] !== undefined)
      .map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`
  }
  const result = JSON.stringify(value)
  if (result === undefined) throw new TypeError('Unsupported request value')
  return result
}

export function hostApprovalBinding(command: string, input: Record<string, unknown>, scope: ResourceScope, action: string) {
  const payload = { ...input }
  delete payload.ticket
  const payloadDigest = digest({ command, payload })
  const document = input.document as { documentEpoch: string; revision: string } | undefined
  const binding: ApprovalBinding = {
    action: command, workspaceId: scope.workspaceId,
    targetId: scope.docId ?? (typeof input.pairingId === 'string' ? input.pairingId : scope.workspaceId),
    digest: payloadDigest, sideEffects: [action],
    ...(document ? { documentEpoch: document.documentEpoch, expectedRevision: document.revision } : {}),
    ...(typeof input.proposalDigest === 'string' ? { proposalDigest: input.proposalDigest } : {}),
    ...(typeof input.proposalId === 'string' ? { proposalId: input.proposalId } : {}),
  }
  return { binding, payloadDigest }
}
