/**
 * `retraction_watch` — check a list and report changes since the last run.
 * @module dsh-retraction-watch/tools/retraction-watch
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { WatchError, type RetractionWatchRuntime } from '../runtime.ts'
import { ERROR_SCHEMA, NOTICE_SCHEMA } from './shared.ts'

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    count: { type: 'integer' },
    items: { type: 'array', items: { type: 'json' } },
    warnings: { type: 'array', items: { type: 'string' } },
    error: ERROR_SCHEMA,
    notices: { type: 'array', items: NOTICE_SCHEMA },
  },
} as const

/**
 * Build the `retraction_watch` tool.
 * @param runtime - the runtime.
 * @returns the tool definition.
 */
export function makeRetractionWatchTool(runtime: RetractionWatchRuntime) {
  return defineTool({
    name: 'retraction_watch',
    description: [
      'Check a list of DOIs and report which statuses CHANGED since the previous run (dsh-retraction-watch).',
      '',
      'Bounded concurrency; per-item failures stay local. The append-only timeline (`<root>/timeline.jsonl`) makes "clear → retracted" visible, which is the point of monitoring a bibliography after submission.',
    ].join('\n'),
    parameters: {
      dois: { type: 'array', items: { type: 'string' }, required: true, description: 'DOIs to check (max from config, default 50).' },
      fresh: { type: 'boolean', description: 'Bypass the response cache.' },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => {
        const result = value as { ok: true; count: number; items: Array<{ doi: string; status: string; changed: boolean }>; warnings: string[] } | { ok: false; error: { code: string; message: string } }
        if (!result.ok) return [{ type: 'text', text: `retraction_watch failed (${result.error.code}): ${result.error.message}` }]
        const changed = result.items.filter(item => item.changed)
        const lines = [`retraction_watch: ${result.count} DOI(s), ${changed.length} changed`]
        for (const item of changed) lines.push(`  CHANGED ${item.doi} → ${item.status}`)
        for (const warning of result.warnings) lines.push(`  warning: ${warning}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args: unknown) {
      const request = args as { dois?: string[]; fresh?: boolean }
      try {
        const result = await runtime.watch(request.dois ?? [], request.fresh === true ? { fresh: true } : {})
        return {
          ok: true as const,
          count: result.items.length,
          items: result.items.map(item => ({
            doi: item.doi,
            status: item.status,
            changed: item.changed,
            ...(item.previousStatus === undefined ? {} : { previousStatus: item.previousStatus }),
            notices: item.notices.map(notice => ({ ...notice })),
            ...(item.error === undefined ? {} : { error: { code: item.error.code, message: item.error.message } }),
          })),
          warnings: [...result.warnings],
        }
      } catch (error) {
        if (error instanceof WatchError) return { ok: false as const, error: { code: error.code, message: error.message } }
        throw error
      }
    },
  })
}
