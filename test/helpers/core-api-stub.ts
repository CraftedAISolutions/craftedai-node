import { vi } from 'vitest';

export const SECRET_KEY = `cai_${'k'.repeat(43)}`;
/**
 * A well-formed app secret that is NOT the shared vectors' published one: the client refuses
 * that value (src/test-material.ts), so tests that go through `CraftedAI` must use this.
 */
export const APP_SECRET = 'kT3hJ9mQ2vXw7LpRzN5cYb8dFa1GeUo4sIiWnVj6HxA';
export const ORG_ID = '0b6f0c1e-5d6a-4d39-9a51-8f0e5c3b2a10';
export const AGENT_ID = '44444444-4444-4444-8444-444444444444';
export const NOW_MS = 1_790_000_000_000;

/** core-api's 201 mint body (EmbedSessionMintResponseSchema). */
export const MINT_RESPONSE = {
  embedSession: {
    token: `cais_${'s'.repeat(43)}`,
    expiresAt: '2026-09-21T19:15:00.000Z',
    externalUserId: 'member-1',
    agentId: AGENT_ID,
    hostOrigin: 'https://shop.example',
    frameUrl: 'https://chat.craftedai.co/embed',
    frameOrigin: 'https://chat.craftedai.co',
    refreshBeforeSeconds: 60,
  },
  branding: {
    displayName: 'Support',
    logoUrl: null,
    accentColor: '#1A6B4F',
    themeDefault: 'system',
    welcomeHeading: 'Hi',
    welcomeText: 'Ask me',
    poweredByCraftedAI: true,
  },
};

/** A fetch double answering like core-api; records every call. */
export function coreApiStub(answer: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    return Promise.resolve(answer(url, init ?? {}));
  });
  return { fetch: fetchMock as unknown as typeof fetch, calls };
}

export const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
