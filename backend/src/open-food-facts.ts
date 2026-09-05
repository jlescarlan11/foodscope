import type { Locale } from './constants.js';
import type { Nutrition, Product, ProductProvider } from './types.js';
import { setTimeout as delay } from 'node:timers/promises';

type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const textValue = (value: unknown) =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

const numberValue = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

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
    if (url.hostname !== 'images.openfoodfacts.org' && !url.hostname.endsWith('.openfoodfacts.org')) {
      return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

export class ProductProviderRateLimitError extends Error {
  constructor(readonly retryAfterSeconds?: number) {
    super('Open Food Facts rate limit reached');
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

export function normalizeProduct(raw: unknown, locale: Locale): Omit<Product, 'nutritionLocked'> | null {
  if (!isRecord(raw)) return null;
  const id = textValue(raw.code) ?? textValue(raw._id);
  if (!id) return null;

  const localizedName = textValue(raw[`product_name_${locale}`]);
  const genericName = textValue(raw.product_name);
  const brands = textValue(raw.brands);
  const image = imageValue(raw.image_front_url) ?? imageValue(raw.image_url);
  const nutriments = isRecord(raw.nutriments) ? raw.nutriments : {};
  const nutrition: Nutrition = {};

  for (const [localKey, upstreamKey, unit] of nutritionFields) {
    const value = numberValue(nutriments[upstreamKey]);
    if (value !== undefined) nutrition[localKey] = { value, unit };
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
  constructor(private readonly userAgent: string, private readonly fetcher: typeof fetch = fetch) {}

  async search(query: string, locale: Locale, signal?: AbortSignal) {
    const params = new URLSearchParams({
      search_terms: query,
      search_simple: '1',
      action: 'process',
      json: '1',
      lc: locale,
      page_size: '20',
      fields:
        'code,product_name,product_name_en,product_name_nl,product_name_de,product_name_fr,brands,image_front_url,image_url,nutriments',
    });
    // Open Food Facts v2 only supports structured filters; plain-text search remains on this legacy endpoint.
    const request = () => this.fetcher(`https://world.openfoodfacts.org/cgi/search.pl?${params}`, {
      headers: {
        'User-Agent': this.userAgent,
        Accept: 'application/json',
        'Accept-Language': locale,
      },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
    });
    let response = await request();
    if (response.status === 429 || response.status === 503) {
      throw new ProductProviderRateLimitError(retryAfterSeconds(response));
    }
    if (response.status === 502 || response.status === 504) {
      const retryAfter = retryAfterSeconds(response);
      if (retryAfter !== undefined && retryAfter > 2) {
        throw new Error(`Open Food Facts returned ${response.status}`);
      }
      await delay(retryAfter === undefined ? 250 : retryAfter * 1000, undefined, signal ? { signal } : undefined);
      response = await request();
    }
    if (response.status === 429 || response.status === 503) {
      throw new ProductProviderRateLimitError(retryAfterSeconds(response));
    }
    if (!response.ok) throw new Error(`Open Food Facts returned ${response.status}`);
    const payload: unknown = await response.json();
    if (!isRecord(payload) || !Array.isArray(payload.products)) {
      throw new Error('Open Food Facts returned malformed data');
    }
    const products: Array<Omit<Product, 'nutritionLocked'>> = [];
    const seenIds = new Set<string>();
    for (const rawProduct of payload.products) {
      const product = normalizeProduct(rawProduct, locale);
      if (!product || seenIds.has(product.id)) continue;
      seenIds.add(product.id);
      products.push(product);
    }
    return products;
  }
}
