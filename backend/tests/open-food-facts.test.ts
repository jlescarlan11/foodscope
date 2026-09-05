import { describe, expect, it, vi } from 'vitest';
import { normalizeProduct, OpenFoodFactsProvider } from '../src/open-food-facts.js';

describe('Open Food Facts normalization', () => {
  it('prefers the selected localized name and maps available nutrition', () => {
    expect(normalizeProduct({
      code: '123', product_name: 'Generic', product_name_de: 'Haferdrink', brands: 'Good Foods',
      nutriments: { 'energy-kcal_100g': 44, 'fat_100g': 1.5, ignored: 99 },
    }, 'de')).toEqual({
      id: '123', name: 'Haferdrink', brand: 'Good Foods', image: null,
      nutrition: { energyKcal: { value: 44, unit: 'kcal' }, fat: { value: 1.5, unit: 'g' } },
    });
  });

  it('rejects negative nutrition and untrusted image URLs as unavailable', () => {
    expect(normalizeProduct({
      code: 'safe',
      image_front_url: 'javascript:alert(1)',
      image_url: 'https://tracker.example/product.jpg',
      nutriments: { 'fat_100g': -1, 'sugars_100g': 0 },
    }, 'en')).toEqual({
      id: 'safe', name: null, brand: null, image: null,
      nutrition: { sugars: { value: 0, unit: 'g' } },
    });
  });

  it('falls back to the generic name and tolerates missing fields', () => {
    expect(normalizeProduct({ code: '456', product_name: 'Generic only' }, 'fr')).toEqual({
      id: '456', name: 'Generic only', brand: null, image: null,
    });
    expect(normalizeProduct({ code: '789' }, 'nl')?.name).toBeNull();
    expect(normalizeProduct('malformed', 'en')).toBeNull();
  });

  it('sends locale-aware headers and retries one gateway failure', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 502 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ products: [{ code: '123', product_name_fr: 'Avoine' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    const provider = new OpenFoodFactsProvider('FoodscopeTest/1.0', fetcher);

    await expect(provider.search('avoine', 'fr')).resolves.toMatchObject([{ id: '123', name: 'Avoine' }]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(String(fetcher.mock.calls[0]?.[0])).toContain('/cgi/search.pl?search_terms=avoine&search_simple=1');
    expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({ 'Accept-Language': 'fr' });
  });

  it('does not amplify rate limits and exposes Retry-After', async () => {
    const fetcher = vi.fn(async () => new Response('', { status: 429, headers: { 'retry-after': '17' } }));
    const provider = new OpenFoodFactsProvider('FoodscopeTest/1.0', fetcher);

    await expect(provider.search('milk', 'en')).rejects.toMatchObject({ retryAfterSeconds: 17 });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('removes duplicate product IDs from malformed upstream results', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ products: [
      { code: 'duplicate', product_name: 'First' },
      { code: 'duplicate', product_name: 'Second' },
    ] }), { status: 200 }));
    const provider = new OpenFoodFactsProvider('FoodscopeTest/1.0', fetcher);

    await expect(provider.search('milk', 'en')).resolves.toEqual([{
      id: 'duplicate', name: 'First', brand: null, image: null,
    }]);
  });

  it('does not hold the request open for a long gateway Retry-After', async () => {
    const fetcher = vi.fn(async () => new Response('', { status: 502, headers: { 'retry-after': '120' } }));
    const provider = new OpenFoodFactsProvider('FoodscopeTest/1.0', fetcher);

    await expect(provider.search('milk', 'en')).rejects.toThrow('Open Food Facts returned 502');
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('cancels the upstream request when the caller aborts', async () => {
    const fetcher = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    }));
    const provider = new OpenFoodFactsProvider('FoodscopeTest/1.0', fetcher);
    const controller = new AbortController();

    const pending = provider.search('milk', 'en', controller.signal);
    controller.abort();

    await expect(pending).rejects.toBeDefined();
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it('blocks an eleventh upstream search request within one minute', async () => {
    let now = 1_000_000;
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ products: [] }), { status: 200 }));
    const provider = new OpenFoodFactsProvider('FoodscopeTest/1.0', fetcher, () => now);

    for (let requestNumber = 0; requestNumber < 10; requestNumber += 1) {
      await provider.search('milk', 'en');
    }
    await expect(provider.search('blocked', 'en')).rejects.toMatchObject({ retryAfterSeconds: 60 });
    expect(fetcher).toHaveBeenCalledTimes(10);

    now += 60_000;
    await expect(provider.search('available', 'en')).resolves.toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(11);
  });
});
