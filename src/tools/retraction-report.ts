/**
 * `retraction_report` — Markdown + SARIF for a watch result.
 * @module dsh-retraction-watch/tools/retraction-report
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { renderWatchMarkdown, renderWatchSarif } from '../report.ts'
import type { WatchItem } from '../runtime.ts'
import { VERSION } from '../version.ts'
import { ERROR_SCHEMA } from './shared.ts'

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    markdown: { type: 'string' },
    sarif: { type: 'json' },
    error: ERROR_SCHEMA,
  },
} as const

/**
 * Build the `retraction_report` tool.
 * @returns the tool definition.
 */
export function makeRetractionReportTool() {
  return defineTool({
    name: 'retraction_report',
    description: [
      'Render retraction_watch items as a Markdown table and a SARIF 2.1.0 log (dsh-retraction-watch).',
      '',
      'Retractions and expressions of concern become SARIF errors; corrections become warnings. The report repeats that `clear` is absence of a registered notice, not proof of validity.',
    ].join('\n'),
    parameters: {
      items: { type: 'array', items: { type: 'json' }, required: true, description: 'Items from retraction_watch.' },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => {
        const result = value as { ok: true; markdown: string } | { ok: false; error: { code: string; message: string } }
        if (!result.ok) return [{ type: 'text', text: `retraction_report failed (${result.error.code}): ${result.error.message}` }]
        return [{ type: 'text', text: result.markdown }]
      },
    },
    async execute(args: unknown) {
      const request = args as { items?: WatchItem[] }
      const items = Array.isArray(request.items) ? request.items : []
      return { ok: true as const, markdown: renderWatchMarkdown(items), sarif: renderWatchSarif(items, VERSION) as never }
    },
  })
}
