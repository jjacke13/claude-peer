import { describe, expect, test } from 'bun:test'
import { autoIdentity } from './local.ts'

describe('autoIdentity (PEER_HOME)', () => {
  test('no PEER_HOME → configured identity everywhere', () => {
    expect(autoIdentity(undefined, '/r/bip-110', false, '/h')).toBeUndefined()
  })
  test('inside PEER_HOME or with a project peer.env → configured identity', () => {
    expect(autoIdentity('~/claudia', '/h/claudia', false, '/h')).toBeUndefined()
    expect(autoIdentity('/h/claudia', '/r/bip-110', true, '/h')).toBeUndefined()
  })
  test('elsewhere → name from the directory, sanitised', () => {
    expect(autoIdentity('/h/claudia', '/r/bip-110', false, '/h')).toBe('bip-110')
    expect(autoIdentity('/h/claudia', '/r/My Repo!', false, '/h')).toBe('my-repo')
    expect(autoIdentity('/h/claudia', '/r/---', false, '/h')).toBe('session')
  })
})
