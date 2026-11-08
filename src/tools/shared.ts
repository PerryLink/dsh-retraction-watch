/**
 * Shared tool schema fragments.
 * @module dsh-retraction-watch/tools/shared
 */

/** The failure branch. */
export const ERROR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    code: { type: 'string', required: true },
    message: { type: 'string', required: true },
  },
} as const

/** One notice. */
export const NOTICE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    doi: { type: 'string', required: true },
    kind: { type: 'string', required: true },
    rawType: { type: 'string' },
    title: { type: 'string' },
    year: { type: 'integer' },
    url: { type: 'string' },
  },
} as const
