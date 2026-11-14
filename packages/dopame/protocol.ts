import Ajv from 'ajv/dist/2020.js'
import { Lexer, Tokenizer, type Tokens } from 'marked'
import getFrontMatterInfo from '../muya/src/utils/marked/frontMatter'

export const PROTOCOL = 'marktext-agent/1' as const
export const LIMITS = {
  metadata: 65536,
  artifact: 2097152,
  chunk: 65536,
  queued: 16,
  text: 2097152,
  events: 200,
  leaseMs: 12000,
  grantDepth: 8
} as const
export type TaskState =
  | 'queued'
  | 'waiting-approval'
  | 'running'
  | 'committing'
  | 'recovering'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
export interface DocumentRef {
  owner: 'marktext-dopame'
  documentId: string
  revision: number
}
export interface ArtifactRef {
  artifactId: string
  version: string
  mediaType: string
  size: number
}
export interface Edit {
  from: number
  to: number
  expectedText: string
  text: string
}
export interface TaskRequest {
  protocol: typeof PROTOCOL
  requestId: string
  capability: string
  capabilityVersion: number
  input: Record<string, any>
  deadlineAt?: string
  workflowId?: string
  parentTaskId?: string
}
export interface Fault {
  code: string
  message: string
  retryable: boolean
  details?: any
}
export type Envelope<T = any> = { ok: true; value: T } | { ok: false; error: Fault }
export class AgentError extends Error {
  code: string
  retryable: boolean
  details: any
  constructor(code: string, message: string, details?: any, retryable = false) {
    super(message)
    this.name = 'AgentError'
    this.code = code
    this.details = details
    this.retryable = retryable
  }
}
export function fail(code: string, message: string, details?: any, retryable = false): never {
  throw new AgentError(code, message, details, retryable)
}
export function fault(error: unknown): Fault {
  return error instanceof AgentError
    ? {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        ...(error.details === undefined ? {} : { details: error.details })
      }
    : { code: 'IO_ERROR', message: '操作失败，原始内容已保留', retryable: true }
}
export function unwrap<T>(v: Envelope<T>): T {
  if (!v.ok) throw new AgentError(v.error.code, v.error.message, v.error.details, v.error.retryable)
  return v.value
}
export function strict(value: any, keys: string[], required: string[] = []) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    fail('INVALID_ARGUMENT', '需要普通对象')
  for (const key of Object.keys(value))
    if (!keys.includes(key) || ['__proto__', 'constructor', 'prototype'].includes(key))
      fail('INVALID_ARGUMENT', '不允许的字段', { field: key.slice(0, 128) })
  for (const key of required)
    if (!Object.hasOwn(value, key)) fail('INVALID_ARGUMENT', '缺少字段', { field: key })
}
export function id(value: any, label = 'id', max = 128): string {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value) ||
    value.length > max
  )
    fail('INVALID_ARGUMENT', label + ' 格式无效')
  return value
}
export function integer(value: any, min: number, max: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    fail('INVALID_ARGUMENT', label + ' 超出范围')
  return value
}
export function byteLength(value: string): number {
  return new TextEncoder().encode(value).length
}
export function boundedText(value: any, label: string, max: number = LIMITS.text): string {
  if (typeof value !== 'string' || byteLength(value) > max)
    fail('INVALID_ARGUMENT', label + ' 无效或过大')
  for (let n = 0; n < value.length; n++) {
    const unit = value.charCodeAt(n)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++n)
      if (!(next >= 0xdc00 && next <= 0xdfff))
        fail('INVALID_ARGUMENT', label + ' 含有不完整的 Unicode 字符')
    } else if (unit >= 0xdc00 && unit <= 0xdfff)
      fail('INVALID_ARGUMENT', label + ' 含有不完整的 Unicode 字符')
  }
  return value
}
export function canonical(value: any): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string')
    return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  strict(value, Object.keys(value))
  return (
    '{' +
    Object.keys(value)
      .sort()
      .map((k) => JSON.stringify(k) + ':' + canonical(value[k]))
      .join(',') +
    '}'
  )
}

const str = (maxLength = 512) => ({ type: 'string', maxLength })
const obj = (properties: Record<string, any>, required: string[]) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false
})
const revision = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER }
const identifier = {
  type: 'string',
  pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]*$',
  minLength: 1,
  maxLength: 128
}
const document = obj({ owner: { const: 'marktext-dopame' }, documentId: identifier, revision }, [
  'owner',
  'documentId',
  'revision'
])
const artifact = obj(
  {
    artifactId: identifier,
    version: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    mediaType: { enum: ['text/markdown', 'text/plain', 'application/json'] },
    size: { type: 'integer', minimum: 0, maximum: LIMITS.artifact }
  },
  ['artifactId', 'version', 'mediaType', 'size']
)
const edits = {
  type: 'array',
  minItems: 1,
  maxItems: 200,
  items: obj(
    { from: revision, to: revision, expectedText: str(LIMITS.text), text: str(LIMITS.text) },
    ['from', 'to', 'expectedText', 'text']
  )
}
const docInput = { document }
const schemas: Record<string, any> = {
  'documents.list': obj(
    { limit: { type: 'integer', minimum: 1, maximum: 100 }, after: identifier },
    []
  ),
  'documents.create': {
    ...obj(
      {
        title: { type: 'string', minLength: 1, maxLength: 200 },
        markdown: str(LIMITS.text),
        artifact
      },
      ['title']
    ),
    oneOf: [
      { required: ['markdown'], not: { required: ['artifact'] } },
      { required: ['artifact'], not: { required: ['markdown'] } }
    ]
  },
  'documents.read': obj({ ...docInput, from: revision, to: revision }, ['document']),
  'documents.outline': obj(docInput, ['document']),
  'documents.patch': obj({ ...docInput, baseRevision: revision, edits }, [
    'document',
    'baseRevision',
    'edits'
  ]),
  'documents.propose': {
    ...obj(
      {
        ...docInput,
        baseRevision: revision,
        edits,
        replacement: str(LIMITS.text),
        artifact,
        reason: str(2000)
      },
      ['document', 'baseRevision']
    ),
    oneOf: [{ required: ['edits'] }, { required: ['replacement'] }, { required: ['artifact'] }]
  },
  'documents.apply': obj({ ...docInput, proposalId: identifier, expectedRevision: revision }, [
    'document',
    'proposalId',
    'expectedRevision'
  ]),
  'documents.save': obj({ ...docInput, expectedRevision: revision }, [
    'document',
    'expectedRevision'
  ]),
  'documents.export': obj(docInput, ['document'])
}
const descriptions: Record<string, string> = {
  list: '分页列出获授权文档',
  create: '创建 Markdown 文档',
  read: '读取固定版本内容',
  outline: '读取固定版本大纲',
  patch: '按 UTF-16 范围和预期文本修改',
  propose: '提交建议，不改变原文',
  apply: '按预期版本应用建议',
  save: '保存到已授权目标',
  export: '生成不可变 Markdown 产物'
}
const permissions: Record<string, string[]> = {
  list: ['read'],
  create: ['create'],
  read: ['read'],
  outline: ['read'],
  patch: ['read', 'write'],
  propose: ['read', 'propose'],
  apply: ['read', 'write', 'apply'],
  save: ['read', 'write', 'save'],
  export: ['read', 'export']
}
export const CAPABILITIES = Object.entries(schemas).map(([name, inputSchema]) => {
  const action = name.split('.')[1]
  return {
    id: name,
    version: 1,
    description: descriptions[action],
    ownerAppId: 'marktext-dopame',
    execution: {
      dependency: ['create', 'patch', 'apply', 'save'].includes(action) ? 'executor' : 'service',
      snapshotCondition: ['create', 'list'].includes(action)
        ? null
        : 'specified-published-revision',
      windowRequirement: ['create', 'patch', 'apply', 'save'].includes(action)
        ? 'target-if-executor-offline'
        : 'none',
      userInteraction: ['patch', 'apply'].includes(action)
        ? 'preauthorization-or-explicit-approval'
        : 'none'
    },
    inputSchema: { $schema: 'https://json-schema.org/draft/2020-12/schema', ...inputSchema },
    outputSchema: {
      type: 'object',
      properties: {
        taskId: identifier,
        document,
        proposal: { type: 'object' },
        artifacts: { type: 'array', items: artifact },
        summary: str(4000),
        sources: { type: 'array', items: artifact },
        documents: { type: 'array', items: { type: 'object' } },
        nextCursor: { type: ['string', 'null'] },
        text: str(LIMITS.text),
        outline: { type: 'array', items: { type: 'object' } },
        savedRevision: revision
      },
      required: ['taskId', 'artifacts', 'summary', 'sources'],
      additionalProperties: false
    },
    permissions: permissions[action],
    effects: ['create', 'patch', 'apply'].includes(action)
      ? ['document-revision']
      : action === 'save'
        ? ['authorized-file-write']
        : action === 'export'
          ? ['immutable-artifact']
          : [],
    requiresModel: false,
    cancellation: 'before-commit',
    errors: [
      'INVALID_ARGUMENT',
      'UNSUPPORTED_VERSION',
      'PERMISSION_DENIED',
      'REVISION_CONFLICT',
      'RESULT_NOT_READY',
      'RECOVERY_REQUIRED',
      'OUTCOME_UNKNOWN'
    ],
    limits: LIMITS
  }
})
const ajv = new Ajv({ allErrors: false, strict: false, ownProperties: true })
const validators = new Map(CAPABILITIES.map((c) => [c.id, ajv.compile(c.inputSchema)]))
export function validateRequest(value: any): TaskRequest {
  strict(
    value,
    [
      'protocol',
      'requestId',
      'capability',
      'capabilityVersion',
      'input',
      'deadlineAt',
      'workflowId',
      'parentTaskId'
    ],
    ['protocol', 'requestId', 'capability', 'capabilityVersion', 'input']
  )
  if (value.protocol !== PROTOCOL || value.capabilityVersion !== 1)
    fail('UNSUPPORTED_VERSION', '协议或能力版本不支持')
  id(value.requestId, 'requestId')
  if (value.workflowId !== undefined) id(value.workflowId, 'workflowId')
  if (value.parentTaskId !== undefined) id(value.parentTaskId, 'parentTaskId')
  if (value.deadlineAt !== undefined && !isIsoTime(value.deadlineAt))
    fail('INVALID_ARGUMENT', 'deadlineAt 需要有效的 ISO 时间')
  const validate = validators.get(value.capability)
  if (!validate) fail('UNSUPPORTED_VERSION', '能力不存在')
  if (!validate(value.input))
    fail(
      'INVALID_ARGUMENT',
      '能力输入不符合 schema',
      validate.errors?.map((e) => ({ path: e.instancePath, keyword: e.keyword }))
    )
  for (const name of ['title', 'markdown', 'replacement', 'reason'])
    if (typeof value.input[name] === 'string') boundedText(value.input[name], name)
  for (const edit of value.input.edits ?? []) {
    boundedText(edit.text, 'text')
    boundedText(edit.expectedText, 'expectedText')
  }
  if (byteLength(canonical(value)) > LIMITS.metadata)
    fail('INVALID_ARGUMENT', '任务元数据不能超过 64KiB；正文请通过产物上传')
  return value
}
export function isIsoTime(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value))
  )
}
export function documentRef(documentId: string, revision: number): DocumentRef {
  return { owner: 'marktext-dopame', documentId, revision }
}
export function patchText(source: string, changes: Edit[]): string {
  const sorted = [...changes].sort((a, b) => a.from - b.from || a.to - b.to)
  let end = -1
  for (const e of sorted) {
    integer(e.from, 0, source.length, 'from')
    integer(e.to, e.from, source.length, 'to')
    if (e.from < end || (e.from === end && e.from === e.to))
      fail('INVALID_ARGUMENT', '修改范围重叠')
    if (source.slice(e.from, e.to) !== e.expectedText) fail('REVISION_CONFLICT', '预期文本不匹配')
    for (const n of [e.from, e.to])
      if (
        n > 0 &&
        n < source.length &&
        /[\uD800-\uDBFF]/.test(source[n - 1]) &&
        /[\uDC00-\uDFFF]/.test(source[n])
      )
        fail('INVALID_ARGUMENT', '修改范围不能切断 Unicode 代理对')
    boundedText(e.text, '替换内容')
    end = e.to
  }
  let result = source
  for (const e of sorted.reverse()) result = result.slice(0, e.from) + e.text + result.slice(e.to)
  return boundedText(result, '修改结果')
}
/** Top-level document headings; ranges include Markdown markers and exclude the final line ending. */
export function outline(text: string) {
  const result: { level: number; text: string; from: number; to: number }[] = []
  const crlfEnds: number[] = []
  const source = text.replace(/\r\n?/g, (newline, offset: number) => {
    if (newline.length === 2) crlfEnds.push(offset - crlfEnds.length + 1)
    return '\n'
  })
  const { src: body } = getFrontMatterInfo(source)
  const starts = new WeakMap<Tokens.Heading, number>()
  class OutlineTokenizer extends Tokenizer {
    heading(src: string) {
      const token = super.heading(src)
      if (token) starts.set(token, source.length - src.length)
      return token
    }
    lheading(src: string) {
      const token = super.lheading(src)
      if (token) starts.set(token, source.length - src.length)
      return token
    }
  }
  let removedCarriages = 0
  const sourceOffset = (offset: number) => {
    while (removedCarriages < crlfEnds.length && crlfEnds[removedCarriages] <= offset)
      removedCarriages++
    return offset + removedCarriages
  }
  // Tokenizer ranges use normalized newlines; the API and editor use original UTF-16 offsets.
  for (const token of Lexer.lex(body, { gfm: true, tokenizer: new OutlineTokenizer() })) {
    if (token.type !== 'heading') continue
    const heading = token as Tokens.Heading
    const from = starts.get(heading)!
    result.push({
      level: heading.depth,
      text: heading.text.replace(/\n/g, ' '),
      from: sourceOffset(from),
      to: sourceOffset(from + heading.raw.replace(/\n+$/, '').length)
    })
  }
  return result
}
