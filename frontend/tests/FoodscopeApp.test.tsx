import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FoodscopeApp, REQUEST_TIMEOUT_MS } from '@/components/FoodscopeApp';

vi.mock('next/image', () => ({
  default: ({ src, alt, sizes, loading, decoding, onError, onLoad }: {
    src: string; alt: string; sizes?: string; loading?: string; decoding?: string;
    onError?: () => void; onLoad?: () => void;
  }) => (
    <button
      type="button"
      aria-label={alt}
      data-image-src={src}
      data-sizes={sizes}
      data-loading={loading}
      data-decoding={decoding}
      onClick={onError}
      onDoubleClick={onLoad}
    />
  ),
}));

const accountState = (overrides: Partial<{
  nutritionAccess: boolean;
  billingAvailable: boolean;
  checkoutAvailable: boolean;
  subscriptionManagementAvailable: boolean;
  cancellationScheduled: boolean;
  currentPeriodEnd: string | null;
}> = {}) => ({
  nutritionAccess: false,
  billingAvailable: true,
  checkoutAvailable: true,
  subscriptionManagementAvailable: overrides.nutritionAccess === true &&
    overrides.billingAvailable !== false,
  cancellationScheduled: false,
  currentPeriodEnd: overrides.nutritionAccess === true ? '2100-01-01T00:00:00.000Z' : null,
  ...overrides,
});
const checkoutMarkerKey = 'foodscope.checkout-initiated-at';
const markCheckoutInitiated = () => window.sessionStorage.setItem(
  checkoutMarkerKey,
  String(Date.now()),
);

describe('Foodscope locale switching', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    window.sessionStorage.clear();
    window.history.replaceState(null, '', '/');
  });

  it('updates application-controlled text and uses the chosen locale for search', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      void init;
      const url = String(input);
      const body = url.includes('/api/user')
        ? accountState()
        : url.includes('/api/searches/recent')
          ? { searches: [] }
          : { products: [], account: accountState() };
      return { ok: true, json: async () => body } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<FoodscopeApp />);

    await screen.findByText('Free plan');
    const searchTips = screen.getByRole('region', { name: 'Find the right product faster.' });
    expect(searchTips.querySelectorAll('li')).toHaveLength(3);
    expect(screen.getByText('Use a product name')).toBeInTheDocument();
    expect(screen.queryByText('Start with a product you are curious about.')).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.find(([url]) => String(url).includes('/api/user'))?.[1])
      .toMatchObject({ cache: 'no-store' });

    await userEvent.selectOptions(screen.getByLabelText('Language'), 'de');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Wissen, wasdrin ist.');
    expect(screen.getByRole('heading', { level: 2, name: 'Finde schneller das richtige Produkt.' }))
      .toBeInTheDocument();
    expect(screen.getByText(/Angaben können unvollständig oder falsch sein/)).toBeInTheDocument();
    expect(document.querySelector('.attribution')).toHaveTextContent('Enthält Informationen von');
    await userEvent.type(screen.getByLabelText('Produkte suchen'), 'Hafermilch');
    await userEvent.click(screen.getByRole('button', { name: /Suchen/ }));
    const searchCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/api/products/search'));
    expect(searchCall?.[1]).toMatchObject({
      cache: 'no-store',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    const searchBody = JSON.parse(String(searchCall?.[1]?.body)) as Record<string, unknown>;
    expect(searchBody).toMatchObject({ q: 'Hafermilch', lang: 'de' });
    expect(searchBody.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('does not submit an invisible or control-character search', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const body = String(input).includes('/api/user')
        ? accountState()
        : { searches: [] };
      return { ok: true, json: async () => body } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<FoodscopeApp />);

    await screen.findByText('Free plan');
    const input = screen.getByLabelText('Search products');
    fireEvent.change(input, { target: { value: '\u200b' } });
    expect(screen.getByRole('button', { name: /^Search/ })).toBeDisabled();

    fireEvent.change(input, { target: { value: 'milk\u0000' } });
    fireEvent.submit(input.closest('form')!);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/api/products/search')))
      .toBe(false);

    fireEvent.change(input, { target: { value: 'milk\u202e.txt' } });
    expect(screen.getByRole('button', { name: /^Search/ })).toBeDisabled();

    fireEvent.change(input, { target: { value: 'family 👨‍👩‍👧‍👦 pack' } });
    expect(screen.getByRole('button', { name: /^Search/ })).toBeEnabled();
  });

  it('links the product data and image attribution to their licenses', () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const body = String(input).includes('/api/user')
        ? accountState()
        : { searches: [] };
      return { ok: true, json: async () => body } as Response;
    }));

    render(<FoodscopeApp />);

    expect(screen.getByRole('link', { name: 'Open Food Facts' })).toHaveAttribute(
      'href',
      'https://world.openfoodfacts.org/',
    );
    expect(screen.getByRole('link', { name: 'ODbL' })).toHaveAttribute(
      'href',
      'https://opendatacommons.org/licenses/odbl/1-0/',
    );
    expect(screen.getByRole('link', { name: 'CC BY-SA 3.0' })).toHaveAttribute(
      'href',
      'https://creativecommons.org/licenses/by-sa/3.0/',
    );
    const footerNavigation = screen.getByRole('navigation', { name: 'Footer' });
    expect(footerNavigation).toContainElement(screen.getByRole('link', { name: 'Search products' }));
    expect(screen.getByRole('link', { name: 'Search products' })).toHaveAttribute('href', '#search');
    expect(screen.getByRole('link', { name: 'Foodscope Plus' })).toHaveAttribute('href', '#plus');
    expect(screen.queryByRole('link', { name: 'Back to top' })).not.toBeInTheDocument();
  });

  it('reveals a fixed back-to-top button after scrolling and respects reduced motion', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const body = String(input).includes('/api/user')
        ? accountState()
        : { searches: [] };
      return { ok: true, json: async () => body } as Response;
    }));
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })));
    const scrollTo = vi.fn();
    vi.stubGlobal('scrollTo', scrollTo);
    render(<FoodscopeApp />);

    const backToTop = screen.getByText('Back to top', { selector: 'button' });
    expect(backToTop).toHaveAttribute('aria-hidden', 'true');

    vi.stubGlobal('scrollY', 600);
    fireEvent.scroll(window);
    expect(backToTop).toHaveClass('back-to-top-visible');
    expect(backToTop).toHaveAttribute('aria-hidden', 'false');

    await userEvent.click(backToTop);
    expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'auto' });
    expect(document.querySelector('#content')).toHaveFocus();
  });

  it.each([
    {},
    { searches: 'not-an-array' },
    { searches: [{ id: 1, query: null, locale: 'en', createdAt: '' }] },
    { searches: [{ query: '\u200b', locale: 'en' }] },
    { searches: Array.from({ length: 9 }, (_value, index) => ({
      id: index + 1, query: `query-${index}`, locale: 'en', createdAt: '',
    })) },
  ])('ignores malformed recent-search response %# without crashing', async (recentResponse) => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const body = String(input).includes('/api/user') ? accountState() : recentResponse;
      return { ok: true, json: async () => body } as Response;
    }));

    render(<FoodscopeApp />);

    expect(await screen.findByText('Free plan')).toBeInTheDocument();
    expect(screen.queryByText('Recent searches')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Search products')).toBeEnabled();
  });

  it('reports a recent-search failure and recovers through an explicit retry', async () => {
    let recentReads = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/api/user')) {
        return { ok: true, json: async () => accountState() } as Response;
      }
      if (url.includes('/api/searches/recent')) {
        recentReads += 1;
        if (recentReads === 1) return { ok: false, status: 503 } as Response;
        return {
          ok: true,
          json: async () => ({ searches: [{ query: 'recovered oats', locale: 'en' }] }),
        } as Response;
      }
      throw new Error(`Unexpected request: ${url}`);
    }));

    render(<FoodscopeApp />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Recent searches are unavailable.');
    await userEvent.click(screen.getByRole('button', { name: 'Retry recent searches' }));
    expect(await screen.findByRole('button', { name: 'recovered oats EN' })).toBeInTheDocument();
    expect(screen.queryByText('Recent searches are unavailable.')).not.toBeInTheDocument();
    expect(recentReads).toBe(2);
  });

  it('distinguishes identical recent queries by their search locale', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const body = String(input).includes('/api/user')
        ? accountState()
        : { searches: [
            { id: 1, query: 'cola', locale: 'en' },
            { id: 2, query: 'cola', locale: 'de' },
          ] };
      return { ok: true, json: async () => body } as Response;
    }));

    render(<FoodscopeApp />);

    expect(await screen.findByRole('button', { name: 'cola EN' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'cola DE' })).toBeInTheDocument();
  });

  it('accepts persisted queries within the server Unicode length limit', async () => {
    const query = '😀'.repeat(80);
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const body = String(input).includes('/api/user')
        ? accountState()
        : { searches: [{ query, locale: 'en' }] };
      return { ok: true, json: async () => body } as Response;
    }));

    render(<FoodscopeApp />);

    expect(await screen.findByRole('button', { name: `${query} EN` })).toBeInTheDocument();
  });

  it('allows typing a valid Unicode query regardless of UTF-16 width', async () => {
    const query = '😀'.repeat(80);
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const body = String(input).includes('/api/user')
        ? accountState()
        : { searches: [] };
      return { ok: true, json: async () => body } as Response;
    }));
    render(<FoodscopeApp />);

    const input = screen.getByLabelText('Search products');
    await userEvent.type(input, query);

    expect(input).toHaveValue(query);
    expect(screen.getByRole('button', { name: /^Search/ })).toBeEnabled();

    fireEvent.change(input, { target: { value: 'a'.repeat(121) } });
    expect(screen.getByRole('button', { name: /^Search/ })).toBeDisabled();
  });

  it('aborts an older search and ignores its stale response', async () => {
    let resolveFirst!: (response: Response) => void;
    let resolveSecond!: (response: Response) => void;
    const first = new Promise<Response>((resolve) => { resolveFirst = resolve; });
    const second = new Promise<Response>((resolve) => { resolveSecond = resolve; });
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/user')) return { ok: true, json: async () => accountState() } as Response;
      if (url.includes('/api/searches/recent')) {
        return { ok: true, json: async () => ({ searches: [
          { query: 'first', locale: 'en' },
          { query: 'second', locale: 'de' },
        ] }) } as Response;
      }
      const searchBody = init?.body ? JSON.parse(String(init.body)) as { q?: string } : {};
      if (searchBody.q === 'first') return first;
      if (searchBody.q === 'second') return second;
      throw new Error(`Unexpected request: ${url} ${String(init)}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<FoodscopeApp />);

    await userEvent.click(await screen.findByRole('button', { name: 'first EN' }));
    await userEvent.click(screen.getByRole('button', { name: 'second DE' }));

    expect(screen.getByLabelText('Produkte suchen')).toHaveValue('second');
    expect(screen.getByLabelText('Sprache')).toHaveValue('de');

    const searchCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/products/search'));
    expect(searchCalls[0]?.[1]?.signal?.aborted).toBe(true);
    await act(async () => resolveSecond({
      ok: true,
      json: async () => ({
        products: [{ id: '2', name: 'Neu', brand: null, image: null, nutritionLocked: true }],
        account: accountState(),
      }),
    } as Response));
    expect(await screen.findByRole('heading', { name: 'Neu' })).toBeInTheDocument();

    await act(async () => resolveFirst({
      ok: true,
      json: async () => ({
        products: [{ id: '1', name: 'Old', brand: null, image: null, nutritionLocked: true }],
        account: accountState(),
      }),
    } as Response));
    expect(screen.queryByRole('heading', { name: 'Old' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Neu' })).toBeInTheDocument();
  });

  it('deduplicates repeated activation of the same in-flight recent search', async () => {
    let resolveSearch!: (response: Response) => void;
    const pendingSearch = new Promise<Response>((resolve) => { resolveSearch = resolve; });
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/api/user')) {
        return { ok: true, json: async () => accountState() } as Response;
      }
      if (url.includes('/api/searches/recent')) {
        return { ok: true, json: async () => ({ searches: [
          { id: 1, query: 'oats', locale: 'en', createdAt: '' },
        ] }) } as Response;
      }
      return pendingSearch;
    });
    vi.stubGlobal('fetch', fetchMock);
    const view = render(<FoodscopeApp />);

    const recentSearch = await screen.findByRole('button', { name: 'oats EN' });
    await userEvent.dblClick(recentSearch);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/products/search')))
      .toHaveLength(1);
    expect(view.container.querySelector('.results-section')).toHaveAttribute('aria-busy', 'true');
    expect(view.container.querySelectorAll('.skeleton-card')).toHaveLength(4);
    expect(screen.getByText('Searching…', { selector: '.sr-only' })).toBeInTheDocument();

    await act(async () => resolveSearch({
      ok: true,
      json: async () => ({ products: [], account: accountState() }),
    } as Response));
    expect(view.container.querySelectorAll('.skeleton-card')).toHaveLength(0);
  });

  it('reuses the operation id when retrying an uncertain search result', async () => {
    const operationIds: string[] = [];
    let searchAttempts = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/user')) {
        return { ok: true, json: async () => accountState() } as Response;
      }
      if (url.includes('/api/searches/recent')) {
        return { ok: true, json: async () => ({ searches: [] }) } as Response;
      }
      const body = JSON.parse(String(init?.body)) as { requestId: string };
      operationIds.push(body.requestId);
      searchAttempts += 1;
      return searchAttempts === 1
        ? { ok: false, status: 502 } as Response
        : { ok: true, json: async () => ({ products: [], account: accountState() }) } as Response;
    }));
    render(<FoodscopeApp />);

    await userEvent.type(screen.getByLabelText('Search products'), 'oats');
    await userEvent.click(screen.getByRole('button', { name: /^Search/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('We could not complete that search');
    await userEvent.click(screen.getByRole('button', { name: /^Search/ }));
    expect(await screen.findByText(/No matching products found/)).toBeInTheDocument();

    expect(operationIds).toHaveLength(2);
    expect(operationIds[1]).toBe(operationIds[0]);
  });

  it('finishes a successful search while recent-history refresh remains pending', async () => {
    let recentReads = 0;
    let secondRecentSignal: AbortSignal | null | undefined;
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/user')) {
        return Promise.resolve({ ok: true, json: async () => accountState() } as Response);
      }
      if (url.includes('/api/searches/recent')) {
        recentReads += 1;
        if (recentReads === 1) {
          return Promise.resolve({ ok: true, json: async () => ({ searches: [] }) } as Response);
        }
        secondRecentSignal = init?.signal;
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
        });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ products: [], account: accountState() }),
      } as Response);
    }));
    const view = render(<FoodscopeApp />);
    await screen.findByText('Free plan');

    await userEvent.type(screen.getByLabelText('Search products'), 'oats');
    await userEvent.click(screen.getByRole('button', { name: /^Search/ }));

    expect(await screen.findByText(/No matching products found/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Search/ })).toBeEnabled();
    expect(secondRecentSignal?.aborted).toBe(false);

    view.unmount();
    expect(secondRecentSignal?.aborted).toBe(true);
  });

  it.each([
    {},
    { products: [] },
    { products: 'not-an-array', account: accountState() },
    { products: [{ id: 'unsafe', name: 'Unsafe', brand: null, image: null, nutritionLocked: true,
      nutrition: { fat: { value: 1, unit: 'g' } } }], account: accountState() },
    { products: [{ id: 'invalid-unit', name: 'Invalid', brand: null, image: null,
      nutritionLocked: false, nutrition: { fat: { value: 1, unit: 'kcal' } } }], account: accountState() },
    { products: [], account: { nutritionAccess: false } },
  ])('reports a recoverable error for malformed product response %#', async (body) => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/api/user')) {
        return { ok: true, json: async () => accountState() } as Response;
      }
      if (url.includes('/api/searches/recent')) {
        return { ok: true, json: async () => ({ searches: [] }) } as Response;
      }
      return { ok: true, json: async () => body } as Response;
    }));
    render(<FoodscopeApp />);

    await userEvent.type(screen.getByLabelText('Search products'), 'oats');
    await userEvent.click(screen.getByRole('button', { name: /^Search/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent('We could not complete that search');
    expect(screen.queryByRole('heading', { name: 'Unsafe' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Search/ })).toBeEnabled();
  });

  it('fails closed on a search response without authoritative account state', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      const body = url.includes('/api/user')
        ? accountState({ nutritionAccess: true, checkoutAvailable: false })
        : url.includes('/api/searches/recent')
          ? { searches: [] }
          : { products: [{
              id: 'locked', name: 'Locked result', brand: null, image: null,
              nutritionLocked: true,
            }] };
      return { ok: true, json: async () => body } as Response;
    }));
    render(<FoodscopeApp />);

    expect(await screen.findByText('Foodscope Plus', { selector: '#plan-title' })).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Search products'), 'oats');
    await userEvent.click(screen.getByRole('button', { name: /^Search/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent('We could not complete that search');
    expect(screen.getByText('Plan status unavailable')).toBeInTheDocument();
    expect(screen.queryByText('Foodscope Plus', { selector: '#plan-title' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Locked result' })).not.toBeInTheDocument();
  });

  it('applies authoritative revocation even when product data is malformed', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      const body = url.includes('/api/user')
        ? accountState({ nutritionAccess: true, checkoutAvailable: false })
        : url.includes('/api/searches/recent')
          ? { searches: [] }
          : { products: 'malformed', account: accountState() };
      return { ok: true, json: async () => body } as Response;
    }));
    render(<FoodscopeApp />);

    expect(await screen.findByText('Foodscope Plus', { selector: '#plan-title' })).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Search products'), 'oats');
    await userEvent.click(screen.getByRole('button', { name: /^Search/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent('We could not complete that search');
    expect(screen.getByText('Free plan')).toBeInTheDocument();
    expect(screen.queryByText('Foodscope Plus', { selector: '#plan-title' })).not.toBeInTheDocument();
  });

  it('renders the explicit normalized nutrition value and unit', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      const body = url.includes('/api/user')
        ? accountState({ nutritionAccess: true, checkoutAvailable: false })
        : url.includes('/api/searches/recent')
          ? { searches: [] }
          : { products: [{
              id: 'nutrition', name: 'Oats', brand: null, image: null, nutritionLocked: false,
              nutrition: { energyKcal: { value: 44, unit: 'kcal' }, fat: { value: 1.5, unit: 'g' } },
            }], account: accountState({ nutritionAccess: true, checkoutAvailable: false }) };
      return { ok: true, json: async () => body } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<FoodscopeApp />);

    await userEvent.type(screen.getByLabelText('Search products'), 'oats');
    await userEvent.click(screen.getByRole('button', { name: /^Search/ }));

    expect(await screen.findByRole('heading', { level: 2, name: 'Search results' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 3, name: 'Oats' })).toBeInTheDocument();
    expect(await screen.findByText('44 kcal')).toBeInTheDocument();
    expect(screen.getByText('1.5 g')).toBeInTheDocument();
  });

  it('keeps the hero stable and scrolls to the loading results with motion preferences', async () => {
    const scrollIntoView = vi.fn();
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })));
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      const body = url.includes('/api/user')
        ? accountState()
        : url.includes('/api/searches/recent')
          ? { searches: [] }
          : { products: [], account: accountState() };
      return { ok: true, json: async () => body } as Response;
    }));
    const view = render(<FoodscopeApp />);
    const hero = view.container.querySelector('.hero');
    const results = view.container.querySelector('.results-section') as HTMLElement;
    Object.defineProperty(results, 'scrollIntoView', { value: scrollIntoView });

    await screen.findByText('Free plan');
    expect(hero).toHaveClass('hero');
    expect(hero).not.toHaveClass('hero-with-results');
    expect(scrollIntoView).not.toHaveBeenCalled();

    await userEvent.type(screen.getByLabelText('Search products'), 'oats');
    await userEvent.click(screen.getByRole('button', { name: /^Search/ }));

    expect(await screen.findByText('No matching products found. Try another term.'))
      .toBeInTheDocument();
    expect(hero).not.toHaveClass('hero-with-results');
    expect(scrollIntoView).toHaveBeenCalledOnce();
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'auto', block: 'start' });
  });

  it('requests search results in scroll-driven pages of four with a manual fallback', async () => {
    let intersectionCallback!: IntersectionObserverCallback;
    const observe = vi.fn();
    const disconnect = vi.fn();
    vi.stubGlobal('IntersectionObserver', vi.fn((callback: IntersectionObserverCallback) => {
      intersectionCallback = callback;
      return {
        root: null,
        rootMargin: '0px 0px -35% 0px',
        thresholds: [0],
        observe,
        unobserve: vi.fn(),
        disconnect,
        takeRecords: () => [],
      } as IntersectionObserver;
    }));
    const products = Array.from({ length: 10 }, (_, index) => ({
      id: `product-${index + 1}`,
      name: `Product ${index + 1}`,
      brand: null,
      image: null,
      nutritionLocked: true,
    }));
    const requestedPages: number[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      let body;
      if (url.includes('/api/user')) body = accountState();
      else if (url.includes('/api/searches/recent')) body = { searches: [] };
      else {
        const requestBody = JSON.parse(String(init?.body)) as { page: number };
        requestedPages.push(requestBody.page);
        const start = (requestBody.page - 1) * 4;
        const pageProducts = products.slice(start, start + 4);
        const hasMore = start + pageProducts.length < products.length;
        body = {
          products: pageProducts,
          account: accountState(),
          hasMore,
          nextPage: hasMore ? requestBody.page + 1 : null,
        };
      }
      return { ok: true, json: async () => body } as Response;
    }));
    render(<FoodscopeApp />);

    await userEvent.type(screen.getByLabelText('Search products'), 'snacks');
    await userEvent.click(screen.getByRole('button', { name: /^Search/ }));

    expect(await screen.findByRole('heading', { level: 3, name: 'Product 4' })).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { level: 3 })).toHaveLength(4);
    expect(screen.queryByText(/products shown/i)).not.toBeInTheDocument();
    expect(requestedPages).toEqual([1]);
    expect(observe).toHaveBeenCalledOnce();

    await act(async () => intersectionCallback(
      [{ isIntersecting: true } as IntersectionObserverEntry],
      {} as IntersectionObserver,
    ));
    expect(await screen.findByRole('heading', { level: 3, name: 'Product 8' })).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { level: 3 })).toHaveLength(8);
    expect(requestedPages).toEqual([1, 2]);

    await userEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByRole('heading', { level: 3, name: 'Product 10' })).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { level: 3 })).toHaveLength(10);
    expect(requestedPages).toEqual([1, 2, 3]);
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
    expect(disconnect).toHaveBeenCalled();
  });

  it('removes previously loaded nutrition when a later page observes revocation', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/user')) {
        return {
          ok: true,
          json: async () => accountState({ nutritionAccess: true, checkoutAvailable: false }),
        } as Response;
      }
      if (url.includes('/api/searches/recent')) {
        return { ok: true, json: async () => ({ searches: [] }) } as Response;
      }
      const page = (JSON.parse(String(init?.body)) as { page: number }).page;
      return {
        ok: true,
        json: async () => page === 1
          ? {
              products: [{
                id: 'entitled', name: 'Entitled result', brand: null, image: null,
                nutritionLocked: false, nutrition: { fat: { value: 2, unit: 'g' } },
              }],
              account: accountState({ nutritionAccess: true, checkoutAvailable: false }),
              hasMore: true,
              nextPage: 2,
            }
          : {
              products: [{
                id: 'revoked', name: 'Revoked result', brand: null, image: null,
                nutritionLocked: false, nutrition: { fat: { value: 9, unit: 'g' } },
              }],
              account: accountState(),
              hasMore: false,
              nextPage: null,
            },
      } as Response;
    }));
    render(<FoodscopeApp />);

    await userEvent.type(screen.getByLabelText('Search products'), 'spread');
    await userEvent.click(screen.getByRole('button', { name: /^Search/ }));
    expect(await screen.findByText('2 g')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Load more' }));

    expect(await screen.findByRole('heading', { name: 'Revoked result' })).toBeInTheDocument();
    expect(screen.queryByText('2 g')).not.toBeInTheDocument();
    expect(screen.getByText('Free plan')).toBeInTheDocument();
    expect(screen.getAllByText('Nutrition is locked')).toHaveLength(2);
  });

  it('invalidates plan state and loaded nutrition for a malformed later-page account', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/user')) {
        return {
          ok: true,
          json: async () => accountState({ nutritionAccess: true, checkoutAvailable: false }),
        } as Response;
      }
      if (url.includes('/api/searches/recent')) {
        return { ok: true, json: async () => ({ searches: [] }) } as Response;
      }
      const page = (JSON.parse(String(init?.body)) as { page: number }).page;
      return {
        ok: true,
        json: async () => page === 1
          ? {
              products: [{
                id: 'entitled', name: 'Entitled result', brand: null, image: null,
                nutritionLocked: false, nutrition: { fat: { value: 2, unit: 'g' } },
              }],
              account: accountState({ nutritionAccess: true, checkoutAvailable: false }),
              hasMore: true,
              nextPage: 2,
            }
          : {
              products: [],
              account: { nutritionAccess: false },
              hasMore: false,
              nextPage: null,
            },
      } as Response;
    }));
    render(<FoodscopeApp />);

    await userEvent.type(screen.getByLabelText('Search products'), 'spread');
    await userEvent.click(screen.getByRole('button', { name: /^Search/ }));
    expect(await screen.findByText('2 g')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Load more' }));

    expect(await screen.findByRole('button', { name: 'Retry plan status' })).toBeInTheDocument();
    expect(screen.queryByText('2 g')).not.toBeInTheDocument();
    expect(screen.getByText('Nutrition is locked')).toBeInTheDocument();
  });

  it('synchronizes account state when a search observes entitlement revocation', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      const body = url.includes('/api/user')
        ? accountState({ nutritionAccess: true, checkoutAvailable: false })
        : url.includes('/api/searches/recent')
          ? { searches: [] }
          : {
              products: [{
                id: 'revoked', name: 'Revoked', brand: null, image: null,
                nutritionLocked: true,
              }],
              account: accountState({ checkoutAvailable: true }),
            };
      return { ok: true, json: async () => body } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<FoodscopeApp />);

    expect(await screen.findByText('Foodscope Plus', { selector: '#plan-title' })).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Search products'), 'spread');
    await userEvent.click(screen.getByRole('button', { name: /^Search/ }));

    expect(await screen.findByText('Nutrition is locked')).toBeInTheDocument();
    expect(screen.getByText('Free plan')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Unlock nutrition' })).toBeInTheDocument();
  });

  it('does not let an older account request overwrite search-time entitlement', async () => {
    let resolveAccount!: (response: Response) => void;
    const pendingAccount = new Promise<Response>((resolve) => { resolveAccount = resolve; });
    let accountSignal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = String(input);
      if (url.includes('/api/user')) {
        accountSignal = init?.signal ?? undefined;
        return pendingAccount;
      }
      if (url.includes('/api/searches/recent')) {
        return { ok: true, json: async () => ({ searches: [] }) } as Response;
      }
      return {
        ok: true,
        json: async () => ({
          products: [{
            id: 'current', name: 'Current', brand: null, image: null,
            nutritionLocked: true,
          }],
          account: accountState(),
        }),
      } as Response;
    }));
    render(<FoodscopeApp />);

    await userEvent.type(screen.getByLabelText('Search products'), 'current');
    await userEvent.click(screen.getByRole('button', { name: /^Search/ }));

    expect(await screen.findByText('Free plan')).toBeInTheDocument();
    expect(accountSignal?.aborted).toBe(true);
    await act(async () => resolveAccount({
      ok: true,
      json: async () => accountState({ nutritionAccess: true, checkoutAvailable: false }),
    } as Response));
    expect(screen.getByText('Free plan')).toBeInTheDocument();
    expect(screen.queryByText('Foodscope Plus', { selector: '#plan-title' })).not.toBeInTheDocument();
  });

  it('rechecks server entitlement after Checkout without trusting the success URL', async () => {
    vi.useFakeTimers();
    window.history.replaceState(null, '', '/?checkout=success');
    markCheckoutInitiated();
    let accountReads = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/api/searches/recent')) {
        return { ok: true, json: async () => ({ searches: [] }) } as Response;
      }
      accountReads += 1;
      return {
        ok: true,
        json: async () => accountState({
          nutritionAccess: accountReads >= 3,
          checkoutAvailable: accountReads < 3,
        }),
      } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<FoodscopeApp />);
    await act(async () => vi.advanceTimersByTimeAsync(3_000));

    expect(screen.getByText('Foodscope Plus', { selector: '#plan-title' })).toBeInTheDocument();
    expect(accountReads).toBe(3);
    expect(window.location.search).toBe('');
  });

  it('does not amplify account reads from an untrusted Checkout success URL', async () => {
    vi.useFakeTimers();
    window.history.replaceState(null, '', '/?checkout=success');
    let accountReads = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes('/api/searches/recent')) {
        return { ok: true, json: async () => ({ searches: [] }) } as Response;
      }
      accountReads += 1;
      return { ok: true, json: async () => accountState() } as Response;
    }));

    render(<FoodscopeApp />);
    await act(async () => vi.advanceTimersByTimeAsync(15_000));

    expect(accountReads).toBe(1);
    expect(window.location.search).toBe('');
  });

  it('preserves the Checkout success marker when polling is interrupted', async () => {
    window.history.replaceState(null, '', '/?checkout=success');
    markCheckoutInitiated();
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes('/api/searches/recent')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ searches: [] }),
        } as Response);
      }
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    }));

    const view = render(<FoodscopeApp />);

    expect(window.location.search).toBe('?checkout=success');
    view.unmount();
    expect(window.location.search).toBe('?checkout=success');
    expect(window.sessionStorage.getItem(checkoutMarkerKey)).not.toBeNull();
  });

  it('does not poll repeatedly when Checkout cannot be configured', async () => {
    vi.useFakeTimers();
    window.history.replaceState(null, '', '/?checkout=success');
    markCheckoutInitiated();
    let accountReads = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes('/api/searches/recent')) {
        return { ok: true, json: async () => ({ searches: [] }) } as Response;
      }
      accountReads += 1;
      return {
        ok: true,
        json: async () => accountState({ billingAvailable: false, checkoutAvailable: false }),
      } as Response;
    }));

    render(<FoodscopeApp />);
    await act(async () => vi.advanceTimersByTimeAsync(15_000));

    expect(screen.getByText('Stripe test Checkout is not configured.')).toBeInTheDocument();
    expect(accountReads).toBe(1);
    expect(window.location.search).toBe('');
  });

  it('does not present an earlier account result after later Checkout polling fails', async () => {
    vi.useFakeTimers();
    window.history.replaceState(null, '', '/?checkout=success');
    markCheckoutInitiated();
    let accountReads = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/api/searches/recent')) {
        return { ok: true, json: async () => ({ searches: [] }) } as Response;
      }
      accountReads += 1;
      if (accountReads === 1) {
        return { ok: true, json: async () => accountState() } as Response;
      }
      throw new Error('database unavailable');
    }));

    render(<FoodscopeApp />);
    await act(async () => vi.advanceTimersByTimeAsync(15_000));

    expect(screen.getByRole('button', { name: 'Retry plan status' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Unlock nutrition' })).not.toBeInTheDocument();
    expect(accountReads).toBe(5);
  });

  it('reports a canceled Checkout once without polling or changing account state', async () => {
    window.history.replaceState(null, '', '/?checkout=cancelled');
    markCheckoutInitiated();
    let accountReads = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/api/searches/recent')) {
        return { ok: true, json: async () => ({ searches: [] }) } as Response;
      }
      accountReads += 1;
      return { ok: true, json: async () => accountState() } as Response;
    }));

    render(<FoodscopeApp />);

    const cancellation = await screen.findByText(
      'Checkout was canceled. Your plan was not changed.',
    );
    expect(cancellation).toHaveAttribute('role', 'status');
    expect(await screen.findByRole('button', { name: 'Unlock nutrition' })).toBeInTheDocument();
    expect(accountReads).toBe(1);
    expect(window.location.search).toBe('');
    expect(window.sessionStorage.getItem(checkoutMarkerKey)).toBeNull();
  });

  it('confirms, schedules, and reverses cancellation through the billing API', async () => {
    let cancellationScheduled = false;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/searches/recent')) {
        return { ok: true, json: async () => ({ searches: [] }) } as Response;
      }
      if (url.includes('/api/billing/subscription-cancellation')) {
        const body = JSON.parse(String(init?.body)) as {
          requestId: string;
          cancelAtPeriodEnd: boolean;
        };
        expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
        cancellationScheduled = body.cancelAtPeriodEnd;
      }
      return {
        ok: true,
        json: async () => accountState({
          nutritionAccess: true,
          checkoutAvailable: false,
          subscriptionManagementAvailable: true,
          cancellationScheduled,
          currentPeriodEnd: '2100-01-01T00:00:00.000Z',
        }),
      } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<FoodscopeApp />);

    const cancelButton = await screen.findByRole('button', { name: 'Cancel subscription' });
    await userEvent.click(cancelButton);
    const dialog = screen.getByRole('alertdialog', { name: 'Cancel Foodscope Plus?' });
    expect(dialog).toHaveTextContent('keep nutrition access through Jan 1, 2100');
    expect(fetchMock.mock.calls.filter(([url]) =>
      String(url).includes('/api/billing/subscription-cancellation'))).toHaveLength(0);

    await userEvent.click(screen.getByRole('button', { name: 'Cancel at period end' }));
    expect(await screen.findByText(/Cancellation scheduled\. Nutrition stays unlocked/))
      .toHaveAttribute('role', 'status');
    expect(screen.getByText('Foodscope Plus', { selector: '#plan-title' })).toBeInTheDocument();
    expect(screen.getByText('Access through Jan 1, 2100 · No further renewal')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Keep subscription' }));
    expect(await screen.findByText(/Cancellation removed\. Your subscription will renew/))
      .toHaveAttribute('role', 'status');
    expect(screen.getByText('Foodscope Plus', { selector: '#plan-title' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel subscription' })).toBeInTheDocument();

    const changes = fetchMock.mock.calls
      .filter(([url]) => String(url).includes('/api/billing/subscription-cancellation'))
      .map(([, init]) => JSON.parse(String(init?.body)).cancelAtPeriodEnd);
    expect(changes).toEqual([true, false]);
  });

  it('does not fake a cancellation state when the billing API cannot confirm it', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/api/searches/recent')) {
        return { ok: true, json: async () => ({ searches: [] }) } as Response;
      }
      if (url.includes('/api/billing/subscription-cancellation')) {
        return { ok: false, status: 502, headers: new Headers() } as Response;
      }
      return {
        ok: true,
        json: async () => accountState({
          nutritionAccess: true,
          checkoutAvailable: false,
          subscriptionManagementAvailable: true,
        }),
      } as Response;
    }));
    render(<FoodscopeApp />);

    await userEvent.click(await screen.findByRole('button', { name: 'Cancel subscription' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel at period end' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'We could not confirm the subscription change',
    );
    expect(screen.getByRole('alertdialog', { name: 'Cancel Foodscope Plus?' }))
      .toBeInTheDocument();
    expect(screen.getByText('Foodscope Plus', { selector: '#plan-title' })).toBeInTheDocument();
    expect(screen.queryByText('Cancellation scheduled')).not.toBeInTheDocument();
  });

  it('does not offer Checkout before authoritative account state loads', async () => {
    let resolveAccount!: (response: Response) => void;
    const account = new Promise<Response>((resolve) => { resolveAccount = resolve; });
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/api/user')) return account;
      return { ok: true, json: async () => ({ searches: [] }) } as Response;
    }));

    render(<FoodscopeApp />);
    expect(screen.getByText('Loading your Foodscope…')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Unlock nutrition' })).not.toBeInTheDocument();

    await act(async () => resolveAccount({
      ok: true,
      json: async () => accountState(),
    } as Response));
    const upgrade = await screen.findByRole('button', { name: 'Unlock nutrition' });
    expect(screen.getByText('Free plan', { selector: '#plan-title' })).toBeInTheDocument();
    expect(upgrade.closest('aside')?.parentElement).toHaveClass('search-workbench');
    expect(document.querySelector('.wordmark-plus-badge')).not.toBeInTheDocument();
  });

  it('announces asynchronous plan-state changes to assistive technology', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const body = String(input).includes('/api/user')
        ? accountState({ nutritionAccess: true, checkoutAvailable: false })
        : { searches: [] };
      return { ok: true, json: async () => body } as Response;
    }));

    render(<FoodscopeApp />);

    const planStatus = await screen.findByText('Foodscope Plus', { selector: '#plan-title' });
    expect(planStatus.closest('aside')?.parentElement).toHaveClass('search-workbench');
    expect(document.querySelector('.wordmark-plus-badge')).toHaveTextContent('PLUS');
  });

  it('offers a retry instead of Checkout when account state cannot be loaded', async () => {
    let accountReads = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/api/searches/recent')) {
        return { ok: true, json: async () => ({ searches: [] }) } as Response;
      }
      accountReads += 1;
      if (accountReads === 1) throw new Error('database unavailable');
      return { ok: true, json: async () => accountState({ nutritionAccess: true, checkoutAvailable: false }) } as Response;
    }));

    render(<FoodscopeApp />);
    const retry = await screen.findByRole('button', { name: 'Retry plan status' });
    expect(screen.queryByRole('button', { name: 'Unlock nutrition' })).not.toBeInTheDocument();

    await userEvent.click(retry);
    expect(await screen.findByText('Foodscope Plus', { selector: '#plan-title' })).toBeInTheDocument();
    expect(accountReads).toBe(2);
  });

  it('does not offer a Checkout action when optional billing is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const body = String(input).includes('/api/user')
        ? accountState({ billingAvailable: false, checkoutAvailable: false })
        : { searches: [] };
      return { ok: true, json: async () => body } as Response;
    }));

    render(<FoodscopeApp />);

    expect(await screen.findByText('Stripe test Checkout is not configured.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Unlock nutrition' })).not.toBeInTheDocument();
  });

  it('does not offer a doomed Checkout action for an unpaid subscription', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const body = String(input).includes('/api/user')
        ? accountState({ checkoutAvailable: false })
        : { searches: [] };
      return { ok: true, json: async () => body } as Response;
    }));

    render(<FoodscopeApp />);

    expect(await screen.findByText('Checkout is unavailable for the current plan status.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Unlock nutrition' })).not.toBeInTheDocument();
  });

  it('fails closed when the account response is incomplete', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const body = String(input).includes('/api/user')
        ? { nutritionAccess: false }
        : { searches: [] };
      return { ok: true, json: async () => body } as Response;
    }));

    render(<FoodscopeApp />);

    expect(await screen.findByRole('button', { name: 'Retry plan status' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Unlock nutrition' })).not.toBeInTheDocument();
    expect(screen.queryByText('Stripe test Checkout is not configured.')).not.toBeInTheDocument();
  });

  it('recovers from an account request that never responds', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes('/api/searches/recent')) {
        return Promise.resolve({ ok: true, json: async () => ({ searches: [] }) } as Response);
      }
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    }));

    render(<FoodscopeApp />);
    await act(async () => vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS.account));

    expect(screen.getByRole('button', { name: 'Retry plan status' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Unlock nutrition' })).not.toBeInTheDocument();
  });

  it('keeps the account deadline active while a response body stalls', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes('/api/searches/recent')) {
        return Promise.resolve({ ok: true, json: async () => ({ searches: [] }) } as Response);
      }
      return Promise.resolve({
        ok: true,
        json: () => new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
        }),
      } as Response);
    }));

    render(<FoodscopeApp />);
    await act(async () => Promise.resolve());
    await act(async () => vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS.account));

    expect(screen.getByRole('button', { name: 'Retry plan status' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Unlock nutrition' })).not.toBeInTheDocument();
  });

  it('recovers from a product search that never responds', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/user')) {
        return Promise.resolve({ ok: true, json: async () => accountState() } as Response);
      }
      if (url.includes('/api/searches/recent')) {
        return Promise.resolve({ ok: true, json: async () => ({ searches: [] }) } as Response);
      }
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    }));
    render(<FoodscopeApp />);
    await act(async () => Promise.resolve());

    fireEvent.change(screen.getByLabelText('Search products'), { target: { value: 'oats' } });
    fireEvent.click(screen.getByRole('button', { name: /^Search/ }));
    await act(async () => vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS.search));

    expect(screen.getByRole('alert')).toHaveTextContent('We could not complete that search');
    expect(screen.queryByText('Searching…')).not.toBeInTheDocument();
  });

  it.each([
    ['37', 37_000],
    ['7200', 3_600_000],
  ])('honors product-search Retry-After %s before re-enabling search actions', async (
    retryAfter,
    backoffMs,
  ) => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/api/user')) {
        return { ok: true, json: async () => accountState() } as Response;
      }
      if (url.includes('/api/searches/recent')) {
        return {
          ok: true,
          json: async () => ({ searches: [{ query: 'milk', locale: 'en' }] }),
        } as Response;
      }
      return {
        ok: false,
        status: 503,
        headers: new Headers({ 'Retry-After': retryAfter }),
      } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<FoodscopeApp />);
    await act(async () => Promise.resolve());

    fireEvent.change(screen.getByLabelText('Search products'), { target: { value: 'oats' } });
    const submit = screen.getByRole('button', { name: /^Search/ });
    fireEvent.click(submit);
    await act(async () => Promise.resolve());

    const expectedDelay = retryAfter === '37' ? 'in 37 seconds' : 'in 60 minutes';
    expect(screen.getByRole('alert')).toHaveTextContent(
      `Search rate limit exceeded. Please try again ${expectedDelay}.`,
    );
    expect(submit).toBeDisabled();
    expect(screen.getByRole('button', { name: /milk EN/ })).toBeDisabled();
    expect(fetchMock.mock.calls.filter(([url]) =>
      String(url).includes('/api/products/search'))).toHaveLength(1);

    await act(async () => vi.advanceTimersByTimeAsync(backoffMs - 1));
    expect(submit).toBeDisabled();
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(submit).toBeEnabled();
    expect(screen.getByRole('button', { name: /milk EN/ })).toBeEnabled();
  });

  it('allows a bounded provider retry to complete before the browser deadline', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/user')) {
        return Promise.resolve({ ok: true, json: async () => accountState() } as Response);
      }
      if (url.includes('/api/searches/recent')) {
        return Promise.resolve({ ok: true, json: async () => ({ searches: [] }) } as Response);
      }
      return new Promise<Response>((resolve, reject) => {
        const completion = window.setTimeout(() => resolve({
          ok: true,
          json: async () => ({ products: [], account: accountState() }),
        } as Response), 23_000);
        init?.signal?.addEventListener('abort', () => {
          window.clearTimeout(completion);
          reject(init.signal?.reason);
        }, { once: true });
      });
    }));
    render(<FoodscopeApp />);
    await act(async () => Promise.resolve());

    fireEvent.change(screen.getByLabelText('Search products'), { target: { value: 'oats' } });
    fireEvent.click(screen.getByRole('button', { name: /^Search/ }));
    await act(async () => vi.advanceTimersByTimeAsync(23_000));

    expect(screen.getByText('No matching products found. Try another term.')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('re-enables Checkout when its request never responds', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/user')) {
        return Promise.resolve({ ok: true, json: async () => accountState() } as Response);
      }
      if (url.includes('/api/searches/recent')) {
        return Promise.resolve({ ok: true, json: async () => ({ searches: [] }) } as Response);
      }
      if (init?.method !== 'POST') {
        return Promise.resolve({ ok: true, json: async () => ({ products: [] }) } as Response);
      }
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    }));
    render(<FoodscopeApp />);
    await act(async () => Promise.resolve());

    fireEvent.click(screen.getByRole('button', { name: 'Unlock nutrition' }));
    await act(async () => vi.advanceTimersByTimeAsync(20_000));

    expect(screen.getByRole('button', { name: 'Opening Checkout…' })).toBeDisabled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    await act(async () => vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS.checkout - 20_000));

    expect(screen.getByRole('button', { name: 'Unlock nutrition' })).toBeEnabled();
    expect(screen.getByRole('alert')).toHaveTextContent('We could not open Checkout');

    fireEvent.change(screen.getByLabelText('Search products'), { target: { value: 'oats' } });
    fireEvent.click(screen.getByRole('button', { name: /^Search/ }));
    await act(async () => Promise.resolve());
    expect(screen.getByRole('alert')).toHaveTextContent('We could not open Checkout');
  });

  it('honors Checkout Retry-After before re-enabling the action', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/api/user')) {
        return { ok: true, json: async () => accountState() } as Response;
      }
      if (url.includes('/api/searches/recent')) {
        return { ok: true, json: async () => ({ searches: [] }) } as Response;
      }
      return {
        ok: false,
        status: 429,
        headers: new Headers({ 'Retry-After': '37' }),
      } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<FoodscopeApp />);
    await act(async () => Promise.resolve());

    const checkout = screen.getByRole('button', { name: 'Unlock nutrition' });
    await act(async () => {
      fireEvent.click(checkout);
      await Promise.resolve();
    });
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Checkout is temporarily paused',
    );
    expect(checkout).toBeDisabled();
    expect(fetchMock.mock.calls.filter(([url]) =>
      String(url).includes('/api/billing/checkout-session'))).toHaveLength(1);

    await act(async () => vi.advanceTimersByTimeAsync(36_999));
    expect(checkout).toBeDisabled();
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(checkout).toBeEnabled();
  });

  it('does not replace an in-flight Checkout request on rapid repeated activation', async () => {
    let checkoutSignal: AbortSignal | undefined;
    const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/user')) {
        return Promise.resolve({ ok: true, json: async () => accountState() } as Response);
      }
      if (url.includes('/api/searches/recent')) {
        return Promise.resolve({ ok: true, json: async () => ({ searches: [] }) } as Response);
      }
      checkoutSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<FoodscopeApp />);

    const checkout = await screen.findByRole('button', { name: 'Unlock nutrition' });
    await act(async () => {
      fireEvent.click(checkout);
      fireEvent.click(checkout);
    });

    const calls = fetchMock.mock.calls.filter(
      ([url]) => String(url).includes('/api/billing/checkout-session'),
    );
    expect(calls).toHaveLength(1);
    expect(checkoutSignal?.aborted).toBe(false);
  });

  it('cancels a pending Checkout request when the view unmounts', async () => {
    let checkoutSignal: AbortSignal | null | undefined;
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/user')) {
        return Promise.resolve({ ok: true, json: async () => accountState() } as Response);
      }
      if (url.includes('/api/searches/recent')) {
        return Promise.resolve({ ok: true, json: async () => ({ searches: [] }) } as Response);
      }
      checkoutSignal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    }));
    const view = render(<FoodscopeApp />);
    await screen.findByText('Free plan');

    await userEvent.click(screen.getByRole('button', { name: 'Unlock nutrition' }));
    expect(checkoutSignal?.aborted).toBe(false);

    view.unmount();
    expect(checkoutSignal?.aborted).toBe(true);
  });

  it('records a tab-local marker before following a valid Checkout response', async () => {
    const navigationError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      const body = url.includes('/api/user')
        ? accountState()
        : url.includes('/api/searches/recent')
          ? { searches: [] }
          : { url: 'https://checkout.stripe.test/session' };
      return { ok: true, json: async () => body } as Response;
    }));
    try {
      render(<FoodscopeApp />);
      await userEvent.click(await screen.findByRole('button', { name: 'Unlock nutrition' }));

      expect(Number(window.sessionStorage.getItem(checkoutMarkerKey))).toBeGreaterThan(0);
    } finally {
      navigationError.mockRestore();
    }
  });

  it.each([
    {},
    { url: null },
    { url: 'javascript:alert(1)' },
    { url: 'https://user:password@checkout.stripe.test/session' },
  ])('reports malformed successful Checkout response %# instead of redirecting', async (checkoutResponse) => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      const body = url.includes('/api/user')
        ? accountState()
        : url.includes('/api/searches/recent')
          ? { searches: [] }
          : checkoutResponse;
      return { ok: true, json: async () => body } as Response;
    }));
    render(<FoodscopeApp />);

    await userEvent.click(await screen.findByRole('button', { name: 'Unlock nutrition' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('We could not open Checkout');
    expect(screen.getByRole('button', { name: 'Unlock nutrition' })).toBeEnabled();
  });

  it('refreshes authoritative account state when Checkout detects concurrent activation', async () => {
    let accountReads = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/user')) {
        accountReads += 1;
        return {
          ok: true,
          json: async () => accountState({
            nutritionAccess: accountReads > 1,
            checkoutAvailable: accountReads === 1,
          }),
        } as Response;
      }
      if (url.includes('/api/searches/recent')) {
        return { ok: true, json: async () => ({ searches: [] }) } as Response;
      }
      expect(init?.method).toBe('POST');
      return { ok: false, status: 409 } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<FoodscopeApp />);

    await userEvent.click(await screen.findByRole('button', { name: 'Unlock nutrition' }));

    expect(await screen.findByText('Foodscope Plus', { selector: '#plan-title' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(accountReads).toBe(2);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/billing/checkout-session')))
      .toHaveLength(1);
  });

  it('suppresses repeated Checkout calls when Stripe reports a state conflict', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/api/user')) {
        return { ok: true, json: async () => accountState() } as Response;
      }
      if (url.includes('/api/searches/recent')) {
        return { ok: true, json: async () => ({ searches: [] }) } as Response;
      }
      return { ok: false, status: 409 } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<FoodscopeApp />);

    await userEvent.click(await screen.findByRole('button', { name: 'Unlock nutrition' }));

    expect(await screen.findByText('Checkout is unavailable for the current plan status.'))
      .toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Unlock nutrition' })).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/billing/checkout-session')))
      .toHaveLength(1);

    await userEvent.click(screen.getByRole('button', { name: 'Retry plan status' }));

    expect(await screen.findByRole('button', { name: 'Unlock nutrition' })).toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/billing/checkout-session')))
      .toHaveLength(1);
  });

  it('replaces a failed product image with the unavailable fallback', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      const body = url.includes('/api/user')
        ? accountState()
        : url.includes('/api/searches/recent')
          ? { searches: [] }
          : { products: [{
              id: 'image', name: 'Oats', brand: null,
              image: 'https://images.openfoodfacts.org/oats.jpg', nutritionLocked: true,
            }], account: accountState() };
      return { ok: true, json: async () => body } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<FoodscopeApp />);

    await userEvent.type(screen.getByLabelText('Search products'), 'oats');
    await userEvent.click(screen.getByRole('button', { name: /^Search/ }));
    const image = await screen.findByRole('button', { name: 'Oats' });
    expect(image).toHaveAttribute(
      'data-sizes',
      '(max-width: 680px) 100vw, (max-width: 1080px) 36vw, 250px',
    );
    expect(image).toHaveAttribute('data-loading', 'lazy');
    expect(image).toHaveAttribute('data-decoding', 'async');
    expect(document.querySelector('.product-image-skeleton')).toBeInTheDocument();
    fireEvent.doubleClick(image);
    expect(document.querySelector('.product-image-skeleton')).not.toBeInTheDocument();
    await userEvent.click(image);

    expect(screen.queryByRole('button', { name: 'Oats' })).not.toBeInTheDocument();
  });

  it('shows unavailable rather than an upgrade promise when nutrition is missing', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      const body = url.includes('/api/user')
        ? accountState()
        : url.includes('/api/searches/recent')
          ? { searches: [] }
          : { products: [{
              id: 'missing', name: 'Missing nutrition', brand: null, image: null,
              nutritionLocked: false,
            }], account: accountState() };
      return { ok: true, json: async () => body } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<FoodscopeApp />);

    await userEvent.type(screen.getByLabelText('Search products'), 'missing');
    await userEvent.click(screen.getByRole('button', { name: /^Search/ }));

    expect(await screen.findByText('Unavailable')).toBeInTheDocument();
    expect(screen.queryByText('Nutrition details are locked')).not.toBeInTheDocument();
  });
});
