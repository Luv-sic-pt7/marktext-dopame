import Ajv from 'ajv'
import { limits, ProtocolError, byteLength } from '../../dopame/src/domain/collaboration'

type Schema = Record<string, unknown>
const id = { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9_.:-]*$' }
const cursor = { type: 'string', minLength: 1, maxLength: 256, pattern: '^[A-Za-z0-9_-]+$' }
const text = { type: 'string', maxLength: limits.documentBytes }
const integer = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER }
const timestamp = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?Z$' }
const page = { type: 'integer', minimum: 1, maximum: limits.eventPage }
function object(properties: Record<string, unknown>, required = Object.keys(properties)): Schema {
  return { type: 'object', properties, required, additionalProperties: false }
}
const refFields = { workspaceId: id, docId: id, documentEpoch: id, revision: { type: 'string', pattern: '^(0|[1-9][0-9]*)$', maxLength: 40 } }
const document = object(refFields)
const latestDocument = object({ ...refFields, revision: { anyOf: [refFields.revision, { const: 'latest' }] } })
const sources = { type: 'array', maxItems: 100, items: object({ uri: { type: 'string', minLength: 1, maxLength: 2048 }, label: { type: 'string', maxLength: 256 } }, ['uri']) }
const operation = { oneOf: [
  ...['replaceBlock', 'insertBeforeBlock', 'insertAfterBlock'].map(kind => object({ kind: { const: kind }, blockId: id, markdown: text })),
  object({ kind: { const: 'deleteBlock' }, blockId: id }),
  object({ kind: { const: 'insertAtStart' }, markdown: text }),
] }

export const capabilitySchemas: Record<string, Schema> = {
  'documents.list': object({ workspaceId: id, cursor, limit: page }, ['workspaceId']),
  'documents.read': object({ document: latestDocument, range: object({ start: integer, end: integer }) }, ['document']),
  'documents.outline': object({ document }),
  'documents.blocks': object({ document, cursor, limit: page }, ['document']),
  'documents.createDraft': object({ workspaceId: id, title: { type: 'string', minLength: 1, maxLength: 256 }, markdown: text, sources }, ['workspaceId', 'title', 'markdown']),
  'proposals.create': object({ base: document, operations: { type: 'array', minItems: 1, maxItems: limits.operations, items: operation }, reason: { type: 'string', minLength: 1, maxLength: 4096 }, sources }, ['base', 'operations', 'reason']),
  'proposals.get': object({ proposalId: id }),
  'proposals.list': object({ document }),
  'artifacts.export': object({ document, format: { const: 'markdown' } }),
  'artifacts.read': object({ artifactId: id, offset: integer, length: { type: 'integer', minimum: 1, maximum: limits.artifactReadBytes }, handoffId: id }, ['artifactId', 'offset', 'length']),
  'handoffs.create': object({ artifactId: id, recipientPrincipalId: id, purpose: { type: 'string', minLength: 1, maxLength: 256 }, expiresAt: timestamp }),
  'handoffs.get': object({ handoffId: id }),
  'handoffs.acknowledge': object({ handoffId: id, status: { enum: ['accepted', 'failed'] }, artifactDigest: { type: 'string', minLength: 1, maxLength: 128 } }),
}

export const protocolSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'urn:marktext:documents:1',
  ...object({
    protocol: { const: 'marktext-documents/1' },
    requestId: id,
    capability: { enum: Object.keys(capabilitySchemas) },
    capabilityVersion: { const: 1 },
    input: { type: 'object' },
    deadlineAt: timestamp,
    workflowId: id,
    parentTaskId: id,
  }, ['protocol', 'requestId', 'capability', 'capabilityVersion', 'input']),
  allOf: Object.entries(capabilitySchemas).map(([capability, schema]) => ({
    if: { properties: { capability: { const: capability } } },
    then: { properties: { input: schema } },
  })),
}

export interface RequestEnvelope {
  protocol: 'marktext-documents/1'
  requestId: string
  capability: string
  capabilityVersion: 1
  input: Record<string, unknown>
  deadlineAt?: string
  workflowId?: string
  parentTaskId?: string
}

const validate = new Ajv({ strict: true, strictRequired: false, allErrors: false }).compile(protocolSchema)

export function validateRequest(value: unknown): RequestEnvelope {
  let serialized: string | undefined
  try { serialized = JSON.stringify(value) } catch { throw new ProtocolError('INVALID_ARGUMENT', 'Request must be JSON data.') }
  if (!serialized) throw new ProtocolError('INVALID_ARGUMENT', 'Request must be a JSON object.')
  if (byteLength(serialized) > limits.requestBytes) throw new ProtocolError('PAYLOAD_TOO_LARGE', 'Request exceeds the published byte limit.')
  const candidate = value as Record<string, unknown> | null
  if (candidate && (candidate.protocol !== 'marktext-documents/1' || candidate.capabilityVersion !== 1)) {
    throw new ProtocolError('UNSUPPORTED_VERSION', 'Only marktext-documents/1 capability version 1 is supported.')
  }
  if (!validate(value)) throw new ProtocolError('INVALID_ARGUMENT', 'Request does not match the published JSON schema.')
  const request = value as RequestEnvelope
  if (request.deadlineAt && !Number.isFinite(Date.parse(request.deadlineAt))) throw new ProtocolError('INVALID_ARGUMENT', 'Invalid request deadline.')
  return request
}
