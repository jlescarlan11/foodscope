import { describe, expect, it, vi } from 'vitest';
import { normalizeProduct, OpenFoodFactsProvider } from '../src/open-food-facts.js';

describe('Open Food Facts normalization', () => {
  it('prefers the selected localized name and maps available nutrition', () => {
    expect(normalizeProduct({
      code: '123', product_name: 'Generic', product_name_de: 'Haferdrink', brands: 'Good Foods',
      product_quantity_unit: 'g',
      nutriments: { 'energy-kcal_100g': 44, 'fat_100g': 1.5, ignored: 99 },
    }, 'de')).toEqual({
      id: '123', name: 'Haferdrink', brand: 'Good Foods', image: null,
      nutrition: { energyKcal: { value: 44, unit: 'kcal' }, fat: { value: 1.5, unit: 'g' } },
    });
  });

  it('rejects negative or physically impossible nutrition and untrusted images as unavailable', () => {
    expect(normalizeProduct({
      code: 'safe',
      image_front_url: 'javascript:alert(1)',
      image_url: 'https://tracker.example/product.jpg',
      product_quantity_unit: 'g',
      nutriments: {
        'energy-kcal_100g': 1_001,
        'fat_100g': -1,
        'proteins_100g': 100.1,
        'sugars_100g': 0,
      },
    }, 'en')).toEqual({
      id: 'safe', name: null, brand: null, image: null,
      nutrition: { sugars: { value: 0, unit: 'g' } },
    });
  });

  it.each(['ml', undefined])(
    'treats %s product-basis nutrition as unavailable instead of per 100 g',
    (productQuantityUnit) => {
      expect(normalizeProduct({
        code: 'liquid-or-unknown',
        product_quantity_unit: productQuantityUnit,
        nutriments: { 'energy-kcal_100g': 44, 'fat_100g': 1.5 },
      }, 'en')).toEqual({
        id: 'liquid-or-unknown', name: null, brand: null, image: null,
      });
    },
  );

  it('falls back to the generic name and tolerates missing fields', () => {
    expect(normalizeProduct({ code: '456', product_name: 'Generic only' }, 'fr')).toEqual({
      id: '456', name: 'Generic only', brand: null, image: null,
    });
    expect(normalizeProduct({ code: '789' }, 'nl')?.name).toBeNull();
    expect(normalizeProduct('malformed', 'en')).toBeNull();
  });

  it('sends locale-aware headers and retries one gateway failure', async () => {
    const cancel = vi.fn(async () => undefined);
    const fetcher = vi.fn()
      .mockResolvedValueOnce({
        status: 502,
        ok: false,
        headers: new Headers(),
        body: { cancel },
      } as unknown as Response)
      .mockResolvedValueOnce(new Response(JSON.stringify({ products: [{ code: '123', product_name_fr: 'Avoine' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    const provider = new OpenFoodFactsProvider('FoodscopeTest/1.0', fetcher);

    await expect(provider.search('avoine', 'fr')).resolves.toMatchObject([{ id: '123', name: 'Avoine' }]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(cancel).toHaveBeenCalledOnce();
    const requestUrl = new URL(String(fetcher.mock.calls[0]?.[0]));
    expect(requestUrl.toString()).toContain('/cgi/search.pl?search_terms=avoine&search_simple=1');
    expect(requestUrl.searchParams.get('fields')?.split(',')).toEqual([
      'code',
      'product_name',
      'product_name_fr',
      'brands',
      'image_front_url',
      'image_url',
      'product_quantity_unit',
      'nutriments',
    ]);
    expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({ 'Accept-Language': 'fr' });
  });

  it('does not amplify rate limits and exposes Retry-After', async () => {
    const cancel = vi.fn(async () => undefined);
    const fetcher = vi.fn(async () => ({
      status: 429,
      ok: false,
      headers: new Headers({ 'retry-after': '17' }),
      body: { cancel },
    } as unknown as Response));
    const provider = new OpenFoodFactsProvider('FoodscopeTest/1.0', fetcher);

    await expect(provider.search('milk', 'en')).rejects.toMatchObject({ retryAfterSeconds: 17 });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('does not expose an overflowing upstream Retry-After value', async () => {
    const fetcher = vi.fn(async () => new Response('', {
      status: 429,
      headers: { 'retry-after': '9'.repeat(400) },
    }));
    const provider = new OpenFoodFactsProvider('FoodscopeTest/1.0', fetcher);

    await expect(provider.search('milk', 'en')).rejects.toMatchObject({
      retryAfterSeconds: undefined,
    });
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

  it('never returns more products than the requested page size', async () => {
    const upstreamProducts = Array.from({ length: 25 }, (_value, index) => ({
      code: `product-${index + 1}`,
      product_name: `Product ${index + 1}`,
    }));
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      void input;
      return new Response(JSON.stringify({ products: upstreamProducts }), { status: 200 });
    });
    const provider = new OpenFoodFactsProvider('FoodscopeTest/1.0', fetcher);

    const products = await provider.search('many', 'en');

    expect(products).toHaveLength(20);
    expect(products.at(-1)?.id).toBe('product-20');
    expect(new URL(String(fetcher.mock.calls[0]?.[0])).searchParams.get('page_size')).toBe('20');
  });

  it('cancels an oversized upstream response instead of buffering it without a limit', async () => {
    const cancel = vi.fn(async () => undefined);
    const reader = {
      read: vi.fn(async () => ({ done: false, value: new Uint8Array(1_000_001) })),
      cancel,
    };
    const fetcher = vi.fn(async () => ({
      status: 200,
      ok: true,
      headers: new Headers(),
      body: { getReader: () => reader },
    } as unknown as Response));
    const provider = new OpenFoodFactsProvider('FoodscopeTest/1.0', fetcher);

    await expect(provider.search('milk', 'en')).rejects.toThrow('response exceeded the size limit');
    expect(reader.read).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('rejects a declared oversized response before reading its body', async () => {
    const getReader = vi.fn();
    const cancel = vi.fn(async () => undefined);
    const fetcher = vi.fn(async () => ({
      status: 200,
      ok: true,
      headers: new Headers({ 'content-length': '1000001' }),
      body: { getReader, cancel },
    } as unknown as Response));
    const provider = new OpenFoodFactsProvider('FoodscopeTest/1.0', fetcher);

    await expect(provider.search('milk', 'en')).rejects.toThrow('response exceeded the size limit');
    expect(getReader).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
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
