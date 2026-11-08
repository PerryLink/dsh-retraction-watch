/**
 * Runtime: Crossref lookups, timeline change detection, REP evidence.
 * @module test/runtime.spec
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { validateRep } from '@perrylink/dsh-research-core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import type { HttpClient } from '../src/http.ts'
import { RetractionWatchRuntime } from '../src/runtime.ts'

const AT = new Date('2026-07-01T09:00:00.000Z')
const DOI = '10.5555/cited.2020.001'
const NOTICE = '10.5555/notice.2021.001'
let root: string

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'retraction-watch-'))
})

afterEach(async () => {
  if (root.startsWith(tmpdir())) await rm(root, { recursive: true, force: true })
})

/** A client answering from a route table. */
function fakeClient(routes: Record<string, { status: number; body: string }>): { client: HttpClient; calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    client: {
      async get(url: string) {
        calls.push(url)
        const key = Object.keys(routes).find(candidate => url.includes(candidate))
        if (key === undefined) return { status: 404, body: '', url }
        return { status: routes[key]!.status, body: routes[key]!.body, url }
      },
    },
  }
}

/** A work-list response containing one notice. */
function noticeList(type: string): string {
  return JSON.stringify({ status: 'ok', message: { items: [{ DOI: NOTICE, title: ['Notice'], 'update-to': [{ type, DOI }], issued: { 'date-parts': [[2021]] } }] } })
}

/** An empty work list. */
const EMPTY_LIST = JSON.stringify({ status: 'ok', message: { items: [] } })

/** Build a runtime over the given client. */
function runtime(client: HttpClient): RetractionWatchRuntime {
  return new RetractionWatchRuntime({ config: resolveConfig({ root, cacheTtlMs: 0 }), client, now: () => AT })
}

describe('check', () => {
  it('reports a retraction, stores evidence and writes a valid record', async () => {
    const { client } = fakeClient({
      [`works/${DOI}`]: { status: 200, body: JSON.stringify({ message: { DOI } }) },
      'filter=updates': { status: 200, body: noticeList('retraction') },
    })
    const result = await runtime(client).check(DOI)
    expect(result.status).toBe('retracted')
    expect(result.notices[0]?.doi).toBe(NOTICE)
    expect(result.evidenceId).toMatch(/^ev-/u)
    const record = JSON.parse(await readFile(result.recordPath!, 'utf8')) as unknown
    expect(validateRep(record).ok, JSON.stringify(validateRep(record).issues)).toBe(true)
  })

  it('reports clear for an existing DOI with no notices, with the absence caveat', async () => {
    const { client } = fakeClient({
      [`works/${DOI}`]: { status: 200, body: JSON.stringify({ message: { DOI } }) },
      'filter=updates': { status: 200, body: EMPTY_LIST },
    })
    const result = await runtime(client).check(DOI)
    expect(result.status).toBe('clear')
    expect(result.warnings.join(' ')).toContain('absence of evidence')
    expect(result.checks.find(check => check.check === 'retraction')?.status).toBe('pass')
  })

  it('reports unknown (not clean) when Crossref has no record', async () => {
    const { client } = fakeClient({ [`works/${DOI}`]: { status: 404, body: '' } })
    const result = await runtime(client).check(DOI)
    expect(result.status).toBe('unknown')
    expect(result.evidenceId).toBeUndefined()
    expect(result.checks.find(check => check.check === 'doi-exists')?.code).toBe('not_found')
  })

  it('reports unknown when the update query fails', async () => {
    const { client } = fakeClient({
      [`works/${DOI}`]: { status: 200, body: JSON.stringify({ message: { DOI } }) },
      'filter=updates': { status: 503, body: '' },
    })
    const result = await runtime(client).check(DOI)
    expect(result.status).toBe('unknown')
    expect(result.checks.find(check => check.check === 'source-status')?.status).toBe('skipped')
    expect(result.checks.some(check => check.check === 'retraction')).toBe(false)
  })

  it('reports a correction as corrected', async () => {
    const { client } = fakeClient({
      [`works/${DOI}`]: { status: 200, body: JSON.stringify({ message: { DOI } }) },
      'filter=updates': { status: 200, body: noticeList('correction') },
    })
    expect((await runtime(client).check(DOI)).status).toBe('corrected')
  })

  it('rejects an invalid DOI', async () => {
    await expect(runtime(fakeClient({}).client).check('not-a-doi')).rejects.toMatchObject({ code: 'INVALID_DOI' })
  })
})

describe('watch and timeline', () => {
  it('detects a change between runs', async () => {
    const clear = fakeClient({
      [`works/${DOI}`]: { status: 200, body: JSON.stringify({ message: { DOI } }) },
      'filter=updates': { status: 200, body: EMPTY_LIST },
    })
    const first = await runtime(clear.client).watch([DOI])
    expect(first.items[0]?.status).toBe('clear')
    expect(first.items[0]?.changed).toBe(true)

    const retracted = fakeClient({
      [`works/${DOI}`]: { status: 200, body: JSON.stringify({ message: { DOI } }) },
      'filter=updates': { status: 200, body: noticeList('retraction') },
    })
    const second = await runtime(retracted.client).watch([DOI])
    expect(second.items[0]?.status).toBe('retracted')
    expect(second.items[0]?.previousStatus).toBe('clear')
    expect(second.items[0]?.changed).toBe(true)

    const third = await runtime(retracted.client).watch([DOI])
    expect(third.items[0]?.changed).toBe(false)
  })

  it('keeps per-item failures local and reports unknown', async () => {
    const { client } = fakeClient({
      [`works/${DOI}`]: { status: 200, body: JSON.stringify({ message: { DOI } }) },
      'filter=updates': { status: 200, body: EMPTY_LIST },
    })
    const result = await runtime(client).watch([DOI, 'not-a-doi'])
    expect(result.items).toHaveLength(2)
    expect(result.items[0]?.status).toBe('clear')
    expect(result.items[1]?.error?.code).toBe('INVALID_DOI')
    expect(result.warnings.join(' ')).toContain('unknown')
  })

  it('enforces the batch cap', async () => {
    const rt = new RetractionWatchRuntime({ config: resolveConfig({ root, maxBatch: 1, cacheTtlMs: 0 }), client: fakeClient({}).client, now: () => AT })
    await expect(rt.watch([DOI, DOI])).rejects.toMatchObject({ code: 'BATCH_TOO_LARGE' })
  })
})
