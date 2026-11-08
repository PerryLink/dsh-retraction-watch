/**
 * `retraction_check` — status of one DOI.
 * @module dsh-retraction-watch/tools/retraction-check
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { WatchError, type RetractionWatchRuntime } from '../runtime.ts'
import { ERROR_SCHEMA, NOTICE_SCHEMA } from './shared.ts'

const CHECK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    checkId: { type: 'string', required: true },
    check: { type: 'string', required: true },
    status: { type: 'string', required: true },
    detail: { type: 'string', required: true },
    code: { type: 'string' },
    severity: { type: 'string' },
    expected: { type: 'json' },
    actual: { type: 'json' },
  },
} as const

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    doi: { type: 'string' },
    status: { type: 'string' },
    isNotice: { type: 'boolean' },
    changed: { type: 'boolean' },
    previousStatus: { type: 'string' },
    notices: { type: 'array', items: NOTICE_SCHEMA },
    checks: { type: 'array', items: CHECK_SCHEMA },
    warnings: { type: 'array', items: { type: 'string' } },
    evidenceId: { type: 'string' },
    recordPath: { type: 'string' },
    error: ERROR_SCHEMA,
  },
} as const

/**
 * Build the `retraction_check` tool.
 * @param runtime - the runtime.
 * @returns the tool definition.
 */
export function makeRetractionCheckTool(runtime: RetractionWatchRuntime) {
  return defineTool({
    name: 'retraction_check',
    description: [
      'Check whether Crossref has a retraction, expression of concern or correction registered against a DOI (dsh-retraction-watch).',
      '',
      'Queries the work record and `filter=updates:<doi>` (verified against the live Crossref API). Returns `retracted` / `concern` / `corrected` / `notice` / `clear` / `unknown`, with the notice DOIs and an append-only timeline entry.',
      '',
      '`clear` means Crossref has no registered notice — NOT that the work is valid. `unknown` means the lookup failed or the DOI is not in Crossref; it is never reported as clean.',
    ].join('\n'),
    parameters: {
      doi: { type: 'string', required: true, description: 'The DOI to check (with or without https://doi.org/).' },
      fresh: { type: 'boolean', description: 'Bypass the response cache.' },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => {
        const result = value as { ok: true; doi: string; status: string; notices: Array<{ kind: string; doi: string }>; warnings: string[] } | { ok: false; error: { code: string; message: string } }
        if (!result.ok) return [{ type: 'text', text: `retraction_check failed (${result.error.code}): ${result.error.message}` }]
        const lines = [`retraction_check: ${result.doi} → ${result.status}`]
        for (const notice of result.notices) lines.push(`  ${notice.kind}: ${notice.doi}`)
        for (const warning of result.warnings) lines.push(`  warning: ${warning}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args: unknown) {
      const request = args as { doi?: string; fresh?: boolean }
      try {
        const result = await runtime.check(request.doi ?? '', request.fresh === true ? { fresh: true } : {})
        return {
          ok: true as const,
          doi: result.doi,
          status: result.status,
          isNotice: result.isNotice,
          changed: result.changed,
          ...(result.previousStatus === undefined ? {} : { previousStatus: result.previousStatus }),
          notices: result.notices.map(notice => ({ ...notice })),
          checks: result.checks.map(check => ({
            checkId: check.checkId,
            check: check.check,
            status: check.status,
            detail: check.detail,
            ...(check.code === undefined ? {} : { code: check.code }),
            ...(check.severity === undefined ? {} : { severity: check.severity }),
            ...(check.expected === undefined ? {} : { expected: check.expected as never }),
            ...(check.actual === undefined ? {} : { actual: check.actual as never }),
          })),
          warnings: [...result.warnings],
          ...(result.evidenceId === undefined ? {} : { evidenceId: result.evidenceId }),
          ...(result.recordPath === undefined ? {} : { recordPath: result.recordPath }),
        }
      } catch (error) {
        if (error instanceof WatchError) return { ok: false as const, error: { code: error.code, message: error.message } }
        throw error
      }
    },
  })
}
