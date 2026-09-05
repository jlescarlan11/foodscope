import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FoodscopeApp, REQUEST_TIMEOUT_MS } from '@/components/FoodscopeApp';

vi.mock('next/image', () => ({
  default: ({ src, alt, onError }: { src: string; alt: string; onError?: () => void }) => (
    <button type="button" aria-label={alt} data-image-src={src} onClick={onError} />
  ),
}));

const accountState = (overrides: Partial<{
  email: string;
  subscriptionStatus: string;
  subscriptionCurrentPeriodEnd: string | null;
  nutritionAccess: boolean;
  billingAvailable: boolean;
  checkoutAvailable: boolean;
}> = {}) => ({
  email: 'demo@foodscope.local',
  subscriptionStatus: 'inactive',
  subscriptionCurrentPeriodEnd: null,
  nutritionAccess: false,
  billingAvailable: true,
  checkoutAvailable: true,
  ...overrides,
});

describe('Foodscope locale switching', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    window.history.replaceState(null, '', '/');
  });

  it('updates application-controlled text and uses the chosen locale for search', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      void init;
      const url = String(input);
      const body = url.includes('/api/user')
        ? accountState()
        : url.includes('/api/searches/recent') ? { searches: [] } : { products: [] };
      return { ok: true, json: async () => body } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<FoodscopeApp />);

    await screen.findByText('Free plan');
    expect(fetchMock.mock.calls.find(([url]) => String(url).includes('/api/user'))?.[1])
      .toMatchObject({ cache: 'no-store' });

    await userEvent.selectOptions(screen.getByLabelText('Language'), 'de');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Wissen, wasdrin ist.');
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
  });

  it.each([
    {},
    { searches: 'not-an-array' },
    { searches: [{ id: 1, query: null, locale: 'en', createdAt: '' }] },
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
          { id: 1, query: 'first', locale: 'en', createdAt: '' },
          { id: 2, query: 'second', locale: 'de', createdAt: '' },
        ] }) } as Response;
      }
      const searchBody = init?.body ? JSON.parse(String(init.body)) as { q?: string } : {};
      if (searchBody.q === 'first') return first;
      if (searchBody.q === 'second') return second;
      throw new Error(`Unexpected request: ${url} ${String(init)}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<FoodscopeApp />);

    await userEvent.click(await screen.findByRole('button', { name: 'first' }));
    await userEvent.click(screen.getByRole('button', { name: 'second' }));

    const searchCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/products/search'));
    expect(searchCalls[0]?.[1]?.signal?.aborted).toBe(true);
    await act(async () => resolveSecond({
      ok: true,
      json: async () => ({ products: [{ id: '2', name: 'Neu', brand: null, image: null, nutritionLocked: true }] }),
    } as Response));
    expect(await screen.findByRole('heading', { name: 'Neu' })).toBeInTheDocument();

    await act(async () => resolveFirst({
      ok: true,
      json: async () => ({ products: [{ id: '1', name: 'Old', brand: null, image: null, nutritionLocked: true }] }),
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
    render(<FoodscopeApp />);

    const recentSearch = await screen.findByRole('button', { name: 'oats' });
    await userEvent.dblClick(recentSearch);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/products/search')))
      .toHaveLength(1);

    await act(async () => resolveSearch({
      ok: true,
      json: async () => ({ products: [] }),
    } as Response));
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
        : { ok: true, json: async () => ({ products: [] }) } as Response;
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
      return Promise.resolve({ ok: true, json: async () => ({ products: [] }) } as Response);
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
    { products: 'not-an-array' },
    { products: [{ id: 'unsafe', name: 'Unsafe', brand: null, image: null, nutritionLocked: true,
      nutrition: { fat: { value: 1, unit: 'g' } } }] },
    { products: [{ id: 'invalid-unit', name: 'Invalid', brand: null, image: null,
      nutritionLocked: false, nutrition: { fat: { value: 1, unit: 'kcal' } } }] },
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

  it('renders the explicit normalized nutrition value and unit', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      const body = url.includes('/api/user')
        ? accountState({ nutritionAccess: true, subscriptionStatus: 'active', checkoutAvailable: false })
        : url.includes('/api/searches/recent')
          ? { searches: [] }
          : { products: [{
              id: 'nutrition', name: 'Oats', brand: null, image: null, nutritionLocked: false,
              nutrition: { energyKcal: { value: 44, unit: 'kcal' }, fat: { value: 1.5, unit: 'g' } },
            }] };
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

  it('rechecks server entitlement after Checkout without trusting the success URL', async () => {
    vi.useFakeTimers();
    window.history.replaceState(null, '', '/?checkout=success');
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
          subscriptionStatus: accountReads >= 3 ? 'active' : 'inactive',
          checkoutAvailable: accountReads < 3,
        }),
      } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<FoodscopeApp />);
    await act(async () => vi.advanceTimersByTimeAsync(3_000));

    expect(screen.getByText('Nutrition unlocked')).toBeInTheDocument();
    expect(accountReads).toBe(3);
    expect(window.location.search).toBe('');
  });

  it('does not present an earlier account result after later Checkout polling fails', async () => {
    vi.useFakeTimers();
    window.history.replaceState(null, '', '/?checkout=success');
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

    expect(await screen.findByRole('status')).toHaveTextContent(
      'Checkout was canceled. Your plan was not changed.',
    );
    expect(await screen.findByRole('button', { name: 'Unlock nutrition' })).toBeInTheDocument();
    expect(accountReads).toBe(1);
    expect(window.location.search).toBe('');
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
    expect(await screen.findByRole('button', { name: 'Unlock nutrition' })).toBeInTheDocument();
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
      return { ok: true, json: async () => accountState({ nutritionAccess: true, subscriptionStatus: 'active', checkoutAvailable: false }) } as Response;
    }));

    render(<FoodscopeApp />);
    const retry = await screen.findByRole('button', { name: 'Retry plan status' });
    expect(screen.queryByRole('button', { name: 'Unlock nutrition' })).not.toBeInTheDocument();

    await userEvent.click(retry);
    expect(await screen.findByText('Nutrition unlocked')).toBeInTheDocument();
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
        ? accountState({ subscriptionStatus: 'unpaid', checkoutAvailable: false })
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
    await act(async () => vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS.checkout));

    expect(screen.getByRole('button', { name: 'Unlock nutrition' })).toBeEnabled();
    expect(screen.getByRole('alert')).toHaveTextContent('We could not open Checkout');

    fireEvent.change(screen.getByLabelText('Search products'), { target: { value: 'oats' } });
    fireEvent.click(screen.getByRole('button', { name: /^Search/ }));
    await act(async () => Promise.resolve());
    expect(screen.getByRole('alert')).toHaveTextContent('We could not open Checkout');
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
            subscriptionStatus: accountReads > 1 ? 'active' : 'inactive',
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

    expect(await screen.findByText('Nutrition unlocked')).toBeInTheDocument();
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
            }] };
      return { ok: true, json: async () => body } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<FoodscopeApp />);

    await userEvent.type(screen.getByLabelText('Search products'), 'oats');
    await userEvent.click(screen.getByRole('button', { name: /^Search/ }));
    await userEvent.click(await screen.findByRole('button', { name: 'Oats' }));

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
            }] };
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
