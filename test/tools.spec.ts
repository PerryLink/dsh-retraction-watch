/**
 * Tool surface and package contract.
 * @module test/tools.spec
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import type { HttpClient } from '../src/http.ts'
import { RetractionWatchRuntime } from '../src/runtime.ts'
import { makeRetractionCheckTool } from '../src/tools/retraction-check.ts'
import { makeRetractionReportTool } from '../src/tools/retraction-report.ts'
import { makeRetractionWatchTool } from '../src/tools/retraction-watch.ts'
import { VERSION } from '../src/version.ts'

const AT = new Date('2026-07-01T09:00:00.000Z')
const DOI = '10.5555/cited.2020.001'
let root: string

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'retraction-tools-'))
})

afterEach(async () => {
  if (root.startsWith(tmpdir())) await rm(root, { recursive: true, force: true })
})

/** A client returning a retraction notice. */
function retractedClient(): HttpClient {
  return {
    async get(url: string) {
      if (url.includes('filter=updates')) {
        return {
          status: 200,
          body: JSON.stringify({ message: { items: [{ DOI: '10.5555/n.1', title: ['Notice'], 'update-to': [{ type: 'retraction', DOI }] }] } }),
          url,
        }
      }
      return { status: 200, body: JSON.stringify({ message: { DOI } }), url }
    },
  }
}

/** Build a runtime over the temp root. */
function runtime(): RetractionWatchRuntime {
  return new RetractionWatchRuntime({ config: resolveConfig({ root, cacheTtlMs: 0 }), client: retractedClient(), now: () => AT })
}

const EXEC = {} as never

describe('tools', () => {
  it('declares names and schemas', () => {
    for (const [tool, name] of [
      [makeRetractionCheckTool(runtime()), 'retraction_check'],
      [makeRetractionWatchTool(runtime()), 'retraction_watch'],
      [makeRetractionReportTool(), 'retraction_report'],
    ] as const) {
      expect(tool.name).toBe(name)
      expect(Object.keys(tool.parameters).length).toBeGreaterThan(0)
      expect(tool.output.schema).toBeDefined()
    }
  })

  it('retraction_check returns status and a render', async () => {
    const tool = makeRetractionCheckTool(runtime())
    const value = (await tool.execute({ doi: DOI }, EXEC)) as { ok: true; status: string; checks: unknown[] }
    expect(value.ok).toBe(true)
    expect(value.status).toBe('retracted')
    const blocks = tool.output.render({}, value as never) as Array<{ text: string }>
    expect(blocks[0]?.text).toContain('retracted')
  })

  it('retraction_watch does not call the first observation a change', async () => {
    const tool = makeRetractionWatchTool(runtime())
    const value = (await tool.execute({ dois: [DOI] }, EXEC)) as { ok: true; items: Array<{ changed: boolean }> }
    expect(value.items[0]?.changed).toBe(false)
  })

  it('retraction_report renders markdown and SARIF', async () => {
    const items = [{ doi: DOI, status: 'retracted', changed: true, notices: [{ doi: '10.5555/n.1', kind: 'retraction', rawType: 'retraction' }] }]
    const value = (await makeRetractionReportTool().execute({ items }, EXEC)) as {
      ok: true
      markdown: string
      sarif: { version: string; runs: Array<{ results: unknown[] }> }
    }
    expect(value.markdown).toContain('retracted')
    expect(value.sarif.version).toBe('2.1.0')
    expect(value.sarif.runs[0]?.results.length).toBe(1)
  })
})

describe('package', () => {
  it('VERSION matches package.json and the manifest is a bundle patch', async () => {
    const pkg = JSON.parse(await (await import('node:fs/promises')).readFile(new URL('../package.json', import.meta.url), 'utf8')) as Record<string, unknown>
    expect(pkg['version']).toBe(VERSION)
    expect(pkg['author']).toBe('dsh-retraction-watch contributors')
    expect(pkg['dsh']).toEqual({ manifestVersion: 1, bundle: { patch: './cordis.patch.yml' } })
    expect((pkg['dependencies'] as Record<string, unknown>)).toEqual({})
  })
})
