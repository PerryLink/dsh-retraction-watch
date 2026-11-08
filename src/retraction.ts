/**
 * Retraction/correction status logic.
 *
 * Two verified Crossref queries back this plugin:
 * 1. `GET /works/{doi}` — the cited work itself. If the record carries
 *    `update-to` entries, the DOI *is* an update notice.
 * 2. `GET /works?filter=updates:{doi}` — works that update the cited DOI. This
 *    filter was verified against the live API on 2026-11-08 (HTTP 200 for a
 *    valid DOI, HTTP 400 for the non-existent `update-to` filter). Notices
 *    carry `update-to: [{ type: 'retraction' | 'correction' | …, DOI: … }]`.
 *
 * Status is about *registered notices*, never about truth: "clear" means
 * "Crossref has no update notice for this DOI", not "this paper is valid".
 *
 * @module dsh-retraction-watch/retraction
 */

import { stableId, type CheckResult } from '@perrylink/dsh-research-core'

/** Notice kinds recognized by Crossref's `update-to.type`. */
export type NoticeKind = 'retraction' | 'correction' | 'expression_of_concern' | 'other'

/** Aggregate status of one DOI. */
export type RetractionStatus = 'retracted' | 'concern' | 'corrected' | 'notice' | 'clear' | 'unknown'

/** One registered notice about the cited work. */
export interface Notice {
  /** The notice's own DOI. */
  readonly doi: string
  readonly title?: string
  readonly kind: NoticeKind
  /** Raw `update-to.type`. */
  readonly rawType: string
  /** Publication year of the notice, when known. */
  readonly year?: number
  readonly url?: string
}

/** The result of checking one DOI. */
export interface RetractionCheck {
  readonly doi: string
  readonly status: RetractionStatus
  /** True when the DOI itself is an update notice about other works. */
  readonly isNotice: boolean
  readonly notices: readonly Notice[]
  readonly checks: readonly CheckResult[]
  /** The provider responses worth snapshotting. */
  readonly snapshots: readonly { readonly kind: 'work' | 'updates'; readonly body: string; readonly url: string }[]
  readonly warnings: readonly string[]
}

/** Map a raw `update-to.type` to the plugin vocabulary. */
export function noticeKindOf(rawType: string): NoticeKind {
  const value = rawType.toLowerCase().replace(/[\s-]+/gu, '_')
  if (value.includes('retract')) return 'retraction'
  if (value.includes('correction') || value === 'corrigendum' || value === 'erratum') return 'correction'
  if (value.includes('concern')) return 'expression_of_concern'
  return 'other'
}

/** Extract notices that point at `doi` from a work-list response. */
export function noticesFromList(body: string, doi: string): Notice[] {
  const parsed = JSON.parse(body) as { message?: { items?: Array<Record<string, unknown>> } }
  const items = parsed.message?.items ?? []
  const notices: Notice[] = []
  for (const item of items) {
    const updateTo = Array.isArray(item['update-to']) ? (item['update-to'] as Record<string, unknown>[]) : []
    const relevant = updateTo.filter(update => typeof update['DOI'] === 'string' && update['DOI'].toLowerCase() === doi.toLowerCase())
    if (relevant.length === 0) continue
    const titles = item['title']
    const issued = item['issued'] as { 'date-parts'?: number[][] } | undefined
    for (const update of relevant) {
      const rawType = typeof update['type'] === 'string' ? update['type'] : 'other'
      notices.push({
        doi: typeof item['DOI'] === 'string' ? item['DOI'] : '(unknown)',
        ...(Array.isArray(titles) && typeof titles[0] === 'string' ? { title: titles[0] } : {}),
        kind: noticeKindOf(rawType),
        rawType,
        ...(issued?.['date-parts']?.[0]?.[0] === undefined ? {} : { year: issued['date-parts'][0]![0] }),
        ...(typeof item['URL'] === 'string' ? { url: item['URL'] } : {}),
      })
    }
  }
  return notices
}

/** Extract the targets of a work that is itself a notice. */
export function noticeTargets(body: string): Array<{ doi: string; kind: NoticeKind; rawType: string }> {
  const parsed = JSON.parse(body) as { message?: Record<string, unknown> }
  const updateTo = Array.isArray(parsed.message?.['update-to']) ? (parsed.message!['update-to'] as Record<string, unknown>[]) : []
  return updateTo
    .filter(update => typeof update['DOI'] === 'string')
    .map(update => {
      const rawType = typeof update['type'] === 'string' ? update['type'] : 'other'
      return { doi: update['DOI'] as string, kind: noticeKindOf(rawType), rawType }
    })
}

/** Derive the aggregate status from notices. */
export function statusOf(notices: readonly Notice[]): RetractionStatus {
  if (notices.some(notice => notice.kind === 'retraction')) return 'retracted'
  if (notices.some(notice => notice.kind === 'expression_of_concern')) return 'concern'
  if (notices.some(notice => notice.kind === 'correction')) return 'corrected'
  if (notices.length > 0) return 'notice'
  return 'clear'
}

/** Build the check results for one DOI. */
export function checksOf(input: {
  doi: string
  exists: boolean
  status: RetractionStatus
  notices: readonly Notice[]
  isNotice: boolean
  networkError?: string
}): CheckResult[] {
  const subject = input.doi
  const digest = (key: string, status: string): string => `chk-${key}-${stableId('chk', [subject, key, status]).slice(-6)}`
  const checks: CheckResult[] = []
  checks.push({
    checkId: digest('exists', input.exists ? 'pass' : 'skipped'),
    check: 'doi-exists',
    status: input.exists ? 'pass' : 'skipped',
    ...(input.exists ? {} : { code: 'not_found' as const }),
    severity: input.exists ? 'info' : 'warning',
    detail: input.exists
      ? 'Crossref returned the work record'
      : 'Crossref has no record for this DOI; not_found is not evidence of fabrication and not evidence of cleanliness',
  })
  if (input.networkError !== undefined) {
    checks.push({
      checkId: digest('source-status', 'skipped'),
      check: 'source-status',
      status: 'skipped',
      code: 'network_error',
      severity: 'warning',
      detail: `the update-notice query failed: ${input.networkError}; the status stays unknown`,
    })
    return checks
  }
  if (input.status === 'unknown') return checks
  const statusMap: Record<Exclude<RetractionStatus, 'unknown'>, { status: CheckResult['status']; severity: 'info' | 'warning' | 'error'; detail: string }> = {
    retracted: { status: 'fail', severity: 'error', detail: `Crossref has a registered retraction notice (${input.notices.map(notice => notice.doi).join(', ')})` },
    concern: { status: 'fail', severity: 'error', detail: `Crossref has an expression of concern (${input.notices.map(notice => notice.doi).join(', ')})` },
    corrected: { status: 'warn', severity: 'warning', detail: `Crossref has a correction notice (${input.notices.map(notice => notice.doi).join(', ')})` },
    notice: { status: 'warn', severity: 'warning', detail: `Crossref has ${input.notices.length} update notice(s) of other types` },
    clear: { status: 'pass', severity: 'info', detail: 'Crossref has no registered update notice for this DOI' },
  }
  const mapped = statusMap[input.status as Exclude<RetractionStatus, 'unknown'>]
  checks.push({
    checkId: digest('retraction', mapped.status),
    check: 'retraction',
    status: mapped.status,
    severity: mapped.severity,
    detail: mapped.detail,
    expected: { doi: input.doi },
    actual: { status: input.status, notices: input.notices.map(notice => ({ doi: notice.doi, kind: notice.kind })), isNotice: input.isNotice },
  })
  return checks
}

/** Human warning list for one check. */
export function warningsOf(status: RetractionStatus, isNotice: boolean): string[] {
  const warnings: string[] = []
  if (status === 'clear') {
    warnings.push(
      'clear means "Crossref has no registered update notice"; Crossref notices can lag publication, and Retraction Watch coverage is not queried — treat clear as absence of evidence, not evidence of validity',
    )
  }
  if (isNotice) warnings.push('this DOI is itself an update notice; the status describes notices about the notice, not the work it updates')
  return warnings
}
