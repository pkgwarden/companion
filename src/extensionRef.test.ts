import { describe, expect, it } from 'vitest'

import { classifyPickerInput, parseExtensionRef, publisherOf } from './extensionRef'

describe('parseExtensionRef', () => {
  it('splits an explicit version off the extension id', () => {
    expect(parseExtensionRef('contoso.linter-pro@4.2.1')).toEqual({
      extensionId: 'contoso.linter-pro',
      version: '4.2.1',
    })
  })

  it('lowercases the id the way gate compares it', () => {
    expect(parseExtensionRef('  Contoso.Linter-Pro@4.2.1  ')).toEqual({
      extensionId: 'contoso.linter-pro',
      version: '4.2.1',
    })
  })

  it('leaves the version alone, because gate matches catalog versions byte for byte', () => {
    expect(parseExtensionRef('Contoso.Linter-Pro@4.2.1-Beta.1')).toEqual({
      extensionId: 'contoso.linter-pro',
      version: '4.2.1-Beta.1',
    })
  })

  it('reads a bare id as having no requested version', () => {
    expect(parseExtensionRef('contoso.linter-pro')).toEqual({
      extensionId: 'contoso.linter-pro',
      version: null,
    })
  })

  it('rejects a ref with no publisher separator', () => {
    expect(parseExtensionRef('linter-pro@4.2.1')).toBeNull()
  })

  it('rejects a ref whose version is empty', () => {
    expect(parseExtensionRef('contoso.linter-pro@')).toBeNull()
  })

  it('rejects a ref with more than one version separator', () => {
    expect(parseExtensionRef('contoso.linter-pro@4.2.1@4.2.2')).toBeNull()
  })

  it('rejects an id with more than one dot, as the marketplace does', () => {
    expect(parseExtensionRef('contoso.linter.pro@4.2.1')).toBeNull()
  })

  it('rejects an id carrying characters the marketplace does not allow', () => {
    expect(parseExtensionRef('contoso!.linter-pro')).toBeNull()
    expect(parseExtensionRef('-contoso.linter-pro')).toBeNull()
  })

  it('rejects a version with whitespace in it', () => {
    expect(parseExtensionRef('contoso.linter-pro@4.2.1 beta')).toBeNull()
  })

  it('rejects an empty ref', () => {
    expect(parseExtensionRef('   ')).toBeNull()
  })
})

describe('publisherOf', () => {
  it('reads the bare publisher key a wholesale allow is written under', () => {
    expect(publisherOf('contoso.linter-pro')).toBe('contoso')
  })

  it('reads an id with no separator as its own publisher', () => {
    expect(publisherOf('contoso')).toBe('contoso')
  })
})

describe('classifyPickerInput', () => {
  it('treats an empty box as nothing to do', () => {
    expect(classifyPickerInput('  ')).toEqual({ kind: 'empty' })
  })

  it('treats free text as a catalog search, case intact', () => {
    expect(classifyPickerInput(' Linter Pro ')).toEqual({ kind: 'search', query: 'Linter Pro' })
  })

  it('treats a bare extension id as a catalog search', () => {
    expect(classifyPickerInput('contoso.linter-pro')).toEqual({
      kind: 'search',
      query: 'contoso.linter-pro',
    })
  })

  it('treats an explicit version as a request to skip the search', () => {
    expect(classifyPickerInput('Contoso.Linter-Pro@4.2.1')).toEqual({
      kind: 'explicit',
      extensionId: 'contoso.linter-pro',
      version: '4.2.1',
    })
  })

  it('flags a version separator on a ref it cannot parse', () => {
    expect(classifyPickerInput('contoso@4.2.1')).toEqual({
      kind: 'malformed',
      raw: 'contoso@4.2.1',
    })
  })

  it('flags a half-typed version as malformed rather than searching for it', () => {
    expect(classifyPickerInput('contoso.linter-pro@')).toEqual({
      kind: 'malformed',
      raw: 'contoso.linter-pro@',
    })
  })
})
