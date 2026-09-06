import { isUsableText, NUTRITION_RULES, type Locale } from './constants.js';
import type { Nutrition, Product, ProductProvider } from './types.js';
import { setTimeout as delay } from 'node:timers/promises';

type UnknownRecord = Record<string, unknown>;
const MAX_RESPONSE_BYTES = 1_000_000;
const DEFAULT_PAGE_SIZE = 4;
const MAX_PAGE_SIZE = 20;
const MAX_PRODUCT_TEXT_CHARACTERS = 500;
const MAX_RETRY_AFTER_SECONDS = 3_600;

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const textValue = (value: unknown) => {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!text || !isUsableText(text)) return undefined;
  let characters = 0;
  const iterator = text[Symbol.iterator]();
  while (!iterator.next().done) {
    characters += 1;
    if (characters > MAX_PRODUCT_TEXT_CHARACTERS) return undefined;
  }
  return text;
};

const numberValue = (value: unknown, maximum: number) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= maximum
    ? value
    : undefined;

const nutritionFields: Array<[keyof Nutrition, string, 'g' | 'kcal']> = [
  ['energyKcal', 'energy-kcal_100g', 'kcal'],
  ['fat', 'fat_100g', 'g'],
  ['saturatedFat', 'saturated-fat_100g', 'g'],
  ['carbohydrates', 'carbohydrates_100g', 'g'],
  ['sugars', 'sugars_100g', 'g'],
  ['protein', 'proteins_100g', 'g'],
  ['salt', 'salt_100g', 'g'],
  ['sodium', 'sodium_100g', 'g'],
];

function imageValue(value: unknown) {
  const text = textValue(value);
  if (!text) return undefined;
  try {
    const url = new URL(text);
    if (url.protocol !== 'https:') return undefined;
    if (url.username || url.password) return undefined;
    if (url.hostname !== 'images.openfoodfacts.org') return undefined;
    if (!url.pathname.startsWith('/images/products/') || url.search || url.hash) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

export class ProductProviderRateLimitError extends Error {
  readonly retryAfterSeconds?: number;

  constructor(retryAfterSeconds?: number) {
    super('Open Food Facts rate limit reached');
    if (
      Number.isSafeInteger(retryAfterSeconds) &&
      retryAfterSeconds !== undefined &&
      retryAfterSeconds >= 0
    ) {
      this.retryAfterSeconds = Math.min(retryAfterSeconds, MAX_RETRY_AFTER_SECONDS);
    }
  }
}

function retryAfterSeconds(response: Response) {
  const value = response.headers.get('retry-after');
  if (!value) return undefined;
  if (/^\d+$/.test(value)) return Number(value);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return undefined;
  return Math.max(0, Math.ceil((timestamp - Date.now()) / 1000));
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const contentLength = response.headers.get('content-length');
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error('Open Food Facts response exceeded the size limit');
  }
  if (!response.body) throw new Error('Open Food Facts returned an empty response');

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error('Open Food Facts response exceeded the size limit');
    }
    chunks.push(value);
  }

  try {
    const text = new TextDecoder('utf-8', { fatal: true })
      .decode(Buffer.concat(chunks, totalBytes));
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error('Open Food Facts returned malformed data');
  }
}

async function discardResponse(response: Response) {
  await response.body?.cancel().catch(() => undefined);
}

export function normalizeProduct(raw: unknown, locale: Locale): Omit<Product, 'nutritionLocked'> | null {
  if (!isRecord(raw) || raw.lang !== locale) return null;
  const id = textValue(raw.code) ?? textValue(raw._id);
  if (!id) return null;

  const localizedName = textValue(raw[`product_name_${locale}`]);
  const genericName = textValue(raw.product_name);
  const brands = textValue(raw.brands);
  const image = imageValue(raw.image_front_url) ?? imageValue(raw.image_url);
  const nutriments = isRecord(raw.nutriments) ? raw.nutriments : {};
  const nutrition: Nutrition = {};

  if (raw.nutrition_data_per === '100g') {
    for (const [localKey, upstreamKey, unit] of nutritionFields) {
      const value = numberValue(nutriments[upstreamKey], NUTRITION_RULES[localKey].maximum);
      if (value !== undefined) nutrition[localKey] = { value, unit };
    }
  }

  return {
    id,
    name: localizedName ?? genericName ?? null,
    brand: brands ?? null,
    image: image ?? null,
    ...(Object.keys(nutrition).length ? { nutrition } : {}),
  };
}

export class OpenFoodFactsProvider implements ProductProvider {
  private readonly requestTimestamps: number[] = [];

  constructor(
    private readonly userAgent: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly clock: () => number = Date.now,
  ) {}

  private reserveRequest() {
    const now = this.clock();
    while (this.requestTimestamps[0] !== undefined && this.requestTimestamps[0] <= now - 60_000) {
      this.requestTimestamps.shift();
    }
    if (this.requestTimestamps.length >= 10) {
      throw new ProductProviderRateLimitError(
        Math.max(1, Math.ceil((this.requestTimestamps[0]! + 60_000 - now) / 1000)),
      );
    }
    this.requestTimestamps.push(now);
  }

  async search(
    query: string,
    locale: Locale,
    signal?: AbortSignal,
    page = 1,
    pageSize = DEFAULT_PAGE_SIZE,
  ) {
    const safePage = Number.isSafeInteger(page) && page >= 1 ? page : 1;
    const safePageSize = Number.isSafeInteger(pageSize) && pageSize >= 1
      ? Math.min(pageSize, MAX_PAGE_SIZE)
      : DEFAULT_PAGE_SIZE;
    const fields = [
        'code',
        'lang',
        'product_name',
        `product_name_${locale}`,
        'brands',
        'image_front_url',
        'image_url',
        'nutrition_data_per',
        'nutriments',
      ];
    const requestBody = JSON.stringify({
      q: query,
      page: safePage,
      page_size: safePageSize,
      langs: [locale],
      fields,
    });
    const request = () => {
      signal?.throwIfAborted();
      this.reserveRequest();
      return this.fetcher('https://search.openfoodfacts.org/search', {
        method: 'POST',
        headers: {
          'User-Agent': this.userAgent,
          Accept: 'application/json',
          'Accept-Language': locale,
          'Content-Type': 'application/json',
        },
        body: requestBody,
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
      });
    };
    let response = await request();
    if (response.status === 429 || response.status === 503) {
      await discardResponse(response);
      throw new ProductProviderRateLimitError(retryAfterSeconds(response));
    }
    if (response.status === 502 || response.status === 504) {
      const retryAfter = retryAfterSeconds(response);
      await discardResponse(response);
      if (retryAfter !== undefined && retryAfter > 2) {
        throw new Error(`Open Food Facts returned ${response.status}`);
      }
      await delay(retryAfter === undefined ? 250 : retryAfter * 1000, undefined, signal ? { signal } : undefined);
      response = await request();
    }
    if (response.status === 429 || response.status === 503) {
      await discardResponse(response);
      throw new ProductProviderRateLimitError(retryAfterSeconds(response));
    }
    if (!response.ok) {
      await discardResponse(response);
      throw new Error(`Open Food Facts returned ${response.status}`);
    }
    const payload = await readBoundedJson(response);
    if (!isRecord(payload) || !Array.isArray(payload.hits)) {
      throw new Error('Open Food Facts returned malformed data');
    }
    const products: Array<Omit<Product, 'nutritionLocked'>> = [];
    const seenIds = new Set<string>();
    for (const rawProduct of payload.hits) {
      if (!isRecord(rawProduct)) continue;
      const brands = Array.isArray(rawProduct.brands)
        ? rawProduct.brands.filter((brand): brand is string => typeof brand === 'string').join(', ')
        : rawProduct.brands;
      const product = normalizeProduct({
        ...rawProduct,
        brands,
        // Search-a-licious nutriment keys explicitly carry their `_100g` basis.
        nutrition_data_per: '100g',
      }, locale);
      if (!product || seenIds.has(product.id)) continue;
      seenIds.add(product.id);
      products.push(product);
      if (products.length === safePageSize) break;
    }
    const upstreamPage = Number.isSafeInteger(payload.page) ? payload.page as number : safePage;
    const upstreamPageCount = Number.isSafeInteger(payload.page_count)
      ? payload.page_count as number
      : null;
    return {
      products,
      hasMore: upstreamPageCount !== null
        ? upstreamPage < upstreamPageCount
        : payload.hits.length >= safePageSize,
    };
  }
}
