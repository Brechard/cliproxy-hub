import { describe, expect, test } from 'bun:test';
import {
  QuotaHistoryError,
  clearPreferredServiceUrls,
  defaultServiceUrl,
  fetchQuotaHistory,
  fetchQuotaHistoryFrom,
  normalizeServiceUrl,
  parseQuotaHistory,
  serviceUrlCandidates,
} from '../src/features/quotaHistory/api';
import { QUOTA_HISTORY_BUNDLES } from '../src/features/quotaHistory/i18n';
import i18n from '../src/i18n/index';

const KEY = 'secret-management-key';

const payload = {
  now: 1000,
  accounts: [
    {
      name: 'Team',
      priority: 20,
      sampled: 990,
      latest: [{ label: 'Weekly', percent: 12, reset: 5000 }, { label: 3 }],
      series: {
        Weekly: [
          [300, 11, 5000],
          [100, 10, null],
          ['bad', 1, null],
        ],
        Empty: [],
      },
    },
    { name: 42 },
  ],
};

const respond = (status: number, body: unknown = payload): typeof fetch =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe('service address', () => {
  test('defaults to the proxy host on port 8318 over the panel protocol', () => {
    expect(
      defaultServiceUrl('http://127.0.0.1:8317', { protocol: 'http:', hostname: 'localhost' })
    ).toBe('http://127.0.0.1:8318');
    expect(
      defaultServiceUrl('https://proxy.example.com:8317', { protocol: 'https:', hostname: 'x' })
    ).toBe('https://proxy.example.com:8318');
    expect(defaultServiceUrl('', { protocol: 'http:', hostname: 'panel.local' })).toBe(
      'http://panel.local:8318'
    );
  });

  test('tries the proxy origin first, then its host on port 8318', () => {
    const at = (href: string) => {
      const url = new URL(href);
      return { protocol: url.protocol, hostname: url.hostname, origin: url.origin };
    };
    // Tailscale Funnel: only 8443 is public, so the same-origin path is the one that works.
    const funnel = 'https://omarchy.example.ts.net:8443';
    expect(serviceUrlCandidates(funnel, at(`${funnel}/management.html`))).toEqual([
      funnel,
      'https://omarchy.example.ts.net:8318',
    ]);
    expect(serviceUrlCandidates('', at('https://omarchy.example.ts.net/management.html'))).toEqual([
      'https://omarchy.example.ts.net',
      'https://omarchy.example.ts.net:8318',
    ]);
    expect(
      serviceUrlCandidates('http://127.0.0.1:8317', at('http://127.0.0.1:8317/management.html'))
    ).toEqual(['http://127.0.0.1:8317', 'http://127.0.0.1:8318']);
  });

  test('normalizes user overrides', () => {
    expect(normalizeServiceUrl(' 10.0.0.2:8318/ ')).toBe('http://10.0.0.2:8318');
    expect(normalizeServiceUrl('https://h.example')).toBe('https://h.example');
    expect(normalizeServiceUrl('  ')).toBe('');
  });
});

describe('parseQuotaHistory', () => {
  test('drops malformed rows and sorts every series by time', () => {
    const parsed = parseQuotaHistory(payload);
    expect(parsed.accounts).toHaveLength(1);
    expect(parsed.accounts[0].series).toEqual({
      Weekly: [
        [100, 10, null],
        [300, 11, 5000],
      ],
    });
    expect(parsed.accounts[0].latest).toEqual([{ label: 'Weekly', percent: 12, reset: 5000 }]);
  });

  test('reads the provider, treats a missing one as Claude and skips unknown ones', () => {
    const parsed = parseQuotaHistory({
      now: 1,
      accounts: [
        { name: 'Old', series: {} },
        { name: 'Greg', provider: 'codex', series: {} },
        { name: 'X', provider: 'gemini', series: {} },
      ],
    });
    expect(parsed.accounts.map((a) => [a.name, a.provider])).toEqual([
      ['Old', 'claude'],
      ['Greg', 'codex'],
    ]);
  });

  test('rejects a body that is not a history response', () => {
    expect(() => parseQuotaHistory({ accounts: [] })).toThrow(QuotaHistoryError);
  });
});

describe('fetchQuotaHistory', () => {
  test('sends the key as a bearer token to the requested range', async () => {
    let seen: { url: string; headers: Headers } | null = null;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen = { url: String(input), headers: new Headers(init?.headers) };
      return new Response(JSON.stringify(payload));
    }) as typeof fetch;
    const result = await fetchQuotaHistory({
      baseUrl: 'http://127.0.0.1:8318/',
      managementKey: KEY,
      days: 7,
      fetchImpl,
    });
    expect(result.now).toBe(1000);
    expect(seen!.url).toBe('http://127.0.0.1:8318/v1/quota-history?days=7');
    expect(seen!.headers.get('Authorization')).toBe(`Bearer ${KEY}`);
  });

  test('maps 401 to unauthorized and everything else to unavailable, without leaking the key', async () => {
    const failures: Array<[typeof fetch, string]> = [
      [respond(401, {}), 'unauthorized'],
      [respond(500, {}), 'unavailable'],
      [
        (async () => {
          throw new TypeError(`Failed to fetch with ${KEY}`);
        }) as unknown as typeof fetch,
        'unavailable',
      ],
      [(async () => new Response('<html>')) as unknown as typeof fetch, 'unavailable'],
    ];
    for (const [fetchImpl, kind] of failures) {
      const error = await fetchQuotaHistory({
        baseUrl: 'http://h:8318',
        managementKey: KEY,
        days: 1,
        fetchImpl,
      }).catch((err: unknown) => err);
      expect(error).toBeInstanceOf(QuotaHistoryError);
      expect((error as QuotaHistoryError).kind).toBe(kind);
      expect((error as QuotaHistoryError).message).not.toContain(KEY);
    }
  });

  test('rethrows aborts so callers can tell them from outages', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = (async () => {
      throw new DOMException('aborted', 'AbortError');
    }) as unknown as typeof fetch;
    const error = await fetchQuotaHistory({
      baseUrl: 'http://h:8318',
      managementKey: KEY,
      days: 1,
      fetchImpl,
      signal: controller.signal,
    }).catch((err: unknown) => err);
    expect(error).not.toBeInstanceOf(QuotaHistoryError);
  });
});

describe('fetchQuotaHistoryFrom', () => {
  const ORIGIN = 'https://proxy.example:8443';
  const PORT = 'https://proxy.example:8318';
  type Reply = number | 'down' | { status: number; signed: boolean };
  const server = (replies: Record<string, Reply>) => {
    const seen: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const base = new URL(String(input)).origin;
      seen.push(base);
      const reply = replies[base];
      if (reply === undefined || reply === 'down') throw new TypeError('Failed to fetch');
      const { status, signed } =
        typeof reply === 'number' ? { status: reply, signed: true } : reply;
      return new Response(status === 200 ? JSON.stringify(payload) : '', {
        status,
        headers: signed ? { 'X-Quota-History': '1' } : {},
      });
    }) as unknown as typeof fetch;
    return { seen, fetchImpl };
  };
  const run = (fetchImpl: typeof fetch) =>
    fetchQuotaHistoryFrom({ baseUrls: [ORIGIN, PORT], managementKey: KEY, days: 1, fetchImpl });

  test('falls back to port 8318 when the origin does not serve history, and remembers it', async () => {
    clearPreferredServiceUrls();
    const { seen, fetchImpl } = server({ [ORIGIN]: { status: 404, signed: false }, [PORT]: 200 });
    expect((await run(fetchImpl)).baseUrl).toBe(PORT);
    expect(seen).toEqual([ORIGIN, PORT]);
    seen.length = 0;
    await run(fetchImpl);
    expect(seen).toEqual([PORT]);
  });

  test('uses the origin when it answers', async () => {
    clearPreferredServiceUrls();
    const { seen, fetchImpl } = server({ [ORIGIN]: 200 });
    expect((await run(fetchImpl)).baseUrl).toBe(ORIGIN);
    expect(seen).toEqual([ORIGIN]);
  });

  test('a 401 signed by the router stops the search', async () => {
    clearPreferredServiceUrls();
    const { seen, fetchImpl } = server({ [ORIGIN]: 401, [PORT]: 200 });
    const error = await run(fetchImpl).catch((err: unknown) => err);
    expect((error as QuotaHistoryError).kind).toBe('unauthorized');
    expect(seen).toEqual([ORIGIN]);
  });

  test('an unsigned 401 is another server, unless no later address answers', async () => {
    clearPreferredServiceUrls();
    const unsigned = { status: 401, signed: false };
    expect((await run(server({ [ORIGIN]: unsigned, [PORT]: 200 }).fetchImpl)).baseUrl).toBe(PORT);
    clearPreferredServiceUrls();
    const lastRejects = await run(server({ [ORIGIN]: 'down', [PORT]: unsigned }).fetchImpl).catch(
      (err: unknown) => err
    );
    expect((lastRejects as QuotaHistoryError).kind).toBe('unauthorized');
    clearPreferredServiceUrls();
    const allDown = await run(server({}).fetchImpl).catch((err: unknown) => err);
    expect((allDown as QuotaHistoryError).kind).toBe('unavailable');
  });
});

describe('quota history strings', () => {
  const placeholders = (text: string) => [...text.matchAll(/{{(\w+)}}/g)].map((m) => m[1]).sort();
  const english = QUOTA_HISTORY_BUNDLES.en;

  test('covers all seven languages with the same keys and placeholders', () => {
    expect(Object.keys(QUOTA_HISTORY_BUNDLES).sort()).toEqual(
      ['en', 'ko', 'ru', 'tr', 'vi', 'zh-CN', 'zh-TW'].sort()
    );
    for (const [lng, bundle] of Object.entries(QUOTA_HISTORY_BUNDLES)) {
      expect(Object.keys(bundle).sort()).toEqual(Object.keys(english).sort());
      for (const [key, text] of Object.entries(bundle)) {
        expect(placeholders(text), `${lng}.${key}`).toEqual(
          placeholders(english[key as keyof typeof english])
        );
      }
    }
  });

  test('registers into the shared translation namespace', () => {
    for (const lng of Object.keys(QUOTA_HISTORY_BUNDLES)) {
      expect(i18n.getResource(lng, 'translation', 'quota_history.title')).toBeString();
    }
    expect(i18n.getResource('en', 'translation', 'quota_management.sort_label')).toBeString();
  });
});
