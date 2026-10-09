import { describe, expect, it } from 'vitest';
import { normalizeOrigin } from './config.js';

describe('normalizeOrigin', () => {
  it('returns a bare https origin unchanged', () => {
    expect(normalizeOrigin('apiOrigin', 'https://api.craftedai.co')).toBe(
      'https://api.craftedai.co',
    );
  });

  it.each(['https://a.test/', 'https://a.test/x', 'https://a.test?q', 'https://a.test#f'])(
    'refuses %s',
    (value) => {
      expect(() => normalizeOrigin('apiOrigin', value)).toThrow(/apiOrigin/);
    },
  );
});
