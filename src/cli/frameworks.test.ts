import { describe, expect, it } from 'vitest';
import {
  cspSnippet,
  detectFramework,
  FRAMEWORKS,
  routeSnippet,
  widgetSnippet,
  type Framework,
} from './frameworks.js';

const deps = (...names: string[]) => ({
  dependencies: Object.fromEntries(names.map((name) => [name, '1.0.0'])),
});

describe('detectFramework', () => {
  it.each<[string, unknown, Framework]>([
    ['next', deps('next', 'react', 'express'), 'next'],
    ['react-router', deps('react-router', '@react-router/node'), 'react-router'],
    ['remix', deps('@remix-run/node', '@remix-run/react'), 'remix'],
    ['hono', deps('hono', '@hono/node-server'), 'hono'],
    ['fastify', deps('fastify'), 'fastify'],
    ['express', deps('express', 'cors'), 'express'],
    ['node', deps('left-pad'), 'node'],
    ['node', {}, 'node'],
    ['node', null, 'node'],
    ['node', 'not an object', 'node'],
  ])('%s', (_name, packageJson, expected) => {
    expect(detectFramework(packageJson)).toBe(expected);
  });

  it('reads devDependencies too, and ignores inherited names', () => {
    expect(detectFramework({ devDependencies: { fastify: '5' } })).toBe('fastify');
    expect(detectFramework({ dependencies: Object.create({ express: '5' }) as object })).toBe(
      'node',
    );
  });
});

describe('routeSnippet', () => {
  it.each(FRAMEWORKS)(
    '%s: imports the package, builds the client and mentions publicUrl and CSP',
    (fw) => {
      const snippet = routeSnippet(fw);
      expect(snippet).toContain("from '@craftedai/node'");
      expect(snippet).toContain('new CraftedAI()');
      expect(snippet).toMatch(/\/\/[^\n]*publicUrl[^\n]*/);
      expect(snippet).toMatch(/proxy or load balancer/);
      expect(snippet).toContain('cspDirectiveString()');
      expect(snippet).toContain('/craftedai/session');
    },
  );

  it('express: mounts the guard before any body parser (spec §12.3)', () => {
    const snippet = routeSnippet('express');
    expect(snippet).toContain('craftedai.express.verifyRequest(');
    expect(snippet).toContain('craftedai.express.sessionHandler(');
    expect(snippet.indexOf('verifyRequest(')).toBeLessThan(
      snippet.indexOf('app.use(express.json())'),
    );
    expect(snippet).toMatch(/BEFORE[^\n]*body parser/i);
  });

  it('fastify: protects an encapsulated scope and reads the context from the adapter', () => {
    const snippet = routeSnippet('fastify');
    expect(snippet).toContain('app.register(');
    expect(snippet).toContain('craftedai.fastify.protect(');
    expect(snippet).toContain('craftedai.fastify.context(request)');
    expect(snippet).toContain('craftedai.fastify.sessionHandler(');
    expect(snippet.indexOf('protect(')).toBeLessThan(snippet.indexOf("post('/mcp'"));
  });

  it.each(['next', 'react-router', 'remix', 'hono', 'node'] as const)(
    '%s: uses the web-standard adapter and does not read the body before the guard',
    (fw) => {
      const snippet = routeSnippet(fw);
      expect(snippet).toContain('craftedai.fetch.sessionHandler(');
      expect(snippet).toContain('craftedai.fetch.verifyRequest(');
      expect(snippet).not.toContain('craftedai.express');
      expect(snippet).toMatch(/before[^\n]*(request\.json|read the body|body)/i);
    },
  );

  it('names only adapter members that exist', () => {
    const names = new Set<string>();
    for (const fw of FRAMEWORKS) {
      for (const m of routeSnippet(fw).matchAll(/craftedai\.(express|fastify|fetch)\.(\w+)/g)) {
        names.add(`${m[1]}.${m[2]}`);
      }
    }
    expect([...names].sort()).toEqual([
      'express.sessionHandler',
      'express.verifyRequest',
      'fastify.context',
      'fastify.protect',
      'fastify.sessionHandler',
      'fetch.sessionHandler',
      'fetch.verifyRequest',
    ]);
  });
});

describe('widgetSnippet and cspSnippet', () => {
  it('fills the chat origin and the agent id', () => {
    expect(widgetSnippet('https://chat.craftedai.co', 'agent-1')).toBe(
      '<script src="https://chat.craftedai.co/widget.js" data-agent="agent-1"\n        data-session-endpoint="/craftedai/session" async></script>',
    );
  });

  it('writes the two directives for the chat origin, as CSP text', () => {
    expect(cspSnippet('https://chat.staging.craftedai.co')).toContain(
      'script-src https://chat.staging.craftedai.co; frame-src https://chat.staging.craftedai.co;',
    );
  });
});
