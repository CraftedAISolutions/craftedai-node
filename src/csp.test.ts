import { describe, expect, it } from 'vitest';
import { cspDirectives, formatCspDirectives } from './csp.js';

describe('csp', () => {
  it('lists the chat origin under script-src and frame-src', () => {
    expect(cspDirectives('https://chat.x.test')).toEqual({
      'script-src': ['https://chat.x.test'],
      'frame-src': ['https://chat.x.test'],
    });
  });

  it('joins directives with "; " and ends each with ";"', () => {
    expect(formatCspDirectives(cspDirectives('https://chat.x.test'))).toBe(
      'script-src https://chat.x.test; frame-src https://chat.x.test;',
    );
  });

  it('separates multiple sources with a space, never ";" or ","', () => {
    expect(
      formatCspDirectives({
        'script-src': ['https://a.test', 'https://b.test'],
        'frame-src': ['https://a.test'],
      }),
    ).toBe('script-src https://a.test https://b.test; frame-src https://a.test;');
  });
});
