import React from 'react';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FoodscopeApp } from '@/components/FoodscopeApp';

vi.mock('next/image', () => ({ default: ({ src }: { src: string }) => <span data-image-src={src} /> }));

describe('Foodscope locale switching', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('updates application-controlled text and uses the chosen locale for search', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      const body = url.includes('/api/user')
        ? { email: 'demo@foodscope.local', subscriptionStatus: 'inactive', subscriptionCurrentPeriodEnd: null, nutritionAccess: false }
        : url.includes('/api/searches/recent') ? { searches: [] } : { products: [] };
      return { ok: true, json: async () => body } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<FoodscopeApp />);

    await userEvent.selectOptions(screen.getByLabelText('Language'), 'de');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Wissen, wasdrin ist.');
    await userEvent.type(screen.getByLabelText('Produkte suchen'), 'Hafermilch');
    await userEvent.click(screen.getByRole('button', { name: /Suchen/ }));
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('q=Hafermilch&lang=de'))).toBe(true);
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
});
