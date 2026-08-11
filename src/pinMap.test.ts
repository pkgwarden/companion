import { beforeEach, describe, expect, it } from 'vitest'

import { ConfigurationTarget, recorder, resetVscodeDouble } from '../test/vscodeDouble'
import { COMPANION_EXTENSION_ID } from './constants'
import {
  ALLOWED_EXTENSIONS_SECTION,
  ALLOWED_EXTENSIONS_SETTING,
  asPinMap,
  countPinnedExtensions,
  pinMapsEqual,
  readEffectivePins,
  withSelfPinPreserved,
  writePins,
} from './pinMap'

const settingKey = `${ALLOWED_EXTENSIONS_SECTION}.${ALLOWED_EXTENSIONS_SETTING}`

beforeEach(() => {
  resetVscodeDouble()
})

describe('writePins', () => {
  it('replaces the whole allowed map with the server map instead of merging into it', async () => {
    recorder.configuration.values.set(settingKey, { 'stale.pin': ['1.0.0'] })

    await writePins({ 'contoso.linter-pro': ['4.1.9'] })

    expect(recorder.configuration.values.get(settingKey)).toEqual({
      'contoso.linter-pro': ['4.1.9'],
    })
  })

  it('writes at the global target so the pins follow the user, not one workspace', async () => {
    await writePins({ 'contoso.linter-pro': ['4.1.9'] })

    expect(recorder.configuration.globalUpdates).toEqual([
      {
        section: ALLOWED_EXTENSIONS_SECTION,
        key: ALLOWED_EXTENSIONS_SETTING,
        value: { 'contoso.linter-pro': ['4.1.9'] },
        target: ConfigurationTarget.Global,
      },
    ])
  })

  it('reports no override when the effective value reads back as written', async () => {
    expect(await writePins({ 'contoso.linter-pro': ['4.1.9'] })).toBe(false)
  })

  it('reports an override when a device policy outranks the value it wrote', async () => {
    recorder.configuration.overrides.set(settingKey, { 'contoso.linter-pro': true })

    expect(await writePins({ 'contoso.linter-pro': ['4.1.9'] })).toBe(true)
  })
})

describe('readEffectivePins', () => {
  it('reads the effective value, so a higher-precedence layer is what it sees', () => {
    recorder.configuration.values.set(settingKey, { 'contoso.linter-pro': ['4.1.9'] })
    recorder.configuration.overrides.set(settingKey, { 'contoso.linter-pro': ['4.2.1'] })

    expect(readEffectivePins()).toEqual({ 'contoso.linter-pro': ['4.2.1'] })
  })

  it('is empty when the user has never had an allowlist', () => {
    expect(readEffectivePins()).toEqual({})
  })
})

describe('withSelfPinPreserved', () => {
  it('never drops the companion pin, because losing it disables our own protection', () => {
    const merged = withSelfPinPreserved(
      { 'contoso.linter-pro': ['4.1.9'] },
      {
        [COMPANION_EXTENSION_ID]: ['0.1.0'],
      },
    )

    expect(merged).toEqual({
      'contoso.linter-pro': ['4.1.9'],
      [COMPANION_EXTENSION_ID]: ['0.1.0'],
    })
  })

  it('lets the server widen its own pin list when it sends one', () => {
    const merged = withSelfPinPreserved(
      { [COMPANION_EXTENSION_ID]: ['0.1.0', '0.2.0'] },
      {
        [COMPANION_EXTENSION_ID]: ['0.1.0'],
      },
    )

    expect(merged).toEqual({ [COMPANION_EXTENSION_ID]: ['0.1.0', '0.2.0'] })
  })

  it('invents no self pin when the user never had one', () => {
    expect(withSelfPinPreserved({ 'contoso.linter-pro': ['4.1.9'] }, {})).toEqual({
      'contoso.linter-pro': ['4.1.9'],
    })
  })
})

describe('asPinMap', () => {
  it('accepts the two encodings gate emits', () => {
    expect(asPinMap({ 'contoso.linter-pro': ['4.1.9'], contoso: true })).toEqual({
      'contoso.linter-pro': ['4.1.9'],
      contoso: true,
    })
  })

  it('drops hand-edited entries it cannot read rather than throwing mid-sync', () => {
    expect(asPinMap({ good: ['1.0.0'], bad: { nested: true }, alsoBad: [1, 2] })).toEqual({
      good: ['1.0.0'],
    })
  })

  it('is empty for anything that is not a settings object', () => {
    expect(asPinMap(undefined)).toEqual({})
    expect(asPinMap(['contoso.linter-pro'])).toEqual({})
    // `"*"` is the shipped default of extensions.allowed (observed in RV3): allow everything.
    expect(asPinMap('*')).toEqual({})
  })
})

describe('pinMapsEqual and countPinnedExtensions', () => {
  it('compares values, not key order', () => {
    expect(pinMapsEqual({ a: ['1'], b: true }, { b: true, a: ['1'] })).toBe(true)
    expect(pinMapsEqual({ a: ['1'] }, { a: ['1', '2'] })).toBe(false)
    expect(pinMapsEqual({ a: ['1'] }, { a: true })).toBe(false)
    expect(pinMapsEqual({ a: ['1'] }, {})).toBe(false)
  })

  it('counts one per pinned extension', () => {
    expect(countPinnedExtensions({ a: ['1', '2'], b: true })).toBe(2)
  })
})
