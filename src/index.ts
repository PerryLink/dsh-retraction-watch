/**
 * `dsh-retraction-watch` — registered notices and status changes for cited DOIs.
 *
 * Three tools: retraction_check (one DOI), retraction_watch (a bibliography,
 * change-aware), retraction_report (Markdown + SARIF). Status comes from two
 * verified Crossref queries and an append-only timeline; `clear` is absence of
 * a registered notice, and `unknown` is never reported as clean.
 *
 * Function plugin — no default export.
 * @module dsh-retraction-watch
 */

import type { Context } from '@deepseek-ai/cordis'
import { Config, resolveConfig, type Config as ConfigShape } from './config.ts'
import { RetractionWatchRuntime, type EvidencePort } from './runtime.ts'
import { makeRetractionCheckTool } from './tools/retraction-check.ts'
import { makeRetractionWatchTool } from './tools/retraction-watch.ts'
import { makeRetractionReportTool } from './tools/retraction-report.ts'

/** Cordis plugin name. */
export const name = 'retraction-watch'

/** The tool registry is required; the REP service is optional. */
export const inject = ['tools']

export { Config, resolveConfig }
export type { ConfigShape }
export type { ResolvedConfig } from './config.ts'
export { VERSION } from './version.ts'
export { ALLOWED_HOSTS, WatchNetworkError, assertAllowed, createHttpClient } from './http.ts'
export type { FetchLike, HttpClient, HttpResponse, NetworkErrorCode } from './http.ts'
export { checksOf, noticeKindOf, noticeTargets, noticesFromList, statusOf, warningsOf } from './retraction.ts'
export type { Notice, NoticeKind, RetractionCheck, RetractionStatus } from './retraction.ts'
export { normalizeDoi, RetractionWatchRuntime, WatchError } from './runtime.ts'
export type {
  EvidencePort,
  RetractionCheckResult,
  RetractionWatchRuntimeOptions,
  WatchErrorCode,
  WatchItem,
} from './runtime.ts'
export { renderWatchMarkdown, renderWatchSarif } from './report.ts'
export { makeRetractionCheckTool } from './tools/retraction-check.ts'
export { makeRetractionWatchTool } from './tools/retraction-watch.ts'
export { makeRetractionReportTool } from './tools/retraction-report.ts'

/**
 * Mount the three tools.
 * @param ctx - the plugin context (host).
 * @param config - raw plugin config.
 */
export function apply(ctx: Context, config: ConfigShape): void {
  const resolved = resolveConfig(config)
  const logger = ctx.logger('retraction-watch')
  if (!resolved.enabled) {
    logger.info('disabled: enabled is false — no tools are mounted')
    return
  }
  const service = ctx.get('researchEvidence') as EvidencePort | undefined
  const runtime = new RetractionWatchRuntime({ config: resolved, ...(service === undefined ? {} : { service }) })
  if (service === undefined) {
    logger.info(`ctx.researchEvidence is not mounted; using a local core store under ${resolved.root}`)
  }
  ctx.effect(() => ctx.tools.register(makeRetractionCheckTool(runtime)), 'retraction-watch: retraction_check tool')
  ctx.effect(() => ctx.tools.register(makeRetractionWatchTool(runtime)), 'retraction-watch: retraction_watch tool')
  ctx.effect(() => ctx.tools.register(makeRetractionReportTool()), 'retraction-watch: retraction_report tool')
}
