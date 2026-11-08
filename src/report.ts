/**
 * Markdown and SARIF rendering for retraction statuses.
 * @module dsh-retraction-watch/report
 */

import type { WatchItem } from './runtime.ts'

/** SARIF level per status. */
function levelOf(status: string): 'error' | 'warning' | 'note' {
  if (status === 'retracted' || status === 'concern') return 'error'
  if (status === 'corrected' || status === 'notice') return 'warning'
  return 'note'
}

/** Render a watch result as Markdown. */
export function renderWatchMarkdown(items: readonly WatchItem[]): string {
  const lines = ['# Retraction watch', '']
  lines.push('| DOI | Status | Changed | Notices |')
  lines.push('|---|---|---|---|')
  for (const item of items) {
    const notices = item.notices.map(notice => `${notice.kind}: ${notice.doi}`).join('; ')
    lines.push(`| ${item.doi} | ${item.status} | ${item.changed ? 'yes' : 'no'} | ${notices} |`)
  }
  lines.push('')
  lines.push('> `clear` means "Crossref has no registered update notice" — not a statement that the work is valid. Crossref notices can lag, and Retraction Watch coverage is not queried.')
  lines.push('')
  return `${lines.join('\n')}\n`
}

/** Render a watch result as SARIF 2.1.0. */
export function renderWatchSarif(items: readonly WatchItem[], version: string): Record<string, unknown> {
  const results = items
    .filter(item => item.status === 'retracted' || item.status === 'concern' || item.status === 'corrected' || item.status === 'notice')
    .map(item => ({
      ruleId: `retraction-watch/${item.status}`,
      level: levelOf(item.status),
      message: { text: `${item.doi}: ${item.status}${item.notices.length === 0 ? '' : ` (${item.notices.map(notice => notice.doi).join(', ')})`}` },
      properties: { doi: item.doi, status: item.status, previousStatus: item.previousStatus ?? null, notices: item.notices as never },
    }))
  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [{ tool: { driver: { name: 'dsh-retraction-watch', version } }, results }],
  }
}
