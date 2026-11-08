/**
 * Runtime: Crossref lookups, response cache, durable timeline, REP evidence.
 *
 * The timeline is append-only JSONL: every check records what Crossref said at
 * that moment, so `retraction_watch` can report *changes* ("clear → retracted")
 * instead of just the current state.
 *
 * @module dsh-retraction-watch/runtime
 */

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  EvidenceStore,
  RepStoreError,
  sha256Hex,
  stableId,
  validateRep,
  type AddEvidenceInput,
  type CaptureInput,
  type Evidence,
  type HashRef,
  type ResearchRecord,
  type Snapshot,
} from '@perrylink/dsh-research-core'
import type { ResolvedConfig } from './config.ts'
import { ALLOWED_HOSTS, createHttpClient, WatchNetworkError, type HttpClient } from './http.ts'
import { checksOf, noticesFromList, noticeTargets, statusOf, warningsOf, type Notice, type RetractionCheck, type RetractionStatus } from './retraction.ts'
import { VERSION } from './version.ts'

/** Stable error codes. */
export type WatchErrorCode = 'INVALID_INPUT' | 'INVALID_DOI' | 'NETWORK_ERROR' | 'STORE_ERROR' | 'BATCH_TOO_LARGE'

/** A typed failure. */
export class WatchError extends Error {
  /** Stable code. */
  readonly code: WatchErrorCode

  constructor(code: WatchErrorCode, message: string) {
    super(message)
    this.name = 'WatchError'
    this.code = code
  }
}

/** The subset of the REP service used here. */
export interface EvidencePort {
  capture(input: CaptureInput): Promise<{ snapshot: Snapshot }>
  addEvidence(input: AddEvidenceInput): Promise<{ evidence: Evidence }>
  buildRecord(options?: { evidenceIds?: readonly string[] }): Promise<Omit<ResearchRecord, 'manifest'>>
}

/** A check plus its stored evidence. */
export interface RetractionCheckResult extends RetractionCheck {
  readonly evidenceId?: string
  readonly recordPath?: string
  readonly previousStatus?: RetractionStatus
  readonly changed: boolean
}

/** One item of a watch run. */
export interface WatchItem {
  readonly doi: string
  readonly status: RetractionStatus
  readonly previousStatus?: RetractionStatus
  readonly changed: boolean
  readonly notices: readonly Notice[]
  readonly evidenceId?: string
  readonly error?: { readonly code: string; readonly message: string }
}

/** One timeline line. */
interface TimelineLine {
  readonly doi: string
  readonly at: string
  readonly status: RetractionStatus
  readonly isNotice: boolean
  readonly notices: Array<{ doi: string; kind: string; year?: number }>
}

/** Options for {@link RetractionWatchRuntime}. */
export interface RetractionWatchRuntimeOptions {
  readonly config: ResolvedConfig
  readonly service?: EvidencePort
  readonly client?: HttpClient
  readonly now?: () => Date
}

const DOI_PATTERN = /^10\.\d{4,9}\/[^\s?#]+$/u

/** Add the Crossref polite-pool contact to a request URL. */
function withContact(url: string, mailto: string | undefined): string {
  if (mailto === undefined) return url
  return `${url}${url.includes('?') ? '&' : '?'}mailto=${encodeURIComponent(mailto)}`
}

/** Remove the polite-pool contact before a URL is cached or stored as evidence. */
function withoutContact(url: string): string {
  try {
    const parsed = new URL(url)
    parsed.searchParams.delete('mailto')
    return parsed.toString()
  } catch {
    return url
  }
}

/** Validate a DOI. */
export function normalizeDoi(doi: string): string {
  const stripped = doi.trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//iu, '')
  if (!DOI_PATTERN.test(stripped)) throw new WatchError('INVALID_DOI', `not a DOI: ${doi}`)
  return stripped
}

/** Read a JSONL file, tolerating absence. */
async function readLines<T>(file: string): Promise<T[]> {
  try {
    const text = await readFile(file, 'utf8')
    return text
      .split('\n')
      .filter(line => line.trim() !== '')
      .map(line => JSON.parse(line) as T)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw new WatchError('STORE_ERROR', `cannot read ${file}: ${(error as Error).message}`)
  }
}

/** The runtime. */
export class RetractionWatchRuntime {
  readonly config: ResolvedConfig

  readonly #service: EvidencePort | undefined
  readonly #client: HttpClient
  readonly #now: () => Date
  #store: EvidenceStore | undefined

  constructor(options: RetractionWatchRuntimeOptions) {
    this.config = options.config
    this.#service = options.service
    this.#now = options.now ?? (() => new Date())
    this.#client =
      options.client ??
      createHttpClient({
        timeoutMs: options.config.timeoutMs,
        minIntervalMs: options.config.minIntervalMs,
        retries: options.config.retries,
        maxRedirects: options.config.maxRedirects,
        userAgent: options.config.userAgent,
        allowedHosts: ALLOWED_HOSTS,
        now: () => this.#now().getTime(),
      })
  }

  /** Current ISO timestamp. */
  iso(): string {
    return this.#now().toISOString()
  }

  /** The evidence port. */
  port(): EvidencePort {
    if (this.#service !== undefined) return this.#service
    this.#store ??= new EvidenceStore(path.join(this.config.root, 'store'))
    return this.#store
  }

  /** Timeline file path. */
  get timelineFile(): string {
    return path.join(this.config.root, 'timeline.jsonl')
  }

  /** Last recorded status per DOI. */
  async lastStatuses(): Promise<Map<string, RetractionStatus>> {
    const lines = await readLines<TimelineLine>(this.timelineFile)
    const latest = new Map<string, RetractionStatus>()
    for (const line of lines) latest.set(line.doi, line.status)
    return latest
  }

  /** Append one timeline line. */
  async #appendTimeline(doi: string, status: RetractionStatus, isNotice: boolean, notices: readonly Notice[]): Promise<void> {
    await mkdir(this.config.root, { recursive: true })
    const line: TimelineLine = {
      doi,
      at: this.iso(),
      status,
      isNotice,
      notices: notices.map(notice => ({ doi: notice.doi, kind: notice.kind, ...(notice.year === undefined ? {} : { year: notice.year }) })),
    }
    await appendFile(this.timelineFile, `${JSON.stringify(line)}\n`, 'utf8')
  }

  /** Cache read. */
  async #cacheGet(key: string, fresh: boolean): Promise<{ status: number; body: string; url: string } | undefined> {
    if (fresh || this.config.cacheTtlMs <= 0) return undefined
    try {
      const parsed = JSON.parse(await readFile(path.join(this.config.root, 'cache', `${sha256Hex(key)}.json`), 'utf8')) as {
        at: number
        status: number
        body: string
        url: string
      }
      if (this.#now().getTime() - parsed.at > this.config.cacheTtlMs) return undefined
      return { status: parsed.status, body: parsed.body, url: parsed.url }
    } catch {
      return undefined
    }
  }

  /** Cache write (best effort). */
  async #cachePut(key: string, value: { status: number; body: string; url: string }): Promise<void> {
    if (this.config.cacheTtlMs <= 0) return
    try {
      const directory = path.join(this.config.root, 'cache')
      await mkdir(directory, { recursive: true })
      await writeFile(path.join(directory, `${sha256Hex(key)}.json`), JSON.stringify({ at: this.#now().getTime(), ...value }), 'utf8')
    } catch {
      // Cache failures are cache misses, never check failures.
    }
  }

  /** Fetch one URL through the cache. */
  async #get(url: string, key: string, fresh: boolean): Promise<{ status: number; body: string; url: string }> {
    const cached = await this.#cacheGet(key, fresh)
    if (cached !== undefined) return cached
    const response = await this.#client.get(url, { accept: 'application/json' })
    // A transient 5xx must not be cached for a week; only answers are cached.
    if (response.status < 400) await this.#cachePut(key, { ...response, url: withoutContact(response.url) })
    return { ...response, url: withoutContact(response.url) }
  }

  /**
   * Check one DOI.
   * @param doi - the DOI.
   * @param options - `fresh` bypasses the cache.
   * @returns the status, notices, checks and evidence.
   */
  async check(doi: string, options: { fresh?: boolean } = {}): Promise<RetractionCheckResult> {
    const normalized = normalizeDoi(doi)
    const previousStatus = (await this.lastStatuses()).get(normalized)
    const fresh = options.fresh === true
    const workUrl = withContact(`https://api.crossref.org/works/${encodeURIComponent(normalized).replace(/%2F/gu, '/')}`, this.config.mailto)
    const updatesUrl = withContact(
      `https://api.crossref.org/works?filter=updates:${encodeURIComponent(normalized)}&rows=20&select=DOI,title,type,update-to,issued,URL`,
      this.config.mailto,
    )

    let work: { status: number; body: string; url: string }
    try {
      work = await this.#get(workUrl, `work:${normalized}`, fresh)
    } catch (error) {
      if (error instanceof WatchNetworkError) {
        if (error.code === 'blocked_host' || error.code === 'invalid_url') throw new WatchError('NETWORK_ERROR', error.message)
        await this.#appendTimeline(normalized, 'unknown', false, [])
        return {
          doi: normalized,
          status: 'unknown',
          isNotice: false,
          notices: [],
          checks: checksOf({ doi: normalized, exists: false, status: 'unknown', notices: [], isNotice: false, networkError: error.message }),
          snapshots: [],
          warnings: [`the Crossref work lookup failed (${error.code}); status stays unknown`],
          changed: previousStatus !== undefined && previousStatus !== 'unknown',
          ...(previousStatus === undefined ? {} : { previousStatus }),
        }
      }
      throw error
    }

    if (work.status === 404) {
      const checks = checksOf({ doi: normalized, exists: false, status: 'unknown', notices: [], isNotice: false })
      await this.#appendTimeline(normalized, 'unknown', false, [])
      return {
        doi: normalized,
        status: 'unknown',
        isNotice: false,
        notices: [],
        checks,
        snapshots: [],
        warnings: ['Crossref returned no record for this DOI; not_found is not evidence of fabrication and not evidence of cleanliness'],
        changed: previousStatus !== undefined && previousStatus !== 'unknown',
        ...(previousStatus === undefined ? {} : { previousStatus }),
      }
    }
    if (work.status >= 400) throw new WatchError('NETWORK_ERROR', `Crossref returned HTTP ${work.status} for ${normalized}`)

    const isNotice = noticeTargets(work.body).length > 0
    let notices: Notice[] = []
    let noticeQueryFailed: string | undefined
    const snapshots: Array<{ kind: 'work' | 'updates'; body: string; url: string }> = [{ kind: 'work', body: work.body, url: work.url }]
    try {
      const updates = await this.#get(updatesUrl, `updates:${normalized}`, fresh)
      if (updates.status >= 400) noticeQueryFailed = `Crossref returned HTTP ${updates.status} for the update query`
      else {
        notices = noticesFromList(updates.body, normalized)
        snapshots.push({ kind: 'updates', body: updates.body, url: updates.url })
      }
    } catch (error) {
      noticeQueryFailed = error instanceof WatchNetworkError ? error.message : (error as Error).message
    }

    const status = noticeQueryFailed === undefined ? statusOf(notices) : 'unknown'
    const checks = checksOf({ doi: normalized, exists: true, status, notices, isNotice, ...(noticeQueryFailed === undefined ? {} : { networkError: noticeQueryFailed }) })
    const warnings = warningsOf(status, isNotice)
    if (noticeQueryFailed !== undefined) warnings.push(`the update-notice query failed (${noticeQueryFailed}); status stays unknown`)

    await this.#appendTimeline(normalized, status, isNotice, notices)

    let evidenceId: string | undefined
    let recordPath: string | undefined
    try {
      const port = this.port()
      const snapshotIds: HashRef[] = []
      const capturedAt: string[] = []
      for (const snapshot of snapshots) {
        const captured = await port.capture({
          bytes: snapshot.body,
          mediaType: 'application/json',
          sourceRef: { kind: 'doi', id: normalized, url: snapshot.url, retrievedAt: this.iso() },
          capturedAt: this.iso(),
        })
        snapshotIds.push(captured.snapshot.snapshotId)
        capturedAt.push(captured.snapshot.capturedAt)
      }
      // The first snapshot's capture time is immutable, so re-checking the same
      // Crossref answers dedupes instead of raising EVIDENCE_CONFLICT.
      const retrievedAt = capturedAt[0]!
      const evidence = (
        await port.addEvidence({
          evidenceId: stableId('ev', ['retraction-watch', normalized, ...snapshotIds, status, ...checks.map(check => check.checkId)]),
          title: `Crossref retraction status for ${normalized}`,
          sourceRef: { kind: 'doi', id: normalized, url: work.url, retrievedAt, metadata: { title: `Retraction status ${normalized}` } },
          snapshotIds,
          anchors: [{ snapshotId: snapshotIds[0]!, kind: 'record', value: 'field:DOI' }],
          provenance: { plugin: 'dsh-retraction-watch', version: VERSION, method: 'crossref:work+filter=updates', retrievedAt },
          checks: [...checks],
          notes: `status=${status}; ${notices.length} notice(s)`,
        })
      ).evidence
      evidenceId = evidence.evidenceId
      const record = await port.buildRecord({ evidenceIds: [evidence.evidenceId] })
      if (!validateRep(record).ok) throw new WatchError('STORE_ERROR', 'refusing to write an invalid REP record')
      const directory = path.join(this.config.root, 'records')
      await mkdir(directory, { recursive: true })
      const file = path.join(directory, `${evidence.evidenceId}.rep.json`)
      await writeFile(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
      recordPath = file
    } catch (error) {
      if (error instanceof WatchError) throw error
      if (error instanceof RepStoreError) throw new WatchError('STORE_ERROR', error.message)
      throw new WatchError('STORE_ERROR', `could not store the evidence: ${(error as Error).message}`)
    }

    return {
      doi: normalized,
      status,
      isNotice,
      notices,
      checks,
      snapshots,
      warnings,
      changed: previousStatus !== undefined && previousStatus !== status,
      ...(previousStatus === undefined ? {} : { previousStatus }),
      ...(evidenceId === undefined ? {} : { evidenceId }),
      ...(recordPath === undefined ? {} : { recordPath }),
    }
  }

  /**
   * Check many DOIs with bounded concurrency and change detection.
   * @param dois - the DOIs.
   * @param options - `fresh` bypasses the cache.
   * @returns per-item statuses.
   */
  async watch(dois: readonly string[], options: { fresh?: boolean } = {}): Promise<{ items: WatchItem[]; warnings: string[] }> {
    if (dois.length === 0) throw new WatchError('INVALID_INPUT', 'dois must not be empty')
    if (dois.length > this.config.maxBatch) throw new WatchError('BATCH_TOO_LARGE', `${dois.length} DOIs exceed the batch cap of ${this.config.maxBatch}`)
    const items: WatchItem[] = []
    for (let start = 0; start < dois.length; start += this.config.batchConcurrency) {
      const chunk = dois.slice(start, start + this.config.batchConcurrency)
      const results = await Promise.all(
        chunk.map(async raw => {
          try {
            return { doi: raw, result: await this.check(raw, options) }
          } catch (error) {
            // One bad DOI (or one failed lookup) never fails the batch.
            return {
              doi: raw,
              error: { code: error instanceof WatchError ? error.code : 'NETWORK_ERROR', message: (error as Error).message },
            }
          }
        }),
      )
      for (const entry of results) {
        if ('result' in entry && entry.result !== undefined) {
          const result = entry.result
          items.push({
            doi: result.doi,
            status: result.status,
            changed: result.changed,
            notices: result.notices,
            ...(result.previousStatus === undefined ? {} : { previousStatus: result.previousStatus }),
            ...(result.evidenceId === undefined ? {} : { evidenceId: result.evidenceId }),
          })
        } else {
          items.push({ doi: entry.doi, status: 'unknown', changed: false, notices: [], error: (entry as { error: { code: string; message: string } }).error })
        }
      }
    }
    const warnings: string[] = []
    const unknown = items.filter(item => item.status === 'unknown').length
    if (unknown > 0) warnings.push(`${unknown} DOI(s) could not be classified (unknown is not the same as clean)`)
    return { items, warnings }
  }
}
