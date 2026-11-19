import { describe, expect, it } from 'vitest'

import {
  IPC_CHANNELS,
  MAX_COMMENT_QUOTE_LENGTH,
  PACT_COMPOSER_SKILLS,
  SIDE_CHAT_LIST_PAGE_BYTES,
  SIDE_CHAT_LIST_PAGE_ITEMS,
  SIDE_CHAT_QUOTE_PREVIEW_MAX_CHARS,
  SIDE_CHAT_SYNC_INLINE_BYTES,
  anchoredCommentSchema,
  createSideChatInputSchema,
  createSideChatReceiptSchema,
  cutoffMessageCommentAnchorSchema,
  diagnosticRequestTypeSchema,
  discardEmptySideChatInputSchema,
  discardEmptySideChatResultSchema,
  listSideChatsInputSchema,
  listSideChatsPageSchema,
  originSideChatSchema,
  parseComposerCommandPrefix,
  readSideChatReceiptInputSchema,
  sideChatAnchorSchema,
  sideChatCursorSchema,
  sideChatOriginSchema,
  sideChatSummarySchema,
  sideChatSyncMainInputSchema,
  sideChatSyncMainReceiptSchema,
  utf8ByteLength,
  utilityRequestSchema,
  utilityResponseSchema,
  validateSideChatMainSyncContent,
} from './index.js'

const UUID_1 = '11111111-1111-4111-8111-111111111111'
const UUID_2 = '22222222-2222-4222-8222-222222222222'
const UUID_3 = '33333333-3333-4333-8333-333333333333'
const UUID_4 = '44444444-4444-4444-8444-444444444444'
const UUID_5 = '55555555-5555-4555-8555-555555555555'
const SHA256_A = 'a'.repeat(64)
const NOW = '2026-11-19T12:00:00.000Z'

function makeSummary(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: UUID_1,
    parentSessionId: UUID_2,
    projectId: UUID_3,
    title: 'New side chat',
    origin: 'selection',
    anchorQuotePreview: 'selected quote',
    previewText: 'latest reply preview',
    status: 'idle',
    isRunning: false,
    needsAttention: false,
    hasUnread: false,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

describe('side-chat contracts', () => {
  it('validates originSideChatSchema and sideChatOriginSchema strictly', () => {
    expect(sideChatOriginSchema.parse('selection')).toBe('selection')
    expect(sideChatOriginSchema.parse('btw')).toBe('btw')
    expect(sideChatOriginSchema.safeParse('manual').success).toBe(false)

    const valid = originSideChatSchema.parse({
      sideChatId: UUID_1,
      cutoffId: UUID_2,
      sideChatTitle: 'Database notes',
    })
    expect(valid.sideChatTitle).toBe('Database notes')

    expect(
      originSideChatSchema.safeParse({
        sideChatId: UUID_1,
        cutoffId: UUID_2,
        sideChatTitle: '',
      }).success,
    ).toBe(false)
    expect(
      originSideChatSchema.safeParse({
        sideChatId: UUID_1,
        cutoffId: UUID_2,
        sideChatTitle: 'a'.repeat(241),
      }).success,
    ).toBe(false)
    expect(
      originSideChatSchema.safeParse({
        sideChatId: UUID_1,
        cutoffId: UUID_2,
        sideChatTitle: 'Title',
        extra: true,
      }).success,
    ).toBe(false)
  })

  it('validates sideChatAnchorSchema bounds and range refinement', () => {
    const valid = sideChatAnchorSchema.parse({
      messageId: UUID_1,
      quote: 'hello world',
      quotePreview: 'hello world',
      startOffset: 0,
      endOffset: 11,
    })
    expect(valid.endOffset).toBe(11)

    // endOffset must be strictly greater than startOffset
    expect(
      sideChatAnchorSchema.safeParse({
        messageId: UUID_1,
        quote: 'x',
        quotePreview: 'x',
        startOffset: 5,
        endOffset: 5,
      }).success,
    ).toBe(false)
    expect(
      sideChatAnchorSchema.safeParse({
        messageId: UUID_1,
        quote: 'x',
        quotePreview: 'x',
        startOffset: 8,
        endOffset: 4,
      }).success,
    ).toBe(false)
    expect(
      sideChatAnchorSchema.safeParse({
        messageId: UUID_1,
        quote: 'a'.repeat(MAX_COMMENT_QUOTE_LENGTH + 1),
        quotePreview: 'a',
        startOffset: 0,
        endOffset: 1,
      }).success,
    ).toBe(false)
    expect(
      sideChatAnchorSchema.safeParse({
        messageId: UUID_1,
        quote: 'a',
        quotePreview: 'a'.repeat(SIDE_CHAT_QUOTE_PREVIEW_MAX_CHARS + 1),
        startOffset: 0,
        endOffset: 1,
      }).success,
    ).toBe(false)
  })

  it('validates createSideChatInputSchema for selection and btw discriminated variants', () => {
    const selection = createSideChatInputSchema.parse({
      origin: 'selection',
      operationId: UUID_1,
      parentSessionId: UUID_2,
      messageId: UUID_3,
      quote: 'important clause',
      startOffset: 10,
      endOffset: 26,
    })
    expect(selection.origin).toBe('selection')

    const btw = createSideChatInputSchema.parse({
      origin: 'btw',
      operationId: UUID_1,
      parentSessionId: UUID_2,
      initialTitleHint: 'Quick tangent',
    })
    expect(btw.origin).toBe('btw')

    // Rejects invalid selection range
    expect(
      createSideChatInputSchema.safeParse({
        origin: 'selection',
        operationId: UUID_1,
        parentSessionId: UUID_2,
        messageId: UUID_3,
        quote: 'important clause',
        startOffset: 10,
        endOffset: 10,
      }).success,
    ).toBe(false)

    // Rejects cross-variant extra fields
    expect(
      createSideChatInputSchema.safeParse({
        origin: 'btw',
        operationId: UUID_1,
        parentSessionId: UUID_2,
        messageId: UUID_3,
      }).success,
    ).toBe(false)
  })

  it('validates sideChatSummarySchema including hasUnread default and explicit boolean', () => {
    const withoutHasUnread = makeSummary()
    delete withoutHasUnread.hasUnread
    expect(sideChatSummarySchema.parse(withoutHasUnread).hasUnread).toBe(false)

    expect(sideChatSummarySchema.parse(makeSummary({ hasUnread: true })).hasUnread).toBe(true)
    expect(sideChatSummarySchema.safeParse(makeSummary({ hasUnread: 'yes' })).success).toBe(false)
    expect(
      sideChatSummarySchema.safeParse(makeSummary({ previewText: 'x'.repeat(513) })).success,
    ).toBe(false)
    expect(sideChatSummarySchema.safeParse(makeSummary({ unknownField: 1 })).success).toBe(false)
  })

  it('validates createSideChatReceiptSchema, readSideChatReceiptInputSchema, and listSideChatsInputSchema', () => {
    const receipt = createSideChatReceiptSchema.parse({
      operationId: UUID_1,
      sideChat: makeSummary({ status: 'draft', previewText: null }),
      cutoffId: UUID_4,
      maxMessageSequence: -1,
    })
    expect(receipt.maxMessageSequence).toBe(-1)
    expect(
      createSideChatReceiptSchema.safeParse({
        operationId: UUID_1,
        sideChat: makeSummary(),
        cutoffId: UUID_4,
        maxMessageSequence: -2,
      }).success,
    ).toBe(false)

    expect(readSideChatReceiptInputSchema.parse({ operationId: UUID_1 })).toEqual({
      operationId: UUID_1,
    })

    const listDefaults = listSideChatsInputSchema.parse({ parentSessionId: UUID_2 })
    expect(listDefaults).toEqual({
      parentSessionId: UUID_2,
      direction: 'older',
      limit: SIDE_CHAT_LIST_PAGE_ITEMS,
    })
    expect(
      listSideChatsInputSchema.safeParse({
        parentSessionId: UUID_2,
        limit: SIDE_CHAT_LIST_PAGE_ITEMS + 1,
      }).success,
    ).toBe(false)

    expect(sideChatCursorSchema.parse({ createdAt: NOW, id: UUID_1 })).toEqual({
      createdAt: NOW,
      id: UUID_1,
    })
  })

  it('validates listSideChatsPageSchema including unreadCount default, item limit, and 64 KiB byte budget', () => {
    const pageWithoutUnreadCount: Record<string, unknown> = {
      parentSessionId: UUID_2,
      items: [makeSummary({ hasUnread: true })],
      nextCursor: { createdAt: NOW, id: UUID_1 },
      prevCursor: null,
      hasMoreOlder: true,
      hasMoreNewer: false,
      activeCount: 1,
      attentionCount: 0,
    }
    const parsedDefault = listSideChatsPageSchema.parse(pageWithoutUnreadCount)
    expect(parsedDefault.unreadCount).toBe(0)

    const parsedExplicit = listSideChatsPageSchema.parse({
      ...pageWithoutUnreadCount,
      unreadCount: 3,
    })
    expect(parsedExplicit.unreadCount).toBe(3)

    expect(
      listSideChatsPageSchema.safeParse({
        ...pageWithoutUnreadCount,
        unreadCount: -1,
      }).success,
    ).toBe(false)

    // Exceeding SIDE_CHAT_LIST_PAGE_ITEMS
    expect(
      listSideChatsPageSchema.safeParse({
        ...pageWithoutUnreadCount,
        items: Array.from({ length: SIDE_CHAT_LIST_PAGE_ITEMS + 1 }, () => makeSummary()),
      }).success,
    ).toBe(false)

    // Verify utf8ByteLength accounts for multi-byte UTF-8 characters
    expect(utf8ByteLength('hello')).toBe(5)
    expect(utf8ByteLength('你好😀')).toBe(10)
    expect(SIDE_CHAT_LIST_PAGE_BYTES).toBe(64 * 1024)
  })

  it('validates discardEmptySideChatInputSchema and discardEmptySideChatResultSchema', () => {
    expect(discardEmptySideChatInputSchema.parse({ sideChatId: UUID_1 })).toEqual({
      sideChatId: UUID_1,
    })
    expect(discardEmptySideChatInputSchema.safeParse({ sideChatId: 'not-a-uuid' }).success).toBe(
      false,
    )
    expect(
      discardEmptySideChatInputSchema.safeParse({ sideChatId: UUID_1, extra: 1 }).success,
    ).toBe(false)

    expect(discardEmptySideChatResultSchema.parse({ discarded: true })).toEqual({ discarded: true })
    expect(discardEmptySideChatResultSchema.parse({ discarded: false })).toEqual({
      discarded: false,
    })
    expect(discardEmptySideChatResultSchema.safeParse({ discarded: 'true' }).success).toBe(false)
  })

  it('validates sideChatSyncMainInputSchema and sideChatSyncMainReceiptSchema invariants', () => {
    const inlineValid = sideChatSyncMainInputSchema.parse({
      operationId: UUID_1,
      sideChatId: UUID_2,
      content: '  Summary for main chat  ',
      expectedCommentsRevision: 0,
    })
    expect(inlineValid.content).toBe('Summary for main chat')
    expect(inlineValid.imageIds).toEqual([])
    expect(inlineValid.commentIds).toEqual([])
    expect(inlineValid.skills).toEqual([])

    // Sealed input requires contentSha256 and empty inline content
    const sealedValid = sideChatSyncMainInputSchema.parse({
      operationId: UUID_1,
      sideChatId: UUID_2,
      inputId: UUID_3,
      contentSha256: SHA256_A,
      content: '',
      expectedCommentsRevision: 1,
    })
    expect(sealedValid.inputId).toBe(UUID_3)

    // Empty message without inputId, images, or comments is rejected
    expect(
      sideChatSyncMainInputSchema.safeParse({
        operationId: UUID_1,
        sideChatId: UUID_2,
        content: '   ',
        expectedCommentsRevision: 0,
      }).success,
    ).toBe(false)

    // Comment-only or image-only sync is accepted
    expect(
      sideChatSyncMainInputSchema.safeParse({
        operationId: UUID_1,
        sideChatId: UUID_2,
        content: '',
        commentIds: [UUID_4],
        expectedCommentsRevision: 1,
      }).success,
    ).toBe(true)
    expect(
      sideChatSyncMainInputSchema.safeParse({
        operationId: UUID_1,
        sideChatId: UUID_2,
        content: '',
        imageIds: [UUID_5],
        expectedCommentsRevision: 0,
      }).success,
    ).toBe(true)

    // Mixing inputId and inline content is rejected
    expect(
      sideChatSyncMainInputSchema.safeParse({
        operationId: UUID_1,
        sideChatId: UUID_2,
        inputId: UUID_3,
        contentSha256: SHA256_A,
        content: 'both set',
        expectedCommentsRevision: 0,
      }).success,
    ).toBe(false)

    // Missing contentSha256 when inputId is provided, or vice versa
    expect(
      sideChatSyncMainInputSchema.safeParse({
        operationId: UUID_1,
        sideChatId: UUID_2,
        inputId: UUID_3,
        content: '',
        expectedCommentsRevision: 0,
      }).success,
    ).toBe(false)
    expect(
      sideChatSyncMainInputSchema.safeParse({
        operationId: UUID_1,
        sideChatId: UUID_2,
        contentSha256: SHA256_A,
        content: 'inline with orphan digest',
        expectedCommentsRevision: 0,
      }).success,
    ).toBe(false)

    // Inline UTF-8 size limit (64 KiB)
    expect(
      sideChatSyncMainInputSchema.safeParse({
        operationId: UUID_1,
        sideChatId: UUID_2,
        content: 'a'.repeat(SIDE_CHAT_SYNC_INLINE_BYTES),
        expectedCommentsRevision: 0,
      }).success,
    ).toBe(true)
    expect(
      sideChatSyncMainInputSchema.safeParse({
        operationId: UUID_1,
        sideChatId: UUID_2,
        content: 'a'.repeat(SIDE_CHAT_SYNC_INLINE_BYTES + 1),
        expectedCommentsRevision: 0,
      }).success,
    ).toBe(false)

    // Duplicate commentIds rejected
    expect(
      sideChatSyncMainInputSchema.safeParse({
        operationId: UUID_1,
        sideChatId: UUID_2,
        content: 'note',
        commentIds: [UUID_4, UUID_4],
        expectedCommentsRevision: 1,
      }).success,
    ).toBe(false)

    // Receipt schema (sent and queued)
    expect(
      sideChatSyncMainReceiptSchema.parse({
        operationId: UUID_1,
        sideChatId: UUID_2,
        parentSessionId: UUID_3,
        cutoffId: UUID_4,
        disposition: 'sent',
        mainMessageId: UUID_5,
        queuedOperationId: null,
      }).disposition,
    ).toBe('sent')
    expect(
      sideChatSyncMainReceiptSchema.parse({
        operationId: UUID_1,
        sideChatId: UUID_2,
        parentSessionId: UUID_3,
        cutoffId: UUID_4,
        disposition: 'queued',
        mainMessageId: null,
        queuedOperationId: UUID_5,
      }).disposition,
    ).toBe('queued')
    expect(
      sideChatSyncMainReceiptSchema.safeParse({
        operationId: UUID_1,
        sideChatId: UUID_2,
        parentSessionId: UUID_3,
        cutoffId: UUID_4,
        disposition: 'failed',
        mainMessageId: null,
        queuedOperationId: null,
      }).success,
    ).toBe(false)
  })

  it('registers all side-chat diagnostic request types, IPC channels, and utility RPC schemas', () => {
    const expectedDiagnostics = [
      'side-chat.create.request',
      'side-chat.create-receipt.request',
      'side-chat.list.request',
      'side-chat.discard-empty.request',
      'side-chat.sync-main.request',
      'side-chat.sync-main-receipt.request',
    ] as const
    for (const requestType of expectedDiagnostics) {
      expect(diagnosticRequestTypeSchema.safeParse(requestType).success).toBe(true)
    }

    expect(IPC_CHANNELS.sideChatCreate).toBe('pact:side-chat:create')
    expect(IPC_CHANNELS.sideChatCreateReceipt).toBe('pact:side-chat:create-receipt')
    expect(IPC_CHANNELS.sideChatDiscardEmpty).toBe('pact:side-chat:discard-empty')
    expect(IPC_CHANNELS.sideChatList).toBe('pact:side-chat:list')
    expect(IPC_CHANNELS.sideChatSyncMain).toBe('pact:side-chat:sync-main')
    expect(IPC_CHANNELS.sideChatSyncMainReceipt).toBe('pact:side-chat:sync-main-receipt')

    // All IPC channel values remain unique
    const values = Object.values(IPC_CHANNELS)
    expect(new Set(values).size).toBe(values.length)

    // Utility request/response envelopes parse cleanly for discard-empty and list
    expect(
      utilityRequestSchema.safeParse({
        type: 'side-chat.discard-empty.request',
        requestId: UUID_1,
        input: { sideChatId: UUID_2 },
      }).success,
    ).toBe(true)
    expect(
      utilityResponseSchema.safeParse({
        type: 'side-chat.discard-empty.response',
        requestId: UUID_1,
        result: { ok: true, value: { discarded: true } },
      }).success,
    ).toBe(true)
    expect(
      utilityResponseSchema.safeParse({
        type: 'side-chat.list.response',
        requestId: UUID_1,
        result: {
          ok: true,
          value: {
            parentSessionId: UUID_2,
            items: [makeSummary({ hasUnread: true })],
            nextCursor: null,
            prevCursor: null,
            hasMoreOlder: false,
            hasMoreNewer: false,
            activeCount: 0,
            attentionCount: 0,
            unreadCount: 1,
          },
        },
      }).success,
    ).toBe(true)
  })

  it('supports cutoff_message comments with empty body and validates /btw & @Main sync prefixes', () => {
    const anchor = cutoffMessageCommentAnchorSchema.parse({
      type: 'cutoff_message',
      sourceSessionId: UUID_1,
      cutoffId: UUID_2,
      messageId: UUID_3,
      textBasis: 'markdown-visible-v2',
      quote: 'frozen snippet',
      startOffset: 0,
      endOffset: 14,
      contentSha256: SHA256_A,
    })
    expect(
      anchoredCommentSchema.safeParse({
        id: UUID_4,
        sessionId: UUID_5,
        body: '',
        anchor,
        status: 'draft',
        position: 0,
        createdAt: NOW,
        updatedAt: NOW,
      }).success,
    ).toBe(true)

    expect(PACT_COMPOSER_SKILLS).toContain('btw')
    expect(parseComposerCommandPrefix('/btw check edge case').btw).toEqual({ start: 0, end: 4 })
    expect(validateSideChatMainSyncContent('Takeaway summary')).toEqual({ ok: true })
    expect(validateSideChatMainSyncContent('/plan write plan').ok).toBe(false)
    expect(validateSideChatMainSyncContent('/btw nested').ok).toBe(false)
    expect(validateSideChatMainSyncContent('@claude inspect').ok).toBe(false)
  })
})
