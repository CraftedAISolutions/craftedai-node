/** The two CSP directives the widget needs (spec §4.2). Merge them into your own policy. */
export interface CspDirectives {
  'script-src': string[];
  'frame-src': string[];
}

export function cspDirectives(chatOrigin: string): CspDirectives {
  return { 'script-src': [chatOrigin], 'frame-src': [chatOrigin] };
}

/**
 * The directives written as CSP: sources separated by spaces, every directive ended by `;`
 * (for example `script-src X; frame-src X;`). A comma or a missing `;` would silently merge
 * the two directives in a browser, so there is exactly one place that writes the string.
 */
export function formatCspDirectives(directives: CspDirectives): string {
  const names = ['script-src', 'frame-src'] as const;
  return names.map((name) => `${name} ${directives[name].join(' ')};`).join(' ');
}
