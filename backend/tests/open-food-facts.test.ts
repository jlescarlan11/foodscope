import { describe, expect, it, vi } from 'vitest';
import {
  canonicalProductSearchKey,
  normalizeProduct,
  OpenFoodFactsProvider,
} from '../src/open-food-facts.js';

describe('Open Food Facts normalization', () => {
  it('prefers the selected localized name and maps available nutrition', () => {
    expect(normalizeProduct({
      code: '123', lang: 'de', product_name: 'Generic', product_name_de: 'Haferdrink', brands: 'Good Foods',
      product_quantity_unit: 'g',
      nutrition_data_per: '100g',
      nutriments: { 'energy-kcal_100g': 44, 'fat_100g': 1.5, ignored: 99 },
    }, 'de')).toEqual({
      id: '123', name: 'Haferdrink', brand: 'Good Foods', image: null,
      nutrition: { energyKcal: { value: 44, unit: 'kcal' }, fat: { value: 1.5, unit: 'g' } },
    });
  });

  it('rejects negative or physically impossible nutrition and untrusted images as unavailable', () => {
    expect(normalizeProduct({
      code: 'safe',
      lang: 'en',
      image_front_url: 'javascript:alert(1)',
      image_url: 'https://tracker.example/product.jpg',
      product_quantity_unit: 'g',
      nutrition_data_per: '100g',
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

  it.each([
    'https://user:secret@images.openfoodfacts.org/product.jpg',
    'https://tracker.example/product.jpg',
    'https://world.openfoodfacts.org/cgi/search.pl',
    'https://unexpected.openfoodfacts.org/product.jpg',
    'https://images.openfoodfacts.org/cgi/search.pl',
    'https://images.openfoodfacts.org/images/products/123/front.jpg?variant=untrusted',
    'https://images.openfoodfacts.org/images/products/123/front.jpg#variant',
  ])('rejects credentialed or untrusted image URL %s', (image) => {
    expect(normalizeProduct({ code: 'safe-image', lang: 'en', image_front_url: image }, 'en')?.image)
      .toBeNull();
  });

  it.each(['ml', undefined])(
    'uses explicit _100g nutrition independently of the %s package quantity unit',
    (productQuantityUnit) => {
      expect(normalizeProduct({
        code: 'packaging-unit-is-unrelated',
        lang: 'en',
        product_quantity_unit: productQuantityUnit,
        nutrition_data_per: '100g',
        nutriments: { 'energy-kcal_100g': 44, 'fat_100g': 1.5 },
      }, 'en')).toEqual({
        id: 'packaging-unit-is-unrelated', name: null, brand: null, image: null,
        nutrition: {
          energyKcal: { value: 44, unit: 'kcal' },
          fat: { value: 1.5, unit: 'g' },
        },
      });
    },
  );

  it('never substitutes serving, prepared-product, or per-100-ml nutrition', () => {
    expect(normalizeProduct({
      code: 'wrong-nutrition-bases',
      lang: 'en',
      nutriments: {
        'fat_serving': 1,
        'fat_prepared_100g': 2,
        'fat_100ml': 3,
      },
    }, 'en')).toEqual({
      id: 'wrong-nutrition-bases', name: null, brand: null, image: null,
    });
  });

  it.each(['100ml', 'serving', undefined, null])(
    'withholds _100g fields when the declared nutrition basis is %s',
    (nutritionDataPer) => {
      expect(normalizeProduct({
        code: 'ambiguous-nutrition-basis',
        lang: 'en',
        nutrition_data_per: nutritionDataPer,
        nutriments: { 'energy-kcal_100g': 44, 'fat_100g': 1.5 },
      }, 'en')).toEqual({
        id: 'ambiguous-nutrition-basis', name: null, brand: null, image: null,
      });
    },
  );

  it('falls back to the generic name and tolerates missing fields', () => {
    expect(normalizeProduct({ code: '456', lang: 'fr', product_name: 'Generic only' }, 'fr')).toEqual({
      id: '456', name: 'Generic only', brand: null, image: null,
    });
    expect(normalizeProduct({ code: '789', lang: 'nl' }, 'nl')?.name).toBeNull();
    expect(normalizeProduct({
      code: 'emoji-name', lang: 'en', product_name: 'Family 👨‍👩‍👧‍👦 pack',
    }, 'en')?.name).toBe('Family 👨‍👩‍👧‍👦 pack');
    expect(normalizeProduct('malformed', 'en')).toBeNull();
  });

  it('treats invisible and control-character product text as unavailable', () => {
    expect(normalizeProduct({
      code: '\u0000',
      lang: 'en',
      _id: 'fallback-id',
      product_name_en: '\u200b',
      product_name: 'Generic name',
      brands: 'Trusted\u2066Spoof',
    }, 'en')).toEqual({
      id: 'fallback-id', name: 'Generic name', brand: null, image: null,
    });

    expect(normalizeProduct({
      code: 'barcode\u202e.txt',
      lang: 'en',
      product_name: 'Unidentified product',
    }, 'en')).toBeNull();
  });

  it('does not reflect oversized upstream text fields into the product response', () => {
    const oversized = 'x'.repeat(10_000);

    expect(normalizeProduct({
      code: 'bounded-product',
      lang: 'en',
      product_name_en: oversized,
      product_name: 'Usable fallback',
      brands: oversized,
      image_front_url: `https://images.openfoodfacts.org/${oversized}.jpg`,
    }, 'en')).toEqual({
      id: 'bounded-product',
      name: 'Usable fallback',
      brand: null,
      image: null,
    });

    expect(normalizeProduct({ code: oversized, lang: 'en' }, 'en')).toBeNull();
  });

  it('rejects products without selected-locale main-language evidence', () => {
    expect(normalizeProduct({
      code: 'other-language',
      lang: 'de',
      product_name_fr: 'Nom français disponible',
      product_name: 'Deutscher Indexname',
    }, 'fr')).toBeNull();
    expect(normalizeProduct({
      code: 'unknown-language',
      product_name_fr: 'Nom français disponible',
    }, 'fr')).toBeNull();
  });

  it('canonicalizes compatible Unicode, boundaries, whitespace, case, and locale into one key', () => {
    expect(canonicalProductSearchKey('  ＰＯＲＫ\t  belly  ', 'en'))
      .toBe(canonicalProductSearchKey('pork belly', 'en'));
    expect(canonicalProductSearchKey('PORK BELLY', 'fr'))
      .not.toBe(canonicalProductSearchKey('pork belly', 'en'));
    expect(canonicalProductSearchKey('pork belly', 'en', 1, 4))
      .not.toBe(canonicalProductSearchKey('pork belly', 'en', 2, 4));
    expect(canonicalProductSearchKey('pork belly', 'en', 1, 4))
      .not.toBe(canonicalProductSearchKey('pork belly', 'en', 1, 8));
  });

  it('caches normalized results for equivalent queries without spending request budget again', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ hits: [{
      code: 'cached', lang: 'en', product_name_en: 'Pork', brands: 'Foods',
    }] }), { status: 200 }));
    const provider = new OpenFoodFactsProvider('FoodscopeTest/1.0', fetcher);

    const first = await provider.search('Pork', 'en');
    first.products[0]!.name = 'mutated by caller';
    const second = await provider.search('  ＰＯＲＫ\t ', 'en');

    expect(second).toEqual({
      products: [{ id: 'cached', name: 'Pork', brand: 'Foods', image: null }],
      hasMore: false,
    });
    expect(fetcher).toHaveBeenCalledOnce();

    for (let index = 0; index < 9; index += 1) {
      await provider.search(`distinct-${index}`, 'en');
    }
    await expect(provider.search('eleventh-upstream-key', 'en')).rejects.toMatchObject({
      retryAfterSeconds: 60,
    });
  });

  it('isolates cached and in-flight results by page and page size', async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { page: number; page_size: number };
      return new Response(JSON.stringify({
        page: body.page,
        page_count: 3,
        hits: [{
          code: `${body.page}-${body.page_size}`,
          lang: 'en',
          product_name: 'Paged product',
        }],
      }), { status: 200 });
    });
    const provider = new OpenFoodFactsProvider('FoodscopeTest/1.0', fetcher);

    await provider.search('milk', 'en', undefined, 1, 4);
    await provider.search('MILK', 'en', undefined, 2, 4);
    await provider.search(' milk ', 'en', undefined, 1, 4);
    await provider.search('milk', 'en', undefined, 1, 8);

    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('isolates cache entries by locale', async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const locale = new Headers(init?.headers).get('Accept-Language');
      return new Response(JSON.stringify({ hits: [{
        code: locale, lang: locale, product_name: `Product ${locale}`,
      }] }), { status: 200 });
    });
    const provider = new OpenFoodFactsProvider('FoodscopeTest/1.0', fetcher);

    await expect(provider.search('Pork', 'en')).resolves.toMatchObject({ products: [{ id: 'en' }] });
    await expect(provider.search(' pork ', 'fr')).resolves.toMatchObject({ products: [{ id: 'fr' }] });
    await expect(provider.search('PORK', 'en')).resolves.toMatchObject({ products: [{ id: 'en' }] });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('expires entries at the configured TTL and replaces them only after a fresh success', async () => {
    let now = 1_000_000;
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ hits: [{
        code: 'first', lang: 'en', product_name: 'First',
      }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response('failure', { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ hits: [{
        code: 'replacement', lang: 'en', product_name: 'Replacement',
      }] }), { status: 200 }));
    const provider = new OpenFoodFactsProvider(
      'FoodscopeTest/1.0', fetcher, () => now, { clock: () => now, ttlMs: 100 },
    );

    await expect(provider.search('milk', 'en')).resolves.toMatchObject({ products: [{ id: 'first' }] });
    now += 99;
    await expect(provider.search('milk', 'en')).resolves.toMatchObject({ products: [{ id: 'first' }] });
    now += 1;
    await expect(provider.search('milk', 'en')).rejects.toThrow('Open Food Facts returned 500');
    await expect(provider.search('milk', 'en')).resolves.toMatchObject({ products: [{ id: 'replacement' }] });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('keeps the default cache within 500 entries and evicts the least recently used key', async () => {
    let now = 1_000_000;
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      hits: [{ code: String(fetcher.mock.calls.length), lang: 'en' }],
    }), { status: 200 }));
    const provider = new OpenFoodFactsProvider(
      'FoodscopeTest/1.0', fetcher, () => now, {
        clock: () => now,
        ttlMs: 100_000_000,
      },
    );

    for (let index = 0; index < 500; index += 1) {
      await provider.search(`product-${index}`, 'en');
      now += 60_001;
    }
    await provider.search('product-0', 'en');
    await provider.search('product-500', 'en');
    await provider.search('product-0', 'en');
    await provider.search('product-1', 'en');

    expect(fetcher).toHaveBeenCalledTimes(502);
  });

  it('caches successful empty results', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ hits: [] }), { status: 200 }));
    const provider = new OpenFoodFactsProvider('FoodscopeTest/1.0', fetcher);

    await expect(provider.search('missing', 'en')).resolves.toEqual({ products: [], hasMore: false });
    await expect(provider.search(' MISSING ', 'en')).resolves.toEqual({ products: [], hasMore: false });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('keeps cached results local to one provider process instance', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ hits: [] }), { status: 200 }));
    const firstProcess = new OpenFoodFactsProvider('FoodscopeTest/1.0', fetcher);
    const restartedProcess = new OpenFoodFactsProvider('FoodscopeTest/1.0', fetcher);

    await firstProcess.search('milk', 'en');
    await firstProcess.search('milk', 'en');
    await restartedProcess.search('milk', 'en');

    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['provider error', () => new Response('', { status: 500 })],
    ['rate limit', () => new Response('', { status: 429 })],
    ['malformed response', () => new Response('{', { status: 200 })],
    ['oversized response', () => new Response('', {
      status: 200, headers: { 'content-length': '1000001' },
    })],
  ])('does not cache a %s', async (_label, failingResponse) => {
    const fetcher = vi.fn()
      .mockImplementationOnce(async () => failingResponse())
      .mockResolvedValueOnce(new Response(JSON.stringify({ hits: [] }), { status: 200 }));
    const provider = new OpenFoodFactsProvider('FoodscopeTest/1.0', fetcher);

    await expect(provider.search('retryable', 'en')).rejects.toBeDefined();
    await expect(provider.search('retryable', 'en')).resolves.toEqual({ products: [], hasMore: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('coalesces identical misses while keeping different keys independent', async () => {
    const releases = new Map<string, (response: Response) => void>();
    const fetcher = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      const query = (JSON.parse(String(init?.body)) as { q: string }).q;
      return new Promise<Response>((resolve) => releases.set(query, resolve));
    });
    const provider = new OpenFoodFactsProvider('FoodscopeTest/1.0', fetcher);

    const first = provider.search('Milk', 'en');
    const joined = provider.search(' milk ', 'en');
    const independent = provider.search('bread', 'en');
    expect(fetcher).toHaveBeenCalledTimes(2);

    releases.get('"bread"')!(new Response(JSON.stringify({ hits: [] }), { status: 200 }));
    await expect(independent).resolves.toEqual({ products: [], hasMore: false });
    releases.get('"Milk"')!(new Response(JSON.stringify({ hits: [{
      code: 'shared', lang: 'en', product_name: 'Shared',
    }] }), { status: 200 }));
    await expect(Promise.all([first, joined])).resolves.toEqual([
      { products: [{ id: 'shared', name: 'Shared', brand: null, image: null }], hasMore: false },
      { products: [{ id: 'shared', name: 'Shared', brand: null, image: null }], hasMore: false },
    ]);
  });

  it('lets one joined caller abort without cancelling the shared upstream operation', async () => {
    let release: ((response: Response) => void) | undefined;
    let upstreamSignal: AbortSignal | undefined;
    const fetcher = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      upstreamSignal = init?.signal ?? undefined;
      return new Promise<Response>((resolve) => { release = resolve; });
    });
    const provider = new OpenFoodFactsProvider('FoodscopeTest/1.0', fetcher);
    const controller = new AbortController();

    const aborted = provider.search('milk', 'en', controller.signal);
    const survivor = provider.search('MILK', 'en');
    controller.abort();

    await expect(aborted).rejects.toBeDefined();
    expect(upstreamSignal?.aborted).toBe(false);
    release!(new Response(JSON.stringify({ hits: [] }), { status: 200 }));
    await expect(survivor).resolves.toEqual({ products: [], hasMore: false });
    await expect(provider.search('milk', 'en')).resolves.toEqual({ products: [], hasMore: false });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('clears timed-out in-flight work so a later caller can retry', async () => {
    const fetcher = vi.fn()
      .mockRejectedValueOnce(new DOMException('timed out', 'TimeoutError'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ hits: [] }), { status: 200 }));
    const provider = new OpenFoodFactsProvider('FoodscopeTest/1.0', fetcher);

    await expect(Promise.all([
      provider.search('milk', 'en'),
      provider.search('MILK', 'en'),
    ])).rejects.toThrow('timed out');
    await expect(provider.search('milk', 'en')).resolves.toEqual({ products: [], hasMore: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('does not cache a late success after the sole caller abandons it', async () => {
    const releases: Array<(response: Response) => void> = [];
    const fetcher = vi.fn(() => new Promise<Response>((resolve) => releases.push(resolve)));
    const provider = new OpenFoodFactsProvider('FoodscopeTest/1.0', fetcher);
    const controller = new AbortController();

    const abandoned = provider.search('milk', 'en', controller.signal);
    controller.abort();
    await expect(abandoned).rejects.toBeDefined();

    const retry = provider.search('milk', 'en');
    expect(fetcher).toHaveBeenCalledTimes(2);
    releases[0]!(new Response(JSON.stringify({ hits: [{
      code: 'abandoned', lang: 'en', product_name: 'Abandoned',
    }] }), { status: 200 }));
    releases[1]!(new Response(JSON.stringify({ hits: [{
      code: 'fresh', lang: 'en', product_name: 'Fresh',
    }] }), { status: 200 }));

    await expect(retry).resolves.toMatchObject({ products: [{ id: 'fresh' }] });
    await expect(provider.search('milk', 'en')).resolves.toMatchObject({ products: [{ id: 'fresh' }] });
    expect(fetcher).toHaveBeenCalledTimes(2);
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
      .mockResolvedValueOnce(new Response(JSON.stringify({ hits: [{ code: '123', lang: 'fr', product_name_fr: 'Avoine' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    const provider = new OpenFoodFactsProvider('FoodscopeTest/1.0', fetcher);

    await expect(provider.search('avoine', 'fr')).resolves.toMatchObject({
      products: [{ id: '123', name: 'Avoine' }],
      hasMore: false,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]?.[0]).toBe('https://search.openfoodfacts.org/search');
    const requestBody = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(requestBody).toMatchObject({ q: '"avoine"', page: 1, page_size: 4, langs: ['fr'] });
    expect(requestBody.fields).toEqual([
      'code',
      'lang',
      'product_name',
      'product_name_fr',
      'brands',
      'image_front_url',
      'image_url',
      'nutrition_data_per',
      'nutriments',
    ]);
    expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({ 'Accept-Language': 'fr' });
  });

  it('quotes accepted product text before sending it to the provider query parser', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      void input;
      void init;
      return new Response(JSON.stringify({ hits: [] }), { status: 200 });
    });
    const provider = new OpenFoodFactsProvider('FoodscopeTest/1.0', fetcher);

    await provider.search('Coca-Cola: (Zero) AND "light" milk* C++', 'en');

    const requestBody = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)) as { q: string };
    expect(requestBody.q).toBe(
      '"Coca-Cola:" "(Zero)" "AND" "\\"light\\"" "milk*" "C++"',
    );
  });

  it('preserves the declared nutrition basis through the full provider path', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      hits: [
        { code: 'mass', lang: 'en', nutrition_data_per: '100g', nutriments: { 'fat_100g': 2 } },
        { code: 'volume', lang: 'en', nutrition_data_per: '100ml', nutriments: { 'fat_100g': 3 } },
        { code: 'serving', lang: 'en', nutrition_data_per: 'serving', nutriments: { 'fat_100g': 4 } },
        { code: 'missing', lang: 'en', nutriments: { 'fat_100g': 5 } },
      ],
    }), { status: 200 }));
    const provider = new OpenFoodFactsProvider('FoodscopeTest/1.0', fetcher);

    const result = await provider.search('nutrition', 'en');

    expect(result.products.find((product) => product.id === 'mass')).toHaveProperty(
      'nutrition.fat',
      { value: 2, unit: 'g' },
    );
    for (const id of ['volume', 'serving', 'missing']) {
      expect(result.products.find((product) => product.id === id)).not.toHaveProperty('nutrition');
    }
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

  it('caps a long upstream Retry-After value to a bounded client backoff', async () => {
    const fetcher = vi.fn(async () => new Response('', {
      status: 429,
      headers: { 'retry-after': '7200' },
    }));
    const provider = new OpenFoodFactsProvider('FoodscopeTest/1.0', fetcher);

    await expect(provider.search('milk', 'en')).rejects.toMatchObject({
      retryAfterSeconds: 3_600,
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('removes duplicate product IDs from malformed upstream results', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ hits: [
      { code: 'duplicate', lang: 'en', product_name: 'First' },
      { code: 'duplicate', lang: 'en', product_name: 'Second' },
    ] }), { status: 200 }));
    const provider = new OpenFoodFactsProvider('FoodscopeTest/1.0', fetcher);

    await expect(provider.search('milk', 'en')).resolves.toEqual({
      products: [{ id: 'duplicate', name: 'First', brand: null, image: null }],
      hasMore: false,
    });
  });

  it('keeps pagination open when only part of an upstream page survives normalization', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      page: 1,
      page_count: 3,
      hits: [
        { code: 'en-1', lang: 'en', product_name: 'English one' },
        { code: 'fr-1', lang: 'fr', product_name: 'French one' },
        { code: 'en-2', lang: 'en', product_name: 'English two' },
        { code: 'fr-2', lang: 'fr', product_name: 'French two' },
      ],
    }), { status: 200 }));
    const provider = new OpenFoodFactsProvider('FoodscopeTest/1.0', fetcher);

    await expect(provider.search('mixed', 'en')).resolves.toMatchObject({
      products: [{ id: 'en-1' }, { id: 'en-2' }],
      hasMore: true,
    });
  });

  it('requests and returns one four-product page at a time', async () => {
    const upstreamProducts = Array.from({ length: 25 }, (_value, index) => ({
      code: `product-${index + 1}`,
      lang: 'en',
      product_name: `Product ${index + 1}`,
    }));
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      void input;
      void init;
      return new Response(JSON.stringify({ hits: upstreamProducts }), { status: 200 });
    });
    const provider = new OpenFoodFactsProvider('FoodscopeTest/1.0', fetcher);

    const result = await provider.search('many', 'en', undefined, 3, 4);

    expect(result.products).toHaveLength(4);
    expect(result.products.at(-1)?.id).toBe('product-4');
    expect(result.hasMore).toBe(true);
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({
      page: 3,
      page_size: 4,
    });
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

  it('rejects invalid UTF-8 instead of exposing replacement characters', async () => {
    const prefix = Buffer.from('{"hits":[{"code":"1","product_name":"');
    const suffix = Buffer.from('"}]}');
    const malformed = new Uint8Array(prefix.length + 2 + suffix.length);
    malformed.set(prefix);
    malformed.set([0xc3, 0x28], prefix.length);
    malformed.set(suffix, prefix.length + 2);
    const fetcher = vi.fn(async () => new Response(malformed, { status: 200 }));
    const provider = new OpenFoodFactsProvider('FoodscopeTest/1.0', fetcher);

    await expect(provider.search('milk', 'en')).rejects.toThrow(
      'Open Food Facts returned malformed data',
    );
  });

  it('does not hold the request open for a long gateway Retry-After', async () => {
    const fetcher = vi.fn(async () => new Response('', { status: 502, headers: { 'retry-after': '120' } }));
    const provider = new OpenFoodFactsProvider('FoodscopeTest/1.0', fetcher);

    await expect(provider.search('milk', 'en')).rejects.toThrow('Open Food Facts returned 502');
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('cancels the upstream request when the caller aborts', async () => {
    const fetcher = vi.fn()
      .mockImplementationOnce((_url: string | URL | Request, init?: RequestInit) => {
        void _url;
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
        });
      })
      .mockResolvedValueOnce(new Response(JSON.stringify({ hits: [] }), { status: 200 }));
    const provider = new OpenFoodFactsProvider('FoodscopeTest/1.0', fetcher);
    const controller = new AbortController();

    const pending = provider.search('milk', 'en', controller.signal);
    controller.abort();

    await expect(pending).rejects.toBeDefined();
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    await expect(provider.search('milk', 'en')).resolves.toEqual({ products: [], hasMore: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('does not spend the upstream request budget when the caller already aborted', async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      init?.signal?.throwIfAborted();
      return new Response(JSON.stringify({ hits: [] }), { status: 200 });
    });
    const provider = new OpenFoodFactsProvider('FoodscopeTest/1.0', fetcher);

    for (let requestNumber = 0; requestNumber < 10; requestNumber += 1) {
      const controller = new AbortController();
      controller.abort();
      await expect(provider.search('abandoned', 'en', controller.signal)).rejects.toBeDefined();
    }

    await expect(provider.search('valid', 'en')).resolves.toEqual({ products: [], hasMore: false });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('blocks an eleventh upstream search request within one minute', async () => {
    let now = 1_000_000;
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ hits: [] }), { status: 200 }));
    const provider = new OpenFoodFactsProvider('FoodscopeTest/1.0', fetcher, () => now);

    for (let requestNumber = 0; requestNumber < 10; requestNumber += 1) {
      await provider.search(`milk-${requestNumber}`, 'en');
    }
    await expect(provider.search('blocked', 'en')).rejects.toMatchObject({ retryAfterSeconds: 60 });
    expect(fetcher).toHaveBeenCalledTimes(10);

    now += 60_000;
    await expect(provider.search('available', 'en')).resolves.toEqual({ products: [], hasMore: false });
    expect(fetcher).toHaveBeenCalledTimes(11);
  });
});
