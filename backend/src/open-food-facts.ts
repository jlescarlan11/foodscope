import type { Locale } from './constants.js';
import type { Nutrition, Product, ProductProvider } from './types.js';

type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const textValue = (value: unknown) =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

const numberValue = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const nutritionFields: Array<[keyof Nutrition, string]> = [
  ['energyKcal', 'energy-kcal_100g'],
  ['fat', 'fat_100g'],
  ['saturatedFat', 'saturated-fat_100g'],
  ['carbohydrates', 'carbohydrates_100g'],
  ['sugars', 'sugars_100g'],
  ['protein', 'proteins_100g'],
  ['salt', 'salt_100g'],
  ['sodium', 'sodium_100g'],
];

export function normalizeProduct(raw: unknown, locale: Locale): Omit<Product, 'nutritionLocked'> | null {
  if (!isRecord(raw)) return null;
  const id = textValue(raw.code) ?? textValue(raw._id);
  if (!id) return null;

  const localizedName = textValue(raw[`product_name_${locale}`]);
  const genericName = textValue(raw.product_name);
  const brands = textValue(raw.brands);
  const image = textValue(raw.image_front_url) ?? textValue(raw.image_url);
  const nutriments = isRecord(raw.nutriments) ? raw.nutriments : {};
  const nutrition: Nutrition = {};

  for (const [localKey, upstreamKey] of nutritionFields) {
    const value = numberValue(nutriments[upstreamKey]);
    if (value !== undefined) nutrition[localKey] = value;
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

  async search(query: string, locale: Locale) {
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
      signal: AbortSignal.timeout(10_000),
    });
    let response = await request();
    for (let attempt = 0; attempt < 2 && [429, 502, 503, 504].includes(response.status); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
      response = await request();
    }
    if (!response.ok) throw new Error(`Open Food Facts returned ${response.status}`);
    const payload: unknown = await response.json();
    if (!isRecord(payload) || !Array.isArray(payload.products)) {
      throw new Error('Open Food Facts returned malformed data');
    }
    return payload.products
      .map((product) => normalizeProduct(product, locale))
      .filter((product): product is Omit<Product, 'nutritionLocked'> => product !== null);
  }
}
