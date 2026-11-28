import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

import type {
  AgentCollaborationSourceReader,
  AgentSourceReadForm,
  AgentSourceTarget,
} from '@pact/agent-runtime'
import type { ConversationRepository, CutoffCatalogItem } from '@pact/persistence'

import {
  COLLABORATION_PAGE_BYTES,
  collaborationSourceAnyReadSchema,
  collaborationSourceAnyReferencePayloadSchema,
  collaborationSourceIndexNavigation,
  collaborationSourceReadResultSchema,
  collaborationSourceReferenceReadSchema,
  collaborationSourceWireReadSchema,
  collaborationSourceWireResultSchema,
  collaborationSourceNativeReadSchema,
  collaborationSourceNativeRootSchema,
  collaborationSourceNativeProofSchema,
  type CodexCollaborationSourceWireRead,
  type CollaborationSourceAnyRead,
  type CollaborationSourceCutoffPart,
  type CollaborationSourceCutoffTarget,
  type CollaborationSourceReadResult,
  type CollaborationSourceWireResult,
  type CollaborationSourceNativeRoot,
  type SourceReadStage,
} from '@pact/contracts'
const PAYLOAD_BYTES = 1200
const SOURCE_READ_TIMEOUT_MS = 10_000

/** Native-only closed failure facts. Original errors never cross this diagnostic seam. */
export class NativeSourceReadFailure extends Error {
  constructor(
    readonly stage: SourceReadStage,
    readonly readerEntered: boolean,
  ) {
    super(
      stage === 'original_capture'
        ? 'The original Run input Batch is unavailable.'
        : `Invalid Run source read at ${stage}.`,
    )
  }
}

function nativeStep<T>(
  enabled: boolean,
  stage: SourceReadStage,
  read: () => T,
  readerEntered = true,
): T {
  try {
    return read()
  } catch (error) {
    if (enabled && !(error instanceof NativeSourceReadFailure))
      throw new NativeSourceReadFailure(stage, readerEntered)
    throw error
  }
}

type Sources = Pick<
  ConversationRepository,
  | 'collaborationDocumentRow'
  | 'sourceDocumentAuthorized'
  | 'readPage'
  | 'readFrozenInputBatch'
  | 'readWorkflowInputs'
  | 'readRunSources'
  | 'readCutoffSource'
>

export type FrozenSourceTarget = AgentSourceTarget | CollaborationSourceCutoffTarget

function validCutoffTargetSelection(
  request: Pick<CollaborationSourceAnyRead, 'cutoffId' | 'part' | 'messageId' | 'commentId'>,
): boolean {
  if (!request.cutoffId || !request.part) return false
  if (request.part === 'catalog') {
    return request.messageId === undefined && request.commentId === undefined
  }
  if (request.part === 'comment') {
    return request.commentId !== undefined && request.messageId === undefined
  }
  return request.messageId !== undefined && request.commentId === undefined
}

function parseCutoffCatalogHeader(
  text: string,
  fallbackCutoffId: string,
): { cutoffId: string; sourceSessionId: string; maxMessageSequence: number } {
  const parsed: unknown = JSON.parse(text)
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Invalid cutoff catalog header.')
  }
  const cutoffId = Reflect.get(parsed, 'cutoffId')
  const sourceSessionId = Reflect.get(parsed, 'sourceSessionId')
  const maxMessageSequence = Reflect.get(parsed, 'maxMessageSequence')
  if (
    typeof sourceSessionId !== 'string' ||
    typeof maxMessageSequence !== 'number' ||
    !Number.isInteger(maxMessageSequence)
  ) {
    throw new Error('Invalid cutoff catalog header.')
  }
  return {
    cutoffId: typeof cutoffId === 'string' ? cutoffId : fallbackCutoffId,
    sourceSessionId,
    maxMessageSequence,
  }
}

/** One root's source reader. Repository remains the sole owner of frozen source authority. */
export class FrozenSourceReader implements AgentCollaborationSourceReader {
  readonly identity: Readonly<{ runId: string; grant: string }>
  private key: Buffer | undefined = randomBytes(32)
  private readonly cancelled = (): void => this.retire()
  private readonly authorizedCutoffs: Set<string>
  private activeRead = false

  constructor(
    identity: { runId: string; grant: string },
    private readonly sessionId: string,
    private readonly sources: Sources,
    private readonly current: () => boolean,
    private readonly defaultBatchId: () => string | undefined,
    private readonly failed?: (error: unknown) => void,
    private readonly signal?: AbortSignal,
    private readonly originalBatchId?: string,
    authorizedCutoffIds: readonly string[] = [],
  ) {
    this.identity = Object.freeze({ ...identity })
    this.authorizedCutoffs = new Set(authorizedCutoffIds)
    if (signal?.aborted) this.retire()
    else signal?.addEventListener('abort', this.cancelled, { once: true })
  }

  authorizeCutoffs(cutoffIds: readonly string[]): string[] {
    const added: string[] = []
    for (const id of cutoffIds) {
      if (id && !this.authorizedCutoffs.has(id)) {
        this.authorizedCutoffs.add(id)
        added.push(id)
      }
    }
    return added
  }

  revokeCutoffs(cutoffIds: readonly string[]): void {
    for (const id of cutoffIds) {
      if (id) this.authorizedCutoffs.delete(id)
    }
  }

  navigation(
    target: FrozenSourceTarget,
    form: AgentSourceReadForm,
  ): ReturnType<AgentCollaborationSourceReader['navigation']> {
    const native = form === 'nativeRoot'
    nativeStep(native, 'reader_current', () => this.assertCurrent())
    const request = nativeStep(native, 'navigation', () =>
      collaborationSourceAnyReadSchema.parse({ ...target, ...this.identity, offset: 0 }),
    )
    if (form === 'legacy') {
      if (request.source === 'cutoff') {
        this.explicitSelection(request)
        this.authorize(request)
      }
      return request
    }
    if (form === 'nativeRoot') {
      nativeStep(true, 'navigation', () => this.explicitSelection(request))
      this.authorize(request, true)
      return nativeStep(true, 'navigation', () =>
        collaborationSourceNativeReadSchema.parse({
          ...(request.source === 'batch' && request.batchId === this.originalBatchId
            ? { source: 'root_batch' }
            : request.source === 'cutoff'
              ? {
                  source: 'cutoff',
                  cutoffId: request.cutoffId,
                  part: request.part,
                  ...(request.messageId ? { messageId: request.messageId } : {}),
                  ...(request.commentId ? { commentId: request.commentId } : {}),
                }
              : target),
          context: 'native-root-v1',
          offset: 0,
        }),
      )
    }
    this.explicitSelection(request)
    this.authorize(request)
    const { offset: _offset, ...selection } = request
    const bytes = Buffer.from(
      JSON.stringify(
        collaborationSourceAnyReferencePayloadSchema.parse({
          version: 'pact-source-reference-v1',
          request: selection,
        }),
      ),
    )
    if (bytes.length > PAYLOAD_BYTES)
      throw new Error('Source reference payload exceeds its budget.')
    const encoded = bytes.toString('base64url')
    const signature = createHmac('sha256', this.requireKey()).update(encoded).digest('base64url')
    return collaborationSourceReferenceReadSchema.parse({
      sourceReference: `p1.${encoded}.${signature}`,
      offset: 0,
    })
  }

  read(raw: unknown): ReturnType<AgentCollaborationSourceReader['read']> {
    return this.readSelected(raw)
  }

  readNativeRoot(
    raw: unknown,
    root: CollaborationSourceNativeRoot,
  ): ReturnType<AgentCollaborationSourceReader['read']> {
    return this.readSelected(
      raw,
      nativeStep(true, 'request_parse', () => collaborationSourceNativeRootSchema.parse(root)),
    )
  }

  private readSelected(
    raw: unknown,
    nativeRoot?: CollaborationSourceNativeRoot,
  ): ReturnType<AgentCollaborationSourceReader['read']> {
    if (this.activeRead) {
      const busy = nativeRoot
        ? new NativeSourceReadFailure('page_read', true)
        : new Error('Another frozen source read is already active for this root.')
      this.failed?.(busy)
      throw busy
    }
    this.activeRead = true
    const deadline = Date.now() + SOURCE_READ_TIMEOUT_MS
    try {
      nativeStep(Boolean(nativeRoot), 'reader_current', () => this.assertCurrent())
      const native = nativeRoot
        ? nativeStep(true, 'request_parse', () => collaborationSourceNativeReadSchema.parse(raw))
        : undefined
      if (!native) collaborationSourceWireReadSchema.parse(raw)
      const submitted = native
        ? 'nativeRoot'
        : raw !== null && typeof raw === 'object' && Object.hasOwn(raw, 'sourceReference')
          ? 'sourceReference'
          : 'legacy'
      const reference =
        submitted === 'sourceReference'
          ? collaborationSourceReferenceReadSchema.parse(raw)
          : undefined
      const request = native
        ? nativeStep(true, 'request_parse', () =>
            collaborationSourceAnyReadSchema.parse({
              source:
                native.source === 'root_batch'
                  ? 'batch'
                  : native.source === 'root_document'
                    ? 'document'
                    : native.source,
              ...(native.source === 'cutoff'
                ? {
                    cutoffId: native.cutoffId,
                    part: native.part,
                    ...(native.messageId === undefined ? {} : { messageId: native.messageId }),
                    ...(native.commentId === undefined ? {} : { commentId: native.commentId }),
                  }
                : {}),
              document:
                native.source === 'root_document'
                  ? nativeStep(true, 'repository_scope', () => {
                      const batch = this.sources.readFrozenInputBatch(
                        this.identity.runId,
                        nativeStep(true, 'original_capture', () => this.requireOriginalBatch()),
                        // Header roles do not hydrate unrelated Comment members.
                        native.part === 'comment' ? native.ordinal! - 1 : Number.MAX_SAFE_INTEGER,
                        (index) => index.members.length <= 1,
                      )
                      const document =
                        native.part === 'body'
                          ? batch.body
                          : native.part === 'user_information'
                            ? batch.userInformation
                            : native.part === 'clarification_answer'
                              ? batch.clarificationAnswer
                              : batch.members.find((member) => member.ordinal === native.ordinal)
                                  ?.body
                      if (!document) throw new Error('The original Batch source is unavailable.')
                      return document
                    })
                  : native.document,
              batchId:
                native.source === 'root_batch'
                  ? nativeStep(true, 'original_capture', () => this.requireOriginalBatch())
                  : native.batchId,
              offset: native.offset,
              ...this.identity,
            }),
          )
        : reference
          ? this.resolveReference(reference.sourceReference, reference.offset)
          : collaborationSourceAnyReadSchema.parse(raw)
      if (native || request.source === 'cutoff')
        nativeStep(Boolean(native), 'request_parse', () => this.explicitSelection(request))
      this.authorize(request, Boolean(native))
      const cutoffPart: CollaborationSourceCutoffPart | undefined =
        request.source === 'cutoff' ? request.part : undefined
      const binding: CollaborationSourceWireResult['binding'] = {
        submitted,
        callerRunId: this.identity.runId,
        grantSha256: this.sha256(this.identity.grant),
        referenceSha256: reference ? this.sha256(reference.sourceReference) : null,
        ...(nativeRoot ? { nativeRoot } : {}),
      }
      const wire = (page: CollaborationSourceReadResult): CollaborationSourceWireResult => ({
        ...page,
        ...collaborationSourceIndexNavigation(page.source, page.text, cutoffPart),
        binding,
        ...(page.nextOffset === null
          ? {}
          : {
              nextRead: native
                ? { ...native, offset: page.nextOffset }
                : reference
                  ? { ...reference, offset: page.nextOffset }
                  : { ...request, offset: page.nextOffset },
            }),
      })
      const fits = (page: CollaborationSourceReadResult): boolean =>
        nativeStep(Boolean(native), 'page_budget', () => {
          if (Date.now() > deadline) {
            throw new Error('Reading the frozen source timed out.')
          }
          const wirePage = wire(page)
          const nativeProof = nativeRoot
            ? collaborationSourceNativeProofSchema.parse({
                version: 'pact-native-source-root-v1',
                root: nativeRoot,
                callerRunId: this.identity.runId,
                grantSha256: this.sha256(this.identity.grant),
                requestSha256: '0'.repeat(64),
                pageSha256: '0'.repeat(64),
              })
            : undefined
          if (
            Buffer.byteLength(
              JSON.stringify(nativeProof ? { page: wirePage, proof: nativeProof } : wirePage),
            ) > COLLABORATION_PAGE_BYTES
          ) {
            return false
          }
          const mcpEnvelope = {
            jsonrpc: '2.0',
            id: '0'.repeat(64),
            result: {
              content: [{ type: 'text', text: JSON.stringify(wirePage) }],
              ...(nativeProof ? { _meta: { pactSourceRoot: nativeProof } } : {}),
            },
          }
          return Buffer.byteLength(JSON.stringify(mcpEnvelope)) <= COLLABORATION_PAGE_BYTES
        })
      const readDocument = (document: NonNullable<CollaborationSourceAnyRead['document']>) =>
        nativeStep(Boolean(native), 'navigation', () =>
          this.navigation({ source: 'document', document }, submitted),
        )
      const readBatch = (batchId: string) =>
        nativeStep(Boolean(native), 'navigation', () =>
          this.navigation({ source: 'batch', batchId }, submitted),
        )
      const readCutoff = (target: CollaborationSourceCutoffTarget) =>
        nativeStep(Boolean(native), 'navigation', () => this.navigation(target, submitted))
      let page: CollaborationSourceReadResult
      if (request.source === 'document') {
        const document = request.document!
        const row = nativeStep(Boolean(native), 'page_read', () =>
          this.sources.collaborationDocumentRow(this.sessionId, document),
        )
        const original = nativeStep(Boolean(native), 'page_read', () =>
          this.sources.readPage({
            scope: 'collaboration-text',
            sessionId: this.sessionId,
            runId: row.sourceRunId ?? this.identity.runId,
            document,
            offset: request.offset,
          }),
        )
        if (original.scope !== 'collaboration-text' || original.offset !== request.offset)
          throw native
            ? new NativeSourceReadFailure('page_validation', true)
            : new Error('The document source changed.')
        let text = original.text.slice(0, 4096)
        if (text.length < original.text.length && /[\uD800-\uDBFF]/u.test(text.at(-1)!))
          text = text.slice(0, -1)
        page = {
          source: request.source,
          document,
          text,
          offset: request.offset,
          nextOffset:
            request.offset + text.length < document.chars ? request.offset + text.length : null,
        }
      } else if (request.source === 'batch') {
        const readPart = (
          document: NonNullable<CollaborationSourceAnyRead['document']>,
          part: 'body' | 'user_information' | 'clarification_answer' | 'comment',
          ordinal?: number,
        ) => {
          const explicit = readDocument(document)
          return native && request.batchId === this.originalBatchId
            ? collaborationSourceNativeReadSchema.parse({
                context: 'native-root-v1',
                source: 'root_document',
                part,
                ...(ordinal === undefined ? {} : { ordinal }),
                offset: 0,
              })
            : explicit
        }
        const project = (index: ReturnType<Sources['readFrozenInputBatch']>) => ({
          source: request.source,
          offset: request.offset,
          nextOffset: index.hasMore ? index.nextOrdinal + 1 : null,
          text: JSON.stringify({
            ...index,
            ...(index.body ? { bodyRead: readPart(index.body, 'body') } : {}),
            ...(index.userInformation
              ? { userInformationRead: readPart(index.userInformation, 'user_information') }
              : {}),
            ...(index.clarificationAnswer
              ? {
                  clarificationAnswerRead: readPart(
                    index.clarificationAnswer,
                    'clarification_answer',
                  ),
                }
              : {}),
            members: index.members.map((member) => ({
              ...member,
              bodyRead: readPart(member.body, 'comment', member.ordinal),
            })),
          }),
        })
        page = project(
          nativeStep(Boolean(native), 'page_read', () =>
            this.sources.readFrozenInputBatch(
              request.runId,
              request.batchId ?? this.defaultBatchId()!,
              request.offset - 1,
              (index) => fits(project(index)),
            ),
          ),
        )
      } else if (request.source === 'inputs') {
        const project = (index: ReturnType<Sources['readWorkflowInputs']>) => ({
          source: request.source,
          offset: request.offset,
          nextOffset: index.nextOffset,
          text: JSON.stringify({
            ...index,
            items: index.items.map((item) => ({
              ...item,
              batchRead: readBatch(item.batch.id),
              ...(item.body ? { bodyRead: readDocument(item.body) } : {}),
            })),
          }),
        })
        page = project(
          nativeStep(Boolean(native), 'page_read', () =>
            this.sources.readWorkflowInputs(request.runId, request.offset, (index) =>
              fits(project(index)),
            ),
          ),
        )
      } else if (request.source === 'cutoff') {
        const cutoffId = request.cutoffId!
        const part = request.part!
        const project = (index: {
          offset: number
          nextOffset: number | null
          text: string
          items?: CutoffCatalogItem[]
        }): CollaborationSourceReadResult => {
          if (part === 'comments') {
            const parsed: unknown = JSON.parse(index.text)
            if (
              !parsed ||
              typeof parsed !== 'object' ||
              !Array.isArray(Reflect.get(parsed, 'items'))
            ) {
              throw new Error('Invalid cutoff comments index.')
            }
            const rawItemsValue =
              typeof parsed === 'object' && parsed !== null && 'items' in parsed
                ? parsed.items
                : undefined
            const rawItems: Record<string, unknown>[] = Array.isArray(rawItemsValue)
              ? rawItemsValue.filter(
                  (entry): entry is Record<string, unknown> =>
                    typeof entry === 'object' && entry !== null,
                )
              : []
            const projectedItems: Record<string, unknown>[] = []
            for (const item of rawItems) {
              const commentId = item.commentId
              if (typeof commentId !== 'string') {
                projectedItems.push(item)
                continue
              }
              projectedItems.push(
                Object.assign({}, item, {
                  commentRead: readCutoff({
                    source: 'cutoff',
                    cutoffId,
                    part: 'comment',
                    commentId,
                  }),
                }),
              )
            }
            return {
              source: 'cutoff',
              text: JSON.stringify({
                ...parsed,
                items: projectedItems,
              }),
              offset: index.offset,
              nextOffset: index.nextOffset,
            }
          }
          if (part !== 'catalog') {
            return {
              source: 'cutoff',
              text: index.text,
              offset: index.offset,
              nextOffset: index.nextOffset,
            }
          }
          const header = parseCutoffCatalogHeader(index.text, cutoffId)
          const items = (index.items ?? []).map((item) => {
            const messageRead = readCutoff({
              source: 'cutoff',
              cutoffId: header.cutoffId,
              part: 'message',
              messageId: item.messageId,
            })
            if (!item.hasComments) {
              return Object.assign({}, item, { messageRead })
            }
            return Object.assign({}, item, {
              messageRead,
              commentsRead: readCutoff({
                source: 'cutoff',
                cutoffId: header.cutoffId,
                part: 'comments',
                messageId: item.messageId,
              }),
            })
          })
          return {
            source: 'cutoff',
            text: JSON.stringify({
              ...header,
              items,
            }),
            offset: index.offset,
            nextOffset: index.nextOffset,
          }
        }
        page = project(
          nativeStep(Boolean(native), 'page_read', () =>
            this.sources.readCutoffSource(
              {
                cutoffId,
                part,
                ...(request.messageId ? { messageId: request.messageId } : {}),
                ...(request.commentId ? { commentId: request.commentId } : {}),
                offset: request.offset,
              },
              (index) => fits(project(index)),
            ),
          ),
        )
      } else {
        const project = (index: ReturnType<Sources['readRunSources']>) => ({
          source: request.source,
          offset: request.offset,
          nextOffset: index.nextOffset,
          text: JSON.stringify({
            ...index,
            items: index.items.map((item) => ({
              ...item,
              documents: item.documents.map((entry) => ({
                ...entry,
                read: readDocument(entry.source),
              })),
              ...(item.inputBatchRef ? { batchRead: readBatch(item.inputBatchRef.id) } : {}),
            })),
          }),
        })
        page = project(
          nativeStep(Boolean(native), 'page_read', () =>
            this.sources.readRunSources(request.runId, request.offset, (index) =>
              fits(project(index)),
            ),
          ),
        )
      }
      const result = nativeStep(Boolean(native), 'page_validation', () =>
        collaborationSourceWireResultSchema.parse(wire(page)),
      )
      if (!fits(page))
        nativeStep(Boolean(native), 'page_budget', () => {
          throw new Error('The source page and its proof exceed the page budget.')
        })
      if (result.nextOffset !== null && result.nextOffset <= result.offset)
        nativeStep(Boolean(native), 'cursor', () => {
          throw new Error('The frozen source cursor did not advance.')
        })
      return { submitted, request, page: result }
    } catch (error) {
      this.failed?.(error)
      throw error
    } finally {
      this.activeRead = false
    }
  }

  retire(): void {
    this.signal?.removeEventListener('abort', this.cancelled)
    this.key?.fill(0)
    this.key = undefined
  }

  private assertCurrent(): void {
    if (!this.key || !this.current())
      throw new Error('The source reader belongs to a retired Turn.')
  }

  private requireOriginalBatch(): string {
    nativeStep(true, 'reader_current', () => this.assertCurrent())
    if (!this.originalBatchId) throw new Error('The original Run input Batch is unavailable.')
    return this.originalBatchId
  }

  private requireKey(): Buffer {
    this.assertCurrent()
    return this.key!
  }

  private explicitSelection(request: CollaborationSourceAnyRead): void {
    if (
      request.source === 'document'
        ? !request.document ||
          request.batchId !== undefined ||
          request.cutoffId !== undefined ||
          request.part !== undefined ||
          request.messageId !== undefined ||
          request.commentId !== undefined
        : request.source === 'batch'
          ? !request.batchId ||
            request.document !== undefined ||
            request.cutoffId !== undefined ||
            request.part !== undefined ||
            request.messageId !== undefined ||
            request.commentId !== undefined
          : request.source === 'cutoff'
            ? request.document !== undefined ||
              request.batchId !== undefined ||
              !validCutoffTargetSelection(request)
            : request.document !== undefined ||
              request.batchId !== undefined ||
              request.cutoffId !== undefined ||
              request.part !== undefined ||
              request.messageId !== undefined ||
              request.commentId !== undefined
    )
      throw new Error('A source reference requires its exact explicit selection.')
  }

  private authorize(request: CollaborationSourceAnyRead, native = false): void {
    nativeStep(native, 'reader_current', () => this.assertCurrent())
    nativeStep(native, 'repository_scope', () => {
      if (request.runId !== this.identity.runId || request.grant !== this.identity.grant)
        throw new Error('This source capability does not belong to the current root.')
      if (request.source === 'document') {
        if (!request.document) throw new Error('Supply the frozen document reference.')
        this.sources.collaborationDocumentRow(this.sessionId, request.document)
        if (!this.sources.sourceDocumentAuthorized(request.runId, request.document))
          throw new Error('The document is outside this Run authorization.')
      } else if (request.source === 'batch') {
        const batchId = request.batchId ?? this.defaultBatchId()
        if (!batchId) throw new Error('The frozen input Batch is unavailable.')
        this.sources.readFrozenInputBatch(request.runId, batchId, -1)
      } else if (request.source === 'inputs')
        this.sources.readWorkflowInputs(request.runId, request.offset)
      else if (request.source === 'cutoff') {
        if (!validCutoffTargetSelection(request) || !this.authorizedCutoffs.has(request.cutoffId!))
          throw new Error('The cutoff source is outside this Run authorization.')
      } else this.sources.readRunSources(request.runId, request.offset)
    })
  }

  private resolveReference(sourceReference: string, offset: number): CollaborationSourceAnyRead {
    const parts = /^p1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/u.exec(sourceReference)
    if (!parts) throw new Error('Source reference encoding is unavailable.')
    const encoded = parts[1]!
    const signature = Buffer.from(parts[2]!, 'base64url')
    const expected = createHmac('sha256', this.requireKey()).update(encoded).digest()
    if (
      signature.toString('base64url') !== parts[2] ||
      signature.length !== expected.length ||
      !timingSafeEqual(signature, expected)
    )
      throw new Error('Source reference authentication failed.')
    const bytes = Buffer.from(encoded, 'base64url')
    if (bytes.length > PAYLOAD_BYTES || bytes.toString('base64url') !== encoded)
      throw new Error('Source reference payload is invalid.')
    const payload = collaborationSourceAnyReferencePayloadSchema.parse(
      JSON.parse(bytes.toString('utf8')),
    )
    const request = collaborationSourceAnyReadSchema.parse({ ...payload.request, offset })
    this.explicitSelection(request)
    return request
  }

  private sha256(value: string): string {
    return createHash('sha256').update(value).digest('hex')
  }
}

/** Shared transport seam; submitted arguments reach the borrowed owner without normalization. */
function readSourceTool(
  identity: { runId: string; grant: string },
  raw: unknown,
  reader: AgentCollaborationSourceReader | undefined,
  legacyRead: ((input: unknown) => CollaborationSourceReadResult) | undefined,
  authenticatedNativeRoot?: CollaborationSourceNativeRoot,
): CollaborationSourceReadResult | CollaborationSourceWireResult {
  let request: CollaborationSourceAnyRead
  let page: CollaborationSourceReadResult | CollaborationSourceWireResult
  if (reader) {
    if (reader.identity.runId !== identity.runId || reader.identity.grant !== identity.grant)
      nativeStep(
        Boolean(authenticatedNativeRoot),
        'page_validation',
        () => {
          throw new Error('The source reader does not belong to this root.')
        },
        false,
      )
    const result = authenticatedNativeRoot
      ? nativeStep(true, 'unknown', () => reader.readNativeRoot?.(raw, authenticatedNativeRoot))
      : reader.read(raw)
    if (!result)
      nativeStep(
        Boolean(authenticatedNativeRoot),
        'page_validation',
        () => {
          throw new Error('Authenticated native source reads are unavailable.')
        },
        false,
      )
    if (!result) throw new Error('Authenticated native source reads are unavailable.')
    request = result.request
    const wirePage = nativeStep(Boolean(authenticatedNativeRoot), 'page_validation', () =>
      collaborationSourceWireResultSchema.parse(result.page),
    )
    page = wirePage
    if (
      wirePage.binding.submitted !== result.submitted ||
      wirePage.binding.callerRunId !== identity.runId ||
      wirePage.binding.grantSha256 !== createHash('sha256').update(identity.grant).digest('hex') ||
      (authenticatedNativeRoot &&
        (wirePage.binding.submitted !== 'nativeRoot' ||
          wirePage.binding.nativeRoot?.threadId !== authenticatedNativeRoot.threadId ||
          wirePage.binding.nativeRoot.turnId !== authenticatedNativeRoot.turnId))
    )
      nativeStep(Boolean(authenticatedNativeRoot), 'page_validation', () => {
        throw new Error('The source page binding does not match this reader.')
      })
  } else {
    request = collaborationSourceAnyReadSchema.parse(raw)
    if (!legacyRead) throw new Error('The source reader is unavailable.')
    if (request.runId !== identity.runId || request.grant !== identity.grant)
      throw new Error('This source capability does not belong to the current root.')
    page = collaborationSourceReadResultSchema.parse(legacyRead(raw))
  }
  if (
    request.runId !== identity.runId ||
    request.grant !== identity.grant ||
    page.source !== request.source ||
    page.offset !== request.offset ||
    (page.nextOffset !== null && page.nextOffset <= page.offset) ||
    (request.source === 'document' &&
      (!request.document ||
        page.document?.id !== request.document.id ||
        page.document.sha256 !== request.document.sha256 ||
        page.document.bytes !== request.document.bytes ||
        page.document.chars !== request.document.chars))
  )
    nativeStep(Boolean(authenticatedNativeRoot), 'page_validation', () => {
      throw new Error('The frozen source page does not match this request.')
    })
  return page
}

/** Build an authenticated cutoff catalog navigator when the run owns a `FrozenSourceReader`. */
export function cutoffSourceNavigator(
  reader: AgentCollaborationSourceReader | undefined,
  form: AgentSourceReadForm,
): ((cutoffId: string) => CodexCollaborationSourceWireRead) | undefined {
  return reader instanceof FrozenSourceReader
    ? (cutoffId) => reader.navigation({ source: 'cutoff', cutoffId, part: 'catalog' }, form)
    : undefined
}

/** Shared legacy/P1 transport entry never admits native-root arguments. */
export function readFrozenSourceTool(
  identity: { runId: string; grant: string },
  raw: unknown,
  reader: AgentCollaborationSourceReader | undefined,
  legacyRead: ((input: unknown) => CollaborationSourceReadResult) | undefined,
): CollaborationSourceReadResult | CollaborationSourceWireResult {
  return readSourceTool(identity, raw, reader, legacyRead)
}

/** Only the MCP owner may call this after validating its ACKed Root receipt and Native metadata. */
export function readNativeFrozenSourceTool(
  identity: { runId: string; grant: string },
  raw: unknown,
  reader: AgentCollaborationSourceReader,
  root: CollaborationSourceNativeRoot,
): CollaborationSourceWireResult {
  return nativeStep(true, 'page_validation', () =>
    collaborationSourceWireResultSchema.parse(
      readSourceTool(identity, raw, reader, undefined, root),
    ),
  )
}
