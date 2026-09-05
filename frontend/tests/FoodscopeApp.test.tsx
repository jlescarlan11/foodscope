import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FoodscopeApp } from '@/components/FoodscopeApp';

vi.mock('next/image', () => ({
  default: ({ src, alt, onError }: { src: string; alt: string; onError?: () => void }) => (
    <button type="button" aria-label={alt} data-image-src={src} onClick={onError} />
  ),
}));

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
        ? { email: 'demo@foodscope.local', subscriptionStatus: 'inactive', subscriptionCurrentPeriodEnd: null, nutritionAccess: false }
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
    await userEvent.type(screen.getByLabelText('Produkte suchen'), 'Hafermilch');
    await userEvent.click(screen.getByRole('button', { name: /Suchen/ }));
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('q=Hafermilch&lang=de'))).toBe(true);
    expect(fetchMock.mock.calls.find(([url]) => String(url).includes('/api/products/search'))?.[1])
      .toMatchObject({ cache: 'no-store' });
  });

  it('aborts an older search and ignores its stale response', async () => {
    let resolveFirst!: (response: Response) => void;
    let resolveSecond!: (response: Response) => void;
    const first = new Promise<Response>((resolve) => { resolveFirst = resolve; });
    const second = new Promise<Response>((resolve) => { resolveSecond = resolve; });
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/user')) return { ok: true, json: async () => ({ nutritionAccess: false }) } as Response;
      if (url.includes('/api/searches/recent')) {
        return { ok: true, json: async () => ({ searches: [
          { id: 1, query: 'first', locale: 'en', createdAt: '' },
          { id: 2, query: 'second', locale: 'de', createdAt: '' },
        ] }) } as Response;
      }
      if (url.includes('q=first')) return first;
      if (url.includes('q=second')) return second;
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

  it('renders the explicit normalized nutrition value and unit', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      const body = url.includes('/api/user')
        ? { nutritionAccess: true }
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
        json: async () => ({ nutritionAccess: accountReads >= 3 }),
      } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<FoodscopeApp />);
    await act(async () => vi.advanceTimersByTimeAsync(3_000));

    expect(screen.getByText('Nutrition unlocked')).toBeInTheDocument();
    expect(accountReads).toBe(3);
    expect(window.location.search).toBe('');
  });

  it('replaces a failed product image with the unavailable fallback', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      const body = url.includes('/api/user')
        ? { nutritionAccess: false }
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
        ? { nutritionAccess: false }
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
