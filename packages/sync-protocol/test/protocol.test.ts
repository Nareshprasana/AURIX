import { describe, expect, it } from 'vitest';
import { checkSchemaCompat, isValidPackageName, majorOf, triageVectors } from '../src/index.js';

describe('sync-protocol helpers', () => {
  it('validates package filenames (path traversal rejected)', () => {
    expect(isValidPackageName('pkg-abc_01.akpkg.json')).toBe(true);
    for (const bad of ['../evil.akpkg.json', 'a/b.akpkg.json', 'x.akpkg', 'evil.json', '.akpkg.json', 'a\\b.akpkg.json', 'x'.repeat(200) + '.akpkg.json']) {
      expect(isValidPackageName(bad)).toBe(false);
    }
  });

  it('compares schema majors', () => {
    expect(majorOf('graph-v1')).toBe(1);
    expect(checkSchemaCompat('graph-v1', 'graph-v1')).toBe('COMPATIBLE');
    expect(checkSchemaCompat('graph-v1', 'graph-v2')).toBe('UPGRADE_REQUIRED');
    expect(checkSchemaCompat('graph-v3', 'graph-v2')).toBe('UNSUPPORTED');
    expect(checkSchemaCompat('bogus', 'graph-v1')).toBe('UNSUPPORTED');
  });

  it('triages version vectors (Cases A/B)', () => {
    expect(triageVectors({ a: 80 }, { a: 100 })).toBe('BEHIND');
    expect(triageVectors({ a: 80, b: 82 }, { a: 80, c: 84 })).toBe('DIVERGED');
    expect(triageVectors({ a: 100 }, { a: 80 })).toBe('AHEAD');
    expect(triageVectors({ a: 80 }, { a: 80 })).toBe('IN_SYNC');
  });
});
