/**
 * Retraction status parsing and judgement.
 * @module test/retraction.spec
 */

import { describe, expect, it } from 'vitest'
import { checksOf, noticeKindOf, noticesFromList, noticeTargets, statusOf } from '../src/retraction.ts'

const DOI = '10.5555/cited.2020.001'
const NOTICE_DOI = '10.5555/notice.2021.001'

describe('notice kinds', () => {
  it('maps Crossref update types', () => {
    expect(noticeKindOf('retraction')).toBe('retraction')
    expect(noticeKindOf('correction')).toBe('correction')
    expect(noticeKindOf('expression_of_concern')).toBe('expression_of_concern')
    expect(noticeKindOf('new-version')).toBe('other')
  })
})

describe('parsing', () => {
  it('keeps only notices that update the requested DOI', () => {
    const body = JSON.stringify({
      message: {
        items: [
          { DOI: NOTICE_DOI, title: ['Retraction'], 'update-to': [{ type: 'retraction', DOI }] },
          { DOI: '10.5555/other', 'update-to': [{ type: 'retraction', DOI: '10.5555/something' }] },
        ],
      },
    })
    const notices = noticesFromList(body, DOI)
    expect(notices).toHaveLength(1)
    expect(notices[0]?.doi).toBe(NOTICE_DOI)
    expect(notices[0]?.kind).toBe('retraction')
    expect(notices[0]?.year).toBeUndefined()
  })

  it('extracts the targets of a work that is itself a notice', () => {
    const body = JSON.stringify({ message: { DOI: NOTICE_DOI, 'update-to': [{ type: 'retraction', DOI }] } })
    expect(noticeTargets(body)).toEqual([{ doi: DOI, kind: 'retraction', rawType: 'retraction' }])
  })
})

describe('status', () => {
  const notice = (kind: 'retraction' | 'correction' | 'expression_of_concern' | 'other') => ({ doi: NOTICE_DOI, kind, rawType: kind })

  it('derives the aggregate status with retraction precedence', () => {
    expect(statusOf([])).toBe('clear')
    expect(statusOf([notice('correction')])).toBe('corrected')
    expect(statusOf([notice('expression_of_concern')])).toBe('concern')
    expect(statusOf([notice('correction'), notice('retraction')])).toBe('retracted')
    expect(statusOf([notice('other')])).toBe('notice')
  })

  it('builds checks for clear, retracted and unknown', () => {
    const clear = checksOf({ doi: DOI, exists: true, status: 'clear', notices: [], isNotice: false })
    expect(clear.find(check => check.check === 'retraction')?.status).toBe('pass')
    const retracted = checksOf({ doi: DOI, exists: true, status: 'retracted', notices: [notice('retraction')], isNotice: false })
    expect(retracted.find(check => check.check === 'retraction')?.status).toBe('fail')
    expect(retracted.find(check => check.check === 'retraction')?.detail).toContain(NOTICE_DOI)
    const unknown = checksOf({ doi: DOI, exists: false, status: 'unknown', notices: [], isNotice: false })
    expect(unknown.find(check => check.check === 'doi-exists')?.status).toBe('skipped')
    expect(unknown.find(check => check.check === 'doi-exists')?.code).toBe('not_found')
    expect(unknown.some(check => check.check === 'retraction')).toBe(false)
  })

  it('marks a failed notice query as skipped and emits no retraction verdict', () => {
    const checks = checksOf({ doi: DOI, exists: true, status: 'unknown', notices: [], isNotice: false, networkError: 'timed out' })
    expect(checks.some(check => check.check === 'retraction')).toBe(false)
    expect(checks.find(check => check.check === 'source-status')?.status).toBe('skipped')
    expect(checks.find(check => check.check === 'source-status')?.code).toBe('network_error')
  })
})
