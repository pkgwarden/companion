import { describe, expect, it } from 'vitest'

import { planPinUpdate } from './pinMerge'

describe('planPinUpdate', () => {
  it('preserves unrelated pins', () => {
    expect(
      planPinUpdate({ 'other.ext': ['1.0.0'], microsoft: true }, 'contoso.linter-pro', ['4.1.9']),
    ).toEqual({
      kind: 'write',
      pinMap: {
        'other.ext': ['1.0.0'],
        microsoft: true,
        'contoso.linter-pro': ['4.1.9'],
      },
    })
  })

  it('preserves existing pins of the same extension in the order gate sent', () => {
    expect(
      planPinUpdate({ 'contoso.linter-pro': ['4.1.7'] }, 'contoso.linter-pro', ['4.1.9', '4.2.0']),
    ).toEqual({ kind: 'write', pinMap: { 'contoso.linter-pro': ['4.1.7', '4.1.9', '4.2.0'] } })
  })

  it('does not duplicate a version gate sent back', () => {
    expect(
      planPinUpdate({ 'contoso.linter-pro': ['4.1.9'] }, 'contoso.linter-pro', ['4.1.9', '4.2.0']),
    ).toEqual({ kind: 'write', pinMap: { 'contoso.linter-pro': ['4.1.9', '4.2.0'] } })
  })

  it('never re-sorts the versions gate provided', () => {
    const decision = planPinUpdate({}, 'contoso.linter-pro', ['4.10.0', '4.9.0'])

    expect(decision).toEqual({
      kind: 'write',
      pinMap: { 'contoso.linter-pro': ['4.10.0', '4.9.0'] },
    })
  })

  it('leaves an extension-wide allow alone rather than narrowing it to versions', () => {
    expect(planPinUpdate({ 'contoso.linter-pro': true }, 'contoso.linter-pro', ['4.1.9'])).toEqual({
      kind: 'already-allowed',
    })
  })

  it('leaves a trusted publisher-wide allow alone rather than narrowing one of its extensions', () => {
    expect(planPinUpdate({ contoso: true }, 'contoso.linter-pro', ['4.1.9'])).toEqual({
      kind: 'already-allowed',
    })
  })

  it('writes a version allowlist when a publisher-wide allow coexists with an extension deny', () => {
    expect(
      planPinUpdate({ contoso: true, 'contoso.linter-pro': false }, 'contoso.linter-pro', [
        '4.1.9',
      ]),
    ).toEqual({
      kind: 'write',
      pinMap: { contoso: true, 'contoso.linter-pro': ['4.1.9'] },
    })
  })

  it('replaces a stale deny with the versions gate now allows', () => {
    expect(planPinUpdate({ 'contoso.linter-pro': false }, 'contoso.linter-pro', ['4.1.9'])).toEqual(
      {
        kind: 'write',
        pinMap: { 'contoso.linter-pro': ['4.1.9'] },
      },
    )
  })

  it('does not mutate the map it was given', () => {
    const current = { 'contoso.linter-pro': ['4.1.7'] }

    planPinUpdate(current, 'contoso.linter-pro', ['4.1.9'])

    expect(current).toEqual({ 'contoso.linter-pro': ['4.1.7'] })
  })
})
