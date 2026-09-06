'use client';

import Image from 'next/image';
import React, { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { resolveApiUrl } from '@/config';
import { dictionaries, locales, type Locale, type Messages } from '@/i18n';
import type { Nutrition, Product, RecentSearch, UserState } from '@/types';

const API_URL = resolveApiUrl(process.env.NEXT_PUBLIC_API_URL, process.env.NODE_ENV);
const localeNames: Record<Locale, string> = { en: 'EN', nl: 'NL', de: 'DE', fr: 'FR' };
const nutritionFormatters = Object.fromEntries(locales.map((locale) => [
  locale,
  new Intl.NumberFormat(locale, { maximumFractionDigits: 4 }),
])) as Record<Locale, Intl.NumberFormat>;
const subscriptionDateFormatters = Object.fromEntries(locales.map((locale) => [
  locale,
  new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }),
])) as Record<Locale, Intl.DateTimeFormat>;
const nutritionKeys: Array<keyof Nutrition> = ['energyKcal', 'fat', 'saturatedFat', 'carbohydrates', 'sugars', 'protein', 'salt', 'sodium'];
const nutritionUnits: Record<keyof Nutrition, 'g' | 'kcal'> = {
  energyKcal: 'kcal',
  fat: 'g',
  saturatedFat: 'g',
  carbohydrates: 'g',
  sugars: 'g',
  protein: 'g',
  salt: 'g',
  sodium: 'g',
};
export const REQUEST_TIMEOUT_MS = {
  account: 8_000,
  search: 28_000,
  checkout: 28_000,
  subscription: 15_000,
} as const;

const visibleSearchCharacter = /[\p{L}\p{N}\p{P}\p{S}]/u;
const unsafeSearchCharacter = /[\p{Cc}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const MAX_SEARCH_QUERY_CHARACTERS = 120;
const PRODUCT_BATCH_SIZE = 4;
const CHECKOUT_POLL_MARKER_KEY = 'foodscope.checkout-initiated-at';
const CHECKOUT_POLL_MARKER_MAX_AGE_MS = 2 * 60 * 60 * 1000;

function isUsableSearchQuery(value: string) {
  return Array.from(value).length <= MAX_SEARCH_QUERY_CHARACTERS &&
    visibleSearchCharacter.test(value) && !unsafeSearchCharacter.test(value);
}

function markCheckoutInitiated() {
  try {
    window.sessionStorage.setItem(CHECKOUT_POLL_MARKER_KEY, String(Date.now()));
  } catch {
    // Storage can be unavailable; one authoritative return read remains safe.
  }
}

function clearCheckoutMarker() {
  try {
    window.sessionStorage.removeItem(CHECKOUT_POLL_MARKER_KEY);
  } catch {
    // Storage can be unavailable.
  }
}

function hasRecentCheckoutMarker() {
  try {
    const initiatedAt = Number(window.sessionStorage.getItem(CHECKOUT_POLL_MARKER_KEY));
    const age = Date.now() - initiatedAt;
    return Number.isFinite(initiatedAt) && initiatedAt > 0 && age >= 0 &&
      age <= CHECKOUT_POLL_MARKER_MAX_AGE_MS;
  } catch {
    return false;
  }
}

class ApiResponseError extends Error {
  constructor(readonly status: number, readonly retryAfterSeconds?: number) {
    super('Request failed');
  }
}

function responseRetryAfterSeconds(response: Response) {
  const value = response.headers?.get?.('retry-after');
  if (!value || !/^\d+$/.test(value)) return undefined;
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) && seconds >= 1
    ? Math.min(seconds, 3_600)
    : undefined;
}

function formatRetryDelay(seconds: number, locale: Locale) {
  const [value, unit] = seconds >= 60
    ? [Math.ceil(seconds / 60), 'minute'] as const
    : [seconds, 'second'] as const;
  return new Intl.RelativeTimeFormat(locale, { numeric: 'always' }).format(value, unit);
}

function formatNutritionValue(value: number, locale: Locale) {
  return nutritionFormatters[locale].format(value);
}

function formatSubscriptionDate(value: string, locale: Locale) {
  return subscriptionDateFormatters[locale].format(new Date(value));
}

async function api<T>(
  path: string,
  init?: RequestInit,
  timeoutMs: number = REQUEST_TIMEOUT_MS.account,
): Promise<T> {
  const controller = new AbortController();
  const callerSignal = init?.signal;
  const abortFromCaller = () => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) abortFromCaller();
  else callerSignal?.addEventListener('abort', abortFromCaller, { once: true });
  const timeout = window.setTimeout(
    () => controller.abort(new DOMException('Request timed out', 'TimeoutError')),
    timeoutMs,
  );
  try {
    const response = await fetch(`${API_URL}${path}`, {
      ...init,
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new ApiResponseError(response.status, responseRetryAfterSeconds(response));
    }
    return await response.json() as T;
  } finally {
    window.clearTimeout(timeout);
    callerSignal?.removeEventListener('abort', abortFromCaller);
  }
}

function wait(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      window.clearTimeout(timeout);
      reject(signal.reason);
    };
    const timeout = window.setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function isUserState(value: unknown): value is UserState {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  const validPeriodEnd = candidate.currentPeriodEnd === null || (
    typeof candidate.currentPeriodEnd === 'string' &&
    Number.isFinite(new Date(candidate.currentPeriodEnd).getTime())
  );
  return typeof candidate.nutritionAccess === 'boolean'
    && typeof candidate.billingAvailable === 'boolean'
    && typeof candidate.checkoutAvailable === 'boolean'
    && typeof candidate.subscriptionManagementAvailable === 'boolean'
    && typeof candidate.cancellationScheduled === 'boolean'
    && validPeriodEnd
    && (!candidate.nutritionAccess || candidate.currentPeriodEnd !== null)
    && (!candidate.cancellationScheduled || candidate.subscriptionManagementAvailable);
}

function searchResponseAccount(value: unknown):
  | { valid: true; account: UserState | null }
  | { valid: false } {
  if (!value || typeof value !== 'object' || !('account' in value)) return { valid: false };
  const account = (value as Record<string, unknown>).account;
  return account === null || isUserState(account)
    ? { valid: true, account }
    : { valid: false };
}

function isProductSearchResponse(
  value: unknown,
): value is {
  products: Product[];
  account: UserState | null;
  hasMore?: boolean;
  nextPage?: number | null;
} {
  if (!value || typeof value !== 'object') return false;
  const response = value as Record<string, unknown>;
  if (!searchResponseAccount(response).valid) return false;
  const products = response.products;
  if (!Array.isArray(products)) return false;
  if (response.hasMore !== undefined && typeof response.hasMore !== 'boolean') return false;
  if (
    response.nextPage !== undefined && response.nextPage !== null &&
    (!Number.isSafeInteger(response.nextPage) || (response.nextPage as number) < 2)
  ) return false;
  if (response.hasMore === true && typeof response.nextPage !== 'number') return false;
  return products.every((value) => {
    if (!value || typeof value !== 'object') return false;
    const product = value as Record<string, unknown>;
    if (
      typeof product.id !== 'string' || !product.id ||
      (product.name !== null && typeof product.name !== 'string') ||
      (product.brand !== null && typeof product.brand !== 'string') ||
      (product.image !== null && typeof product.image !== 'string') ||
      typeof product.nutritionLocked !== 'boolean'
    ) return false;
    if (product.nutrition === undefined) return true;
    if (product.nutritionLocked || !product.nutrition || typeof product.nutrition !== 'object') {
      return false;
    }
    const entries = Object.entries(product.nutrition as Record<string, unknown>);
    return entries.length > 0 && entries.every(([key, value]) => {
      if (!nutritionKeys.includes(key as keyof Nutrition) || !value || typeof value !== 'object') {
        return false;
      }
      const nutrient = value as Record<string, unknown>;
      return typeof nutrient.value === 'number' && Number.isFinite(nutrient.value) &&
        nutrient.value >= 0 && nutrient.unit === nutritionUnits[key as keyof Nutrition];
    });
  });
}

function lockProduct(product: Product): Product {
  return {
    id: product.id,
    name: product.name,
    brand: product.brand,
    image: product.image,
    nutritionLocked: true,
  };
}

function isRecentSearchResponse(value: unknown): value is { searches: RecentSearch[] } {
  if (!value || typeof value !== 'object') return false;
  const searches = (value as Record<string, unknown>).searches;
  return Array.isArray(searches) && searches.length <= 8 && searches.every((value) => {
    if (!value || typeof value !== 'object') return false;
    const search = value as Record<string, unknown>;
    return typeof search.query === 'string' && Boolean(search.query.trim()) &&
      isUsableSearchQuery(search.query) &&
      typeof search.locale === 'string' && locales.includes(search.locale as Locale);
  });
}

function isCheckoutResponse(value: unknown): value is { url: string } {
  if (!value || typeof value !== 'object') return false;
  const checkoutUrl = (value as Record<string, unknown>).url;
  if (typeof checkoutUrl !== 'string') return false;
  try {
    const url = new URL(checkoutUrl);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}

const ProductCard = React.memo(function ProductCard({
  product,
  messages,
  index,
  locale,
}: {
  product: Product;
  messages: Messages;
  index: number;
  locale: Locale;
}) {
  const [failedImage, setFailedImage] = useState<string | null>(null);
  const [loadedImage, setLoadedImage] = useState<string | null>(null);
  const showImage = product.image && failedImage !== product.image;
  const productNumber = String(index + 1).padStart(2, '0');

  return (
    <article className="product-card">
      <div className="product-image-wrap">
        <span className="product-number" aria-hidden="true">{productNumber}</span>
        {showImage ? (
          <>
            {loadedImage !== product.image && (
              <span className="product-image-skeleton" aria-hidden="true" />
            )}
            <Image
              src={product.image!}
              alt={product.name ?? messages.unavailable}
              fill
              sizes="(max-width: 680px) 100vw, (max-width: 1080px) 36vw, 250px"
              loading="lazy"
              decoding="async"
              className="product-image"
              onLoad={() => setLoadedImage(product.image)}
              onError={() => {
                setLoadedImage(null);
                setFailedImage(product.image);
              }}
            />
          </>
        ) : (
          <span className="image-fallback">{messages.noImage}</span>
        )}
      </div>
      <div className="product-content">
        <header className="product-heading">
          <p className="brand">{product.brand ?? messages.unknownBrand}</p>
          <h3>{product.name ?? messages.unavailable}</h3>
        </header>
        {product.nutritionLocked ? (
          <div className="locked-panel">
            <strong>{messages.locked}</strong>
            <p>{messages.lockedBody}</p>
          </div>
        ) : (
          <div className="nutrition">
            <p className="nutrition-title">{messages.nutrition}</p>
            {product.nutrition && (
              <dl className="nutrition-list">
                {nutritionKeys.filter((key) => product.nutrition?.[key] !== undefined).map((key) => {
                  const nutrient = product.nutrition?.[key];
                  return nutrient && (
                    <div className={`nutrient ${key === 'energyKcal' ? 'nutrient-primary' : ''}`} key={key}>
                      <dt>{messages[key]}</dt>
                      <dd>{formatNutritionValue(nutrient.value, locale)} {nutrient.unit}</dd>
                    </div>
                  );
                })}
              </dl>
            )}
            {!product.nutrition && <p className="muted">{messages.unavailable}</p>}
          </div>
        )}
      </div>
    </article>
  );
});

function SearchResultsSkeleton({ label }: { label: string }) {
  return (
    <>
      <p className="sr-only" role="status">{label}</p>
      <div className="results-skeleton" aria-hidden="true">
        <div className="skeleton-results-header">
          <span className="skeleton-block skeleton-heading" />
        </div>
        <div className="product-grid skeleton-grid">
          {Array.from({ length: 4 }, (_, index) => (
            <div className="product-card skeleton-card" key={index}>
              <div className="skeleton-card-image skeleton-block" />
              <div className="skeleton-card-content">
                <span className="skeleton-block skeleton-brand" />
                <span className="skeleton-block skeleton-name" />
                <span className="skeleton-block skeleton-name skeleton-name-short" />
                <span className="skeleton-block skeleton-detail" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

function ProductPageSkeleton({ label }: { label: string }) {
  return (
    <>
      <p className="sr-only" role="status">{label}</p>
      <div className="product-grid skeleton-grid pagination-skeleton" aria-hidden="true">
        {Array.from({ length: PRODUCT_BATCH_SIZE }, (_, index) => (
          <div className="product-card skeleton-card" key={index}>
            <div className="skeleton-card-image skeleton-block" />
            <div className="skeleton-card-content">
              <span className="skeleton-block skeleton-brand" />
              <span className="skeleton-block skeleton-name" />
              <span className="skeleton-block skeleton-name skeleton-name-short" />
              <span className="skeleton-block skeleton-detail" />
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

export function FoodscopeApp() {
  const [locale, setLocale] = useState<Locale>('en');
  const [query, setQuery] = useState('');
  const [products, setProducts] = useState<Product[] | null>(null);
  const [recent, setRecent] = useState<RecentSearch[]>([]);
  const [recentError, setRecentError] = useState(false);
  const [user, setUser] = useState<UserState | null>(null);
  const [accountState, setAccountState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMoreProducts, setHasMoreProducts] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState(false);
  const [resultsScrollRequest, setResultsScrollRequest] = useState(0);
  const [searchRetryAfterSeconds, setSearchRetryAfterSeconds] = useState<number | null>(null);
  const [subscribing, setSubscribing] = useState(false);
  const [searchError, setSearchError] = useState(false);
  const [checkoutError, setCheckoutError] = useState(false);
  const [checkoutRateLimited, setCheckoutRateLimited] = useState(false);
  const [checkoutConflict, setCheckoutConflict] = useState(false);
  const [checkoutCancelled, setCheckoutCancelled] = useState(false);
  const [cancellationConfirmationOpen, setCancellationConfirmationOpen] = useState(false);
  const [subscriptionUpdating, setSubscriptionUpdating] = useState(false);
  const [subscriptionUpdateError, setSubscriptionUpdateError] = useState(false);
  const [subscriptionNotice, setSubscriptionNotice] = useState<'cancelled' | 'resumed' | null>(null);
  const [backToTopVisible, setBackToTopVisible] = useState(false);
  const searchSequence = useRef(0);
  const searchController = useRef<AbortController | null>(null);
  const loadMoreController = useRef<AbortController | null>(null);
  const paginationSession = useRef<{
    requestId: string;
    query: string;
    locale: Locale;
    nextPage: number;
  } | null>(null);
  const activeSearchKey = useRef<string | null>(null);
  const retrySearchAttempt = useRef<{ key: string; requestId: string } | null>(null);
  const recentSequence = useRef(0);
  const recentController = useRef<AbortController | null>(null);
  const accountSequence = useRef(0);
  const accountController = useRef<AbortController | null>(null);
  const checkoutController = useRef<AbortController | null>(null);
  const subscriptionController = useRef<AbortController | null>(null);
  const cancellationTrigger = useRef<HTMLButtonElement | null>(null);
  const cancellationConfirm = useRef<HTMLButtonElement | null>(null);
  const resultsRef = useRef<HTMLElement | null>(null);
  const loadMoreRef = useRef<HTMLDivElement | null>(null);
  const searchRetryTimer = useRef<number | null>(null);
  const checkoutRetryTimer = useRef<number | null>(null);
  const messages = dictionaries[locale];
  const searchRateLimited = searchRetryAfterSeconds !== null;

  const refreshRecent = () => {
    recentController.current?.abort();
    const controller = new AbortController();
    recentController.current = controller;
    const requestId = ++recentSequence.current;
    return api<unknown>(
      '/api/searches/recent',
      { signal: controller.signal },
    ).then((response) => {
      if (!isRecentSearchResponse(response)) throw new Error('Invalid recent searches response');
      if (requestId === recentSequence.current) {
        setRecent(response.searches);
        setRecentError(false);
      }
    }).catch(() => {
      if (requestId === recentSequence.current && !controller.signal.aborted) {
        setRecentError(true);
      }
    }).finally(() => {
      if (recentController.current === controller) recentController.current = null;
    });
  };

  const loadAccount = async (controller: AbortController, pollAfterCheckout = false) => {
    const requestId = ++accountSequence.current;
    const delays = pollAfterCheckout ? [0, 1_000, 2_000, 4_000, 8_000] : [0];
    let loadedAccount: UserState | null = null;
    for (const delayMs of delays) {
      try {
        if (delayMs) await wait(delayMs, controller.signal);
        const candidate = await api<unknown>('/api/user', { signal: controller.signal });
        if (!isUserState(candidate)) throw new Error('Invalid account response');
        loadedAccount = candidate;
        if (controller.signal.aborted || requestId !== accountSequence.current) return;
        if (loadedAccount.nutritionAccess || !loadedAccount.billingAvailable) break;
      } catch {
        if (controller.signal.aborted || requestId !== accountSequence.current) return;
        loadedAccount = null;
      }
    }
    if (requestId !== accountSequence.current) return;
    if (loadedAccount) {
      setUser(loadedAccount);
      setAccountState('ready');
    } else {
      setAccountState('error');
    }
  };

  const loadNextPage = useCallback(async () => {
    const session = paginationSession.current;
    if (!session || !hasMoreProducts || loadMoreController.current) return;
    const controller = new AbortController();
    loadMoreController.current = controller;
    setLoadingMore(true);
    setLoadMoreError(false);
    try {
      const result = await api<unknown>(
        '/api/products/search',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            requestId: session.requestId,
            q: session.query,
            lang: session.locale,
            page: session.nextPage,
          }),
          signal: controller.signal,
        },
        REQUEST_TIMEOUT_MS.search,
      );
      if (controller.signal.aborted || paginationSession.current !== session) return;
      const account = searchResponseAccount(result);
      accountController.current?.abort();
      accountController.current = null;
      accountSequence.current += 1;
      if (!account.valid) {
        setUser(null);
        setAccountState('error');
        setProducts((currentProducts) => currentProducts?.map(lockProduct) ?? currentProducts);
        throw new Error('Invalid product response');
      }
      setUser(account.account);
      setAccountState(account.account ? 'ready' : 'error');
      const nutritionAccess = account.account?.nutritionAccess === true;
      if (!isProductSearchResponse(result)) {
        if (!nutritionAccess) {
          setProducts((currentProducts) => currentProducts?.map(lockProduct) ?? currentProducts);
        }
        throw new Error('Invalid product response');
      }
      setProducts((currentProducts) => {
        if (!currentProducts) return currentProducts;
        const reconciledProducts = nutritionAccess
          ? currentProducts
          : currentProducts.map(lockProduct);
        const seenIds = new Set(reconciledProducts.map((product) => product.id));
        const incomingProducts = nutritionAccess
          ? result.products
          : result.products.map(lockProduct);
        const newProducts = incomingProducts.filter((product) => !seenIds.has(product.id));
        return [...reconciledProducts, ...newProducts];
      });
      const canLoadMore = result.hasMore === true && typeof result.nextPage === 'number';
      setHasMoreProducts(canLoadMore);
      paginationSession.current = canLoadMore
        ? { ...session, nextPage: result.nextPage! }
        : null;
    } catch {
      if (!controller.signal.aborted && paginationSession.current === session) {
        setLoadMoreError(true);
      }
    } finally {
      if (loadMoreController.current === controller) {
        loadMoreController.current = null;
        if (!controller.signal.aborted) setLoadingMore(false);
      }
    }
  }, [hasMoreProducts]);

  useEffect(() => {
    const controller = new AbortController();
    accountController.current = controller;
    const currentUrl = new URL(window.location.href);
    const checkoutStatus = currentUrl.searchParams.get('checkout');
    const returnedFromCheckout = checkoutStatus === 'success';
    const pollAfterCheckout = returnedFromCheckout && hasRecentCheckoutMarker();
    const clearCheckoutStatus = () => {
      const latestUrl = new URL(window.location.href);
      latestUrl.searchParams.delete('checkout');
      window.history.replaceState(null, '', `${latestUrl.pathname}${latestUrl.search}${latestUrl.hash}`);
    };
    if (checkoutStatus === 'cancelled') {
      clearCheckoutMarker();
      clearCheckoutStatus();
      void Promise.resolve().then(() => {
        if (!controller.signal.aborted) setCheckoutCancelled(true);
      });
    }

    const accountRequest = loadAccount(controller, pollAfterCheckout);
    if (returnedFromCheckout) {
      void accountRequest.finally(() => {
        if (!controller.signal.aborted) {
          clearCheckoutMarker();
          clearCheckoutStatus();
        }
      });
    }
    void Promise.all([accountRequest, refreshRecent()]);
    return () => {
      accountController.current?.abort();
      searchController.current?.abort();
      loadMoreController.current?.abort();
      recentController.current?.abort();
      checkoutController.current?.abort();
      subscriptionController.current?.abort();
      if (searchRetryTimer.current !== null) window.clearTimeout(searchRetryTimer.current);
      if (checkoutRetryTimer.current !== null) window.clearTimeout(checkoutRetryTimer.current);
    };
  }, []);
  useEffect(() => { document.documentElement.lang = locale; }, [locale]);
  useEffect(() => {
    const updateBackToTopVisibility = () => setBackToTopVisible(window.scrollY > 480);
    updateBackToTopVisibility();
    window.addEventListener('scroll', updateBackToTopVisibility, { passive: true });
    return () => window.removeEventListener('scroll', updateBackToTopVisibility);
  }, []);
  useEffect(() => {
    if (resultsScrollRequest === 0) return;
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    resultsRef.current?.scrollIntoView?.({
      behavior: reduceMotion ? 'auto' : 'smooth',
      block: 'start',
    });
  }, [resultsScrollRequest]);
  useEffect(() => {
    const sentinel = loadMoreRef.current;
    if (!sentinel || !hasMoreProducts || loadingMore || loadMoreError ||
      typeof IntersectionObserver === 'undefined') return;

    let active = true;
    const observer = new IntersectionObserver((entries) => {
      if (active && entries.some((entry) => entry.isIntersecting)) {
        void loadNextPage();
      }
    }, { rootMargin: '0px 0px -35% 0px' });
    observer.observe(sentinel);
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [hasMoreProducts, loadMoreError, loadingMore, loadNextPage, products]);
  useEffect(() => {
    if (cancellationConfirmationOpen) cancellationConfirm.current?.focus();
  }, [cancellationConfirmationOpen]);

  async function runSearch(term: string, searchLocale: Locale = locale) {
    const clean = term.trim();
    if (searchRateLimited || !clean || !isUsableSearchQuery(clean)) return;
    const searchKey = `${searchLocale}\u0000${clean}`;
    if (activeSearchKey.current === searchKey) return;
    const operationId = retrySearchAttempt.current?.key === searchKey
      ? retrySearchAttempt.current.requestId
      : crypto.randomUUID();
    retrySearchAttempt.current = { key: searchKey, requestId: operationId };
    const sequenceId = ++searchSequence.current;
    searchController.current?.abort();
    loadMoreController.current?.abort();
    loadMoreController.current = null;
    paginationSession.current = null;
    const controller = new AbortController();
    searchController.current = controller;
    activeSearchKey.current = searchKey;
    setQuery(clean); setProducts(null); setLoading(true); setSearchError(false);
    setLoadingMore(false); setHasMoreProducts(false); setLoadMoreError(false);
    setResultsScrollRequest((request) => request + 1);
    try {
      const result = await api<unknown>(
        '/api/products/search',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ requestId: operationId, q: clean, lang: searchLocale, page: 1 }),
          signal: controller.signal,
        },
        REQUEST_TIMEOUT_MS.search,
      );
      if (sequenceId !== searchSequence.current) return;
      const account = searchResponseAccount(result);
      accountController.current?.abort();
      accountController.current = null;
      accountSequence.current += 1;
      if (!account.valid) {
        setUser(null);
        setAccountState('error');
        throw new Error('Invalid product response');
      }
      setUser(account.account);
      setAccountState(account.account ? 'ready' : 'error');
      if (!isProductSearchResponse(result)) throw new Error('Invalid product response');
      setProducts(result.products);
      const canLoadMore = result.hasMore === true && typeof result.nextPage === 'number';
      setHasMoreProducts(canLoadMore);
      paginationSession.current = canLoadMore
        ? { requestId: operationId, query: clean, locale: searchLocale, nextPage: result.nextPage! }
        : null;
      if (retrySearchAttempt.current?.requestId === operationId) retrySearchAttempt.current = null;
      void refreshRecent();
    } catch (searchError) {
      if (sequenceId === searchSequence.current && !(searchError instanceof DOMException && searchError.name === 'AbortError')) {
        if (
          searchError instanceof ApiResponseError &&
          searchError.status === 503 &&
          searchError.retryAfterSeconds !== undefined
        ) {
          setSearchRetryAfterSeconds(searchError.retryAfterSeconds);
          if (searchRetryTimer.current !== null) window.clearTimeout(searchRetryTimer.current);
          searchRetryTimer.current = window.setTimeout(() => {
            searchRetryTimer.current = null;
            setSearchRetryAfterSeconds(null);
          }, searchError.retryAfterSeconds * 1000);
        } else {
          setSearchError(true);
        }
        setProducts(null);
        setHasMoreProducts(false);
        paginationSession.current = null;
      }
    } finally {
      if (sequenceId === searchSequence.current) {
        setLoading(false);
        searchController.current = null;
        activeSearchKey.current = null;
      }
    }
  }

  function changeLocale(nextLocale: Locale) {
    searchSequence.current += 1;
    searchController.current?.abort();
    loadMoreController.current?.abort();
    searchController.current = null;
    loadMoreController.current = null;
    paginationSession.current = null;
    activeSearchKey.current = null;
    retrySearchAttempt.current = null;
    setLoading(false); setLoadingMore(false); setHasMoreProducts(false); setLoadMoreError(false);
    setProducts(null); setSearchError(false); setLocale(nextLocale);
  }

  function submit(event: FormEvent) { event.preventDefault(); void runSearch(query); }
  async function subscribe() {
    if (checkoutController.current) return;
    const controller = new AbortController();
    checkoutController.current = controller;
    setSubscribing(true); setCheckoutError(false); setCheckoutCancelled(false);
    try {
      const checkout = await api<unknown>(
        '/api/billing/checkout-session',
        { method: 'POST', signal: controller.signal },
        REQUEST_TIMEOUT_MS.checkout,
      );
      if (!isCheckoutResponse(checkout)) throw new Error('Invalid Checkout response');
      if (controller.signal.aborted) return;
      markCheckoutInitiated();
      try {
        window.location.assign(checkout.url);
      } catch (error) {
        clearCheckoutMarker();
        throw error;
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof ApiResponseError && error.status === 429) {
        setCheckoutRateLimited(true);
        checkoutRetryTimer.current = window.setTimeout(() => {
          checkoutRetryTimer.current = null;
          setCheckoutRateLimited(false);
        }, (error.retryAfterSeconds ?? 60) * 1000);
      } else if (error instanceof ApiResponseError && error.status === 409) {
        setCheckoutConflict(true);
        accountController.current?.abort();
        const controller = new AbortController();
        accountController.current = controller;
        setAccountState('loading');
        await loadAccount(controller);
      } else {
        setCheckoutError(true);
      }
      setSubscribing(false);
    } finally {
      if (checkoutController.current === controller) checkoutController.current = null;
    }
  }

  function closeCancellationConfirmation() {
    setCancellationConfirmationOpen(false);
    window.setTimeout(() => cancellationTrigger.current?.focus(), 0);
  }

  async function updateSubscriptionCancellation(cancelAtPeriodEnd: boolean) {
    if (subscriptionController.current) return;
    const controller = new AbortController();
    subscriptionController.current = controller;
    setSubscriptionUpdating(true);
    setSubscriptionUpdateError(false);
    setSubscriptionNotice(null);
    try {
      const updatedAccount = await api<unknown>(
        '/api/billing/subscription-cancellation',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ requestId: crypto.randomUUID(), cancelAtPeriodEnd }),
          signal: controller.signal,
        },
        REQUEST_TIMEOUT_MS.subscription,
      );
      if (!isUserState(updatedAccount)) throw new Error('Invalid subscription response');
      if (controller.signal.aborted) return;
      accountController.current?.abort();
      accountController.current = null;
      accountSequence.current += 1;
      setUser(updatedAccount);
      setAccountState('ready');
      setSubscriptionNotice(cancelAtPeriodEnd ? 'cancelled' : 'resumed');
      if (cancelAtPeriodEnd) setCancellationConfirmationOpen(false);
    } catch (error) {
      if (controller.signal.aborted) return;
      setSubscriptionUpdateError(true);
      if (error instanceof ApiResponseError && error.status === 409) {
        accountController.current?.abort();
        const accountRefresh = new AbortController();
        accountController.current = accountRefresh;
        await loadAccount(accountRefresh);
      }
    } finally {
      if (subscriptionController.current === controller) subscriptionController.current = null;
      if (!controller.signal.aborted) setSubscriptionUpdating(false);
    }
  }

  function retryAccount() {
    setCheckoutConflict(false);
    accountController.current?.abort();
    const controller = new AbortController();
    accountController.current = controller;
    setAccountState('loading');
    void loadAccount(controller);
  }

  const planHeading = accountState === 'loading'
    ? messages.loading
    : accountState === 'error'
      ? messages.accountUnavailable
      : user?.nutritionAccess
        ? messages.plan
        : messages.inactive;
  const formattedPeriodEnd = user?.currentPeriodEnd
    ? formatSubscriptionDate(user.currentPeriodEnd, locale)
    : null;
  const planMeta = formattedPeriodEnd
    ? user?.cancellationScheduled
      ? messages.accessUntil(formattedPeriodEnd)
      : messages.renewsOn(formattedPeriodEnd)
    : messages.monthly;
  const subscriptionNoticeText = subscriptionNotice && formattedPeriodEnd
    ? subscriptionNotice === 'cancelled'
      ? messages.cancellationSuccess(formattedPeriodEnd)
      : messages.resumeSuccess(formattedPeriodEnd)
    : null;
  const isPlusMember = accountState === 'ready' && Boolean(user?.nutritionAccess);

  return (
    <main className="app-shell">
      <div className="hero-stage">
        <header className="topbar">
          <a href="#content" className="wordmark" aria-label="Foodscope home">
            <span>food</span><strong>scope</strong>
            {isPlusMember ? <small className="wordmark-plus-badge" aria-hidden="true">PLUS</small> : null}
          </a>
          <label className="locale-control">
            <span>{messages.language}</span>
            <select
              aria-label={messages.language}
              value={locale}
              onChange={(event) => changeLocale(event.target.value as Locale)}
            >
              {locales.map((item) => <option key={item} value={item}>{localeNames[item]}</option>)}
            </select>
          </label>
        </header>

        <section className="hero" id="content" tabIndex={-1}>
          <div className="hero-copy">
            <p className="eyebrow">{messages.eyebrow}</p>
            <h1><span>{messages.titleStart}</span><strong>{messages.titleAccent}</strong></h1>
            <p className="intro">{messages.intro}</p>
          </div>

          <div className="hero-tools">
            <div className="search-workbench" id="search">
              <form onSubmit={submit} className="search-form">
                <label htmlFor="product-search">{messages.searchLabel}</label>
                <div className="search-row">
                  <input
                    id="product-search"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder={messages.searchPlaceholder}
                    maxLength={MAX_SEARCH_QUERY_CHARACTERS * 2}
                  />
                  <button disabled={loading || searchRateLimited || !query.trim() || !isUsableSearchQuery(query)}>
                    {loading ? messages.searching : messages.search}
                  </button>
                </div>
              </form>

              {recent.length > 0 && (
                <div className="recent">
                  <span>{messages.recent}</span>
                  <div>
                    {recent.map((item, index) => (
                      <button
                        disabled={searchRateLimited}
                        key={`${item.locale}:${item.query}:${index}`}
                        onClick={() => {
                          const recentLocale = item.locale as Locale;
                          setLocale(recentLocale);
                          setQuery(item.query);
                          void runSearch(item.query, recentLocale);
                        }}
                      >
                        <span>{item.query}</span>
                        <span className="recent-locale">{localeNames[item.locale as Locale]}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div className="feedback-stack">
                {recentError && (
                  <div className="recent-recovery">
                    <p role="alert">{messages.recentUnavailable}</p>
                    <button onClick={() => void refreshRecent()}>{messages.retryRecent}</button>
                  </div>
                )}
                {checkoutCancelled && <p className="notice" role="status">{messages.checkoutCancelled}</p>}
              </div>

              <aside
                className={`plan-card ${isPlusMember ? 'plan-card-member' : 'plan-card-free'}`}
                id="plus"
                aria-labelledby="plan-title"
              >
                <div className="plan-copy">
                  <div className="plan-top">
                    <strong id="plan-title" role="status">{planHeading}</strong>
                  </div>
                  <p className="plan-description">{messages.subscriptionBody}</p>
                  <small>{planMeta}</small>
                </div>
                <div className="plan-action">
                  {accountState === 'error' && <button className="plan-primary-button" type="button" onClick={retryAccount}>{messages.retryAccount}</button>}
                  {accountState === 'ready' && !user?.nutritionAccess && user?.billingAvailable && user.checkoutAvailable && !checkoutConflict && (
                    <button className="plan-primary-button" type="button" onClick={() => void subscribe()} disabled={subscribing || checkoutRateLimited}>
                      {subscribing ? messages.redirecting : messages.subscribe}
                    </button>
                  )}
                  {accountState === 'ready' && !user?.nutritionAccess && user?.billingAvailable === false && <p className="plan-note">{messages.checkoutUnavailable}</p>}
                  {accountState === 'ready' && !user?.nutritionAccess && user?.billingAvailable && (!user.checkoutAvailable || checkoutConflict) && <p className="plan-note">{messages.checkoutBlocked}</p>}
                  {accountState === 'ready' && !user?.nutritionAccess && user?.billingAvailable && checkoutConflict && <button className="plan-primary-button" type="button" onClick={retryAccount}>{messages.retryAccount}</button>}
                  {accountState === 'ready' && user?.nutritionAccess && user.subscriptionManagementAvailable && (
                    user.cancellationScheduled ? (
                      <button
                        className="plan-primary-button"
                        type="button"
                        onClick={() => void updateSubscriptionCancellation(false)}
                        disabled={subscriptionUpdating}
                      >
                        {subscriptionUpdating ? messages.resuming : messages.resumeSubscription}
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="plan-manage-button"
                        ref={cancellationTrigger}
                        onClick={() => {
                          setSubscriptionUpdateError(false);
                          setSubscriptionNotice(null);
                          setCancellationConfirmationOpen(true);
                        }}
                      >
                        {messages.cancelSubscription}
                      </button>
                    )
                  )}
                  {checkoutError && <p className="plan-alert" role="alert">{messages.checkoutError}</p>}
                  {checkoutRateLimited && <p className="plan-alert" role="alert">{messages.checkoutRateLimited}</p>}
                </div>
                {subscriptionNoticeText && <p className="plan-status" role="status">{subscriptionNoticeText}</p>}
                {subscriptionUpdateError && <p className="plan-alert plan-wide" role="alert">{messages.subscriptionUpdateError}</p>}
                {cancellationConfirmationOpen && formattedPeriodEnd && (
                  <div
                    className="plan-confirmation"
                    role="alertdialog"
                    aria-labelledby="cancellation-title"
                    aria-describedby="cancellation-description"
                    onKeyDown={(event) => {
                      if (event.key === 'Escape' && !subscriptionUpdating) closeCancellationConfirmation();
                    }}
                  >
                    <div>
                      <strong id="cancellation-title">{messages.cancellationHeading}</strong>
                      <p id="cancellation-description">{messages.cancellationBody(formattedPeriodEnd)}</p>
                    </div>
                    <div className="confirmation-actions">
                      <button type="button" onClick={closeCancellationConfirmation} disabled={subscriptionUpdating}>
                        {messages.dismissCancellation}
                      </button>
                      <button
                        type="button"
                        className="danger-action"
                        ref={cancellationConfirm}
                        onClick={() => void updateSubscriptionCancellation(true)}
                        disabled={subscriptionUpdating}
                      >
                        {subscriptionUpdating ? messages.cancelling : messages.confirmCancellation}
                      </button>
                    </div>
                  </div>
                )}
              </aside>
            </div>
          </div>
        </section>
      </div>

      <section
        ref={resultsRef}
        className="results-section"
        id="results"
        aria-live="polite"
        aria-busy={loading}
      >
        {products && (
          <div className="results-header">
            <h2>{messages.results}</h2>
            <button onClick={() => {
              loadMoreController.current?.abort();
              loadMoreController.current = null;
              paginationSession.current = null;
              setLoadingMore(false);
              setHasMoreProducts(false);
              setLoadMoreError(false);
              setProducts(null);
            }}>{messages.clear}</button>
          </div>
        )}
        {!loading && products === null && !searchError && searchRetryAfterSeconds === null && (
          <section
            className="search-tips grid min-h-[clamp(440px,35vw,560px)] grid-cols-[minmax(320px,.72fr)_minmax(0,1.28fr)] gap-[clamp(34px,4.5vw,72px)] py-[clamp(36px,3.8vw,54px)] max-[760px]:min-h-0 max-[760px]:grid-cols-1 max-[760px]:gap-0 max-[760px]:py-0"
            aria-labelledby="search-tips-title"
          >
            <div className="flex flex-col justify-center gap-[clamp(52px,6vw,88px)] border-r border-[var(--line)] pr-[clamp(28px,4vw,64px)] max-[760px]:gap-6 max-[760px]:border-r-0 max-[760px]:border-b max-[760px]:pb-[34px] max-[760px]:pr-0">
              <p className="m-0 text-[clamp(.78rem,1.35vw,1.15rem)] font-bold tracking-[.08em] text-[var(--violet)] uppercase [font-family:var(--font-mono),monospace]">
                {messages.emptyTipsLabel}
              </p>
              <h2
                className="m-0 max-w-[460px] text-[clamp(2.25rem,3.5vw,4rem)] leading-[1.14] font-medium tracking-[-.045em] max-[760px]:max-w-[540px] max-[560px]:text-[clamp(2rem,11vw,3rem)]"
                id="search-tips-title"
              >
                {messages.emptyTipsTitle}
              </h2>
            </div>
            <ol className="m-0 grid list-none grid-rows-3 p-0">
              {[
                [messages.emptyTipProductTitle, messages.emptyTipProductBody],
                [messages.emptyTipBrandTitle, messages.emptyTipBrandBody],
                [messages.emptyTipWordsTitle, messages.emptyTipWordsBody],
              ].map(([title, body], index) => (
                <li
                  className="grid grid-cols-[clamp(72px,9vw,140px)_minmax(0,1fr)] items-center gap-[clamp(18px,2.5vw,40px)] border-b border-[var(--line)] last:border-b-0 max-[760px]:min-h-[138px] max-[760px]:grid-cols-[60px_minmax(0,1fr)] max-[760px]:gap-[18px] max-[760px]:py-[22px] max-[560px]:min-h-0 max-[560px]:grid-cols-[44px_minmax(0,1fr)] max-[560px]:gap-3"
                  key={title}
                >
                  <span
                    className="text-[clamp(1.55rem,2.4vw,2.15rem)] font-medium tracking-[-.04em] text-[var(--coral)] [font-family:var(--font-mono),monospace]"
                    aria-hidden="true"
                  >
                    {String(index + 1).padStart(2, '0')}
                  </span>
                  <div>
                    <h3 className="m-0 text-[clamp(.86rem,1.5vw,1.25rem)] leading-[1.25] font-bold tracking-[.055em] uppercase [font-family:var(--font-mono),monospace]">
                      {title}
                    </h3>
                    <p className="mt-4 mb-0 text-[clamp(.94rem,1.45vw,1.22rem)] leading-[1.45] text-[var(--muted)] max-[560px]:mt-2.5">
                      {body}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          </section>
        )}
        {!loading && products === null && searchError && (
          <div className="empty results-error" role="alert">
            <span aria-hidden="true">!</span>
            <p>{messages.error}</p>
            <button type="button" onClick={() => void runSearch(query)}>{messages.retrySearch}</button>
          </div>
        )}
        {!loading && products === null && searchRetryAfterSeconds !== null && (
          <div className="empty results-error" role="alert">
            <span aria-hidden="true">!</span>
            <p>{messages.searchRateLimited(formatRetryDelay(searchRetryAfterSeconds, locale))}</p>
          </div>
        )}
        {!loading && products?.length === 0 && (
          <div className="empty"><span aria-hidden="true">00</span><p>{messages.emptyResults}</p></div>
        )}
        {loading && (
          <SearchResultsSkeleton label={messages.searching} />
        )}
        {products && products.length > 0 && (
          <div className="product-grid">
            {products.map((product, index) => (
              <ProductCard
                key={product.id}
                product={product}
                messages={messages}
                index={index}
                locale={locale}
              />
            ))}
          </div>
        )}
        {loadingMore && <ProductPageSkeleton label={messages.loadingMore} />}
        {products && hasMoreProducts && !loadingMore && (
          <div className="load-more" ref={loadMoreRef}>
            {loadMoreError && <p className="load-more-error" role="alert">{messages.loadMoreError}</p>}
            <button
              type="button"
              onClick={() => void loadNextPage()}
            >
              {loadMoreError ? messages.retryLoadMore : messages.loadMore}
            </button>
          </div>
        )}
      </section>
      <footer className="site-footer">
        <div className="site-footer-inner">
          <div className="footer-main">
            <div className="footer-intro">
              <a href="#content" className="footer-brand" aria-label="Foodscope home">
                <span>food</span><strong>scope</strong>
              </a>
              <p>{messages.footerTagline}</p>
            </div>

            <nav className="footer-nav" aria-label={messages.footerNavigation}>
              <section>
                <h2>{messages.footerExplore}</h2>
                <ul className="footer-link-list">
                  <li><a href="#search">{messages.footerSearch}</a></li>
                  <li><a href="#plus">Foodscope Plus</a></li>
                  <li><a href="#results">{messages.results}</a></li>
                </ul>
              </section>

              <section>
                <h2>{messages.footerData}</h2>
                <p className="attribution footer-attribution">
                  {messages.attributionPrefix} <a href="https://world.openfoodfacts.org/">Open Food Facts</a>,
                  {' '}{messages.attributionLicense} <a href="https://opendatacommons.org/licenses/odbl/1-0/">ODbL</a>.
                  {' '}{messages.imageAttribution} <a href="https://creativecommons.org/licenses/by-sa/3.0/">CC BY-SA 3.0</a>.
                </p>
              </section>
            </nav>
          </div>

        </div>
      </footer>
      <button
        type="button"
        className={`back-to-top-button ${backToTopVisible ? 'back-to-top-visible' : ''}`}
        aria-hidden={!backToTopVisible}
        tabIndex={backToTopVisible ? 0 : -1}
        onClick={() => {
          const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
          window.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' });
          document.getElementById('content')?.focus({ preventScroll: true });
        }}
      >
        {messages.footerBackToTop}
      </button>
    </main>
  );
}
