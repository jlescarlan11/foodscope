import React from 'react';
import { render, screen } from '@testing-library/react';
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
});
