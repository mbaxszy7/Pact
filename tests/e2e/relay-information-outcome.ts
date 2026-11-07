const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const monthNames =
  '(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec)'

/** Explicit unambiguous calendar forms only; no locale-dependent Date.parse. */
function calendarDates(text: string): string[] {
  const values = new Set<string>(),
    add = (year: string, month: string | number, day: string) =>
      values.add(`${year}-${String(month).padStart(2, '0')}-${day.padStart(2, '0')}`)
  for (const match of text.matchAll(/\b(\d{4})[-/](\d{1,2})[-/](\d{1,2})\b/gu))
    add(match[1]!, match[2]!, match[3]!)
  for (const match of text.matchAll(/(\d{4})\u5E74\s*(\d{1,2})\u6708\s*(\d{1,2})\u65E5/gu))
    add(match[1]!, match[2]!, match[3]!)
  for (const match of text.matchAll(
    new RegExp(`\\b${monthNames}\\s+(\\d{1,2})(?:st|nd|rd|th)?[,]?\\s+(\\d{4})\\b`, 'giu'),
  ))
    add(match[3]!, months.indexOf(match[1]!.slice(0, 3).toLowerCase()) + 1, match[2]!)
  for (const match of text.matchAll(
    new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${monthNames}[,]?\\s+(\\d{4})\\b`, 'giu'),
  ))
    add(match[3]!, months.indexOf(match[2]!.slice(0, 3).toLowerCase()) + 1, match[1]!)
  return [...values]
}

/** Task-specific acceptance for the preregistered short cancellation release-note scenario. */
export function releaseNoteBusinessOutcome(text: string, date: string | null) {
  const content = text.trim(),
    dates = calendarDates(content),
    question = /[?\uFF1F]/u.test(content),
    questionCount = (content.match(/[?\uFF1F]/gu) ?? []).length,
    asksForDate =
      /\b(?:what|which|when)\b[^\n.!]{0,90}\b(?:date|launch)\b|\b(?:please|could you|can you)\b[^\n.!]{0,90}\b(?:date|launch)\b|\b(?:need|awaiting|waiting for)\b[^\n.!]{0,40}\b(?:your|the)\s+(?:launch\s+)?date\b/iu.test(
        content,
      ),
    statements = content.split(/\n\s*\n|(?<=[.!\u3002\uFF01])\s+/u),
    deliverable = statements
      .filter(
        (part) =>
          !/^\s*(?:I(?:['\u2019]ll| will| am going to)|let me|we(?:['\u2019]ll| will))\b[^\n]{0,180}\b(?:read|draft|prepare|write|generate)\b/iu.test(
            part,
          ),
      )
      .filter(
        (part) =>
          !/^\s*I\s+(?:cannot|can't|am unable to)\b[^\n]{0,100}\b(?:write|draft|prepare|generate)\b/iu.test(
            part,
          ),
      )
      .join('\n')
  const boundary =
      /\bcancel\w*\b[^.!?\n]{0,100}\bboundar(?:y|ies)\b|\bboundar(?:y|ies)\b[^.!?\n]{0,100}\bcancel\w*\b|\u53D6\u6D88[^\n]{0,20}\u8FB9\u754C/iu,
    otherDecision = /\b(?:which|what)\s+(?:permission|model|agent|workflow|tool|scope)\b/iu.test(
      content,
    ),
    prematureNote =
      /\brelease[ -]note\s*[:\u2014-]/iu.test(content) ||
      (deliverable.match(/[^.!?\u3002\uFF01\uFF1F]+[.!?\u3002\uFF01\uFF1F]?/gu) ?? []).some(
        (part) =>
          boundary.test(part) &&
          !/[?\uFF1F]\s*$/u.test(part) &&
          !/\b(?:please|provide|supply|need|what|which|when)\b[^\n]{0,90}\bdate\b/iu.test(part),
      )
  if (date === null) {
    const checks = {
      asksOnlyForMissingDate: asksForDate || (question && /\bdate\b/iu.test(content)),
      doesNotInventDate: dates.length === 0,
      asksNoOtherDecision: !otherDecision && questionCount <= 1,
      doesNotDraftBeforeUserValue: !prematureNote,
      actualShortAnswerCaptured: content.length > 0 && content.length <= 2048,
    }
    return {
      expected: 'request_missing_date' as const,
      checks,
      passed: Object.values(checks).every(Boolean),
    }
  }
  const checks = {
    usesConfirmedDate: calendarDates(deliverable).includes(date),
    preservesAgreedScope: boundary.test(deliverable),
    doesNotAlterExistingBoundary:
      !/\b(?:cancel\w*|boundar(?:y|ies))\b[^.!?\n]{0,100}\b(?:disabled|removed|eliminated|expanded|replaced|redefined)\b|\b(?:disable|remove|eliminate|expand|replace|redefine)(?:d|s)?\b[^.!?\n]{0,100}\b(?:cancel\w*|boundar(?:y|ies))\b/iu.test(
        deliverable.replace(
          /\bnot\s+(?:(?:be|been|being|now|ever)\s+)?(?:disabled|removed|eliminated|expanded|replaced|redefined|disable|remove|eliminate|expand|replace|redefine)\b/giu,
          'unchanged',
        ),
      ),
    completesRequestedNote:
      !/\bI\s+(?:cannot|can't|could not|am unable to)\s+(?:produce|complete|write|draft|finali[sz]e|confirm)\b[^.!?\n]{0,140}\b(?:release[ -]note|final note|draft|agreed scope)\b|\b(?:only|merely|just)\s+(?:a\s+)?(?:provisional|tentative)\s+draft\b|\b(?:draft|note)\b[^.!?\n]{0,80}\b(?:would be|is|remains)\s+(?:only\s+)?(?:provisional|tentative)\b/iu.test(
        content,
      ) &&
      !/\b(?:paste|provide|supply|refresh)\b[^.!?\n]{0,120}\b(?:body|scope|source|reference)\b[^.!?\n]{0,180}\b(?:so I can|I(?:['\u2019]ll| will)|to)\s+(?:write|draft|complete|produce|finali[sz]e)\b/iu.test(
        content,
      ),
    noFurtherQuestion: !question && !asksForDate,
    doesNotSubstituteDate: dates.length > 0 && dates.every((value) => value === date),
    actualShortAnswerCaptured: content.length > 0 && content.length <= 2048,
  }
  return {
    expected: 'deliver_release_note' as const,
    checks,
    passed: Object.values(checks).every(Boolean),
  }
}
