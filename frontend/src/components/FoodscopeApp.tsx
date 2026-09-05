'use client';

import Image from 'next/image';
import React, { FormEvent, useEffect, useRef, useState } from 'react';
import { resolveApiUrl } from '@/config';
import { dictionaries, locales, type Locale, type Messages } from '@/i18n';
import type { Nutrition, Product, RecentSearch, UserState } from '@/types';

const API_URL = resolveApiUrl(process.env.NEXT_PUBLIC_API_URL, process.env.NODE_ENV);
const localeNames: Record<Locale, string> = { en: 'EN', nl: 'NL', de: 'DE', fr: 'FR' };
const nutritionKeys: Array<keyof Nutrition> = ['energyKcal', 'fat', 'saturatedFat', 'carbohydrates', 'sugars', 'protein', 'salt', 'sodium'];
export const REQUEST_TIMEOUT_MS = {
  account: 8_000,
  search: 22_000,
  checkout: 20_000,
} as const;

class ApiResponseError extends Error {
  constructor(readonly status: number) {
    super('Request failed');
  }
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
    if (!response.ok) throw new ApiResponseError(response.status);
    return response.json() as Promise<T>;
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
  return typeof candidate.email === 'string'
    && typeof candidate.subscriptionStatus === 'string'
    && (candidate.subscriptionCurrentPeriodEnd === null || typeof candidate.subscriptionCurrentPeriodEnd === 'string')
    && typeof candidate.nutritionAccess === 'boolean'
    && typeof candidate.billingAvailable === 'boolean';
}

function ProductCard({ product, messages }: { product: Product; messages: Messages }) {
  const [failedImage, setFailedImage] = useState<string | null>(null);
  const showImage = product.image && failedImage !== product.image;
  return (
    <article className="product-card">
      <div className="product-image-wrap">
        {showImage ? <Image src={product.image!} alt={product.name ?? messages.unavailable} fill sizes="(max-width: 720px) 100vw, 33vw" className="product-image" onError={() => setFailedImage(product.image)} /> : <span className="image-fallback" aria-hidden="true">◌</span>}
      </div>
      <div className="product-content">
        <p className="brand">{product.brand ?? messages.unknownBrand}</p>
        <h3>{product.name ?? messages.unavailable}</h3>
        {product.nutritionLocked ? (
          <div className="locked-panel"><span className="lock-icon" aria-hidden="true">⌾</span><div><strong>{messages.locked}</strong><p>{messages.lockedBody}</p></div></div>
        ) : (
          <div className="nutrition">
            <p className="nutrition-title">{messages.nutrition}</p>
            {product.nutrition && nutritionKeys.filter((key) => product.nutrition?.[key] !== undefined).map((key) => {
              const nutrient = product.nutrition?.[key];
              return nutrient && <div className="nutrient" key={key}><span>{messages[key]}</span><strong>{nutrient.value} {nutrient.unit}</strong></div>;
            })}
            {!product.nutrition && <p className="muted">{messages.unavailable}</p>}
          </div>
        )}
      </div>
    </article>
  );
}

export function FoodscopeApp() {
  const [locale, setLocale] = useState<Locale>('en');
  const [query, setQuery] = useState('');
  const [products, setProducts] = useState<Product[] | null>(null);
  const [recent, setRecent] = useState<RecentSearch[]>([]);
  const [user, setUser] = useState<UserState | null>(null);
  const [accountState, setAccountState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [loading, setLoading] = useState(false);
  const [subscribing, setSubscribing] = useState(false);
  const [searchError, setSearchError] = useState(false);
  const [checkoutError, setCheckoutError] = useState(false);
  const [checkoutCancelled, setCheckoutCancelled] = useState(false);
  const searchSequence = useRef(0);
  const searchController = useRef<AbortController | null>(null);
  const activeSearchKey = useRef<string | null>(null);
  const retrySearchAttempt = useRef<{ key: string; requestId: string } | null>(null);
  const recentSequence = useRef(0);
  const accountSequence = useRef(0);
  const accountController = useRef<AbortController | null>(null);
  const messages = dictionaries[locale];

  const refreshRecent = (signal?: AbortSignal) => {
    const requestId = ++recentSequence.current;
    return api<{ searches: RecentSearch[] }>(
      '/api/searches/recent',
      signal ? { signal } : undefined,
    ).then(({ searches }) => {
      if (requestId === recentSequence.current) setRecent(searches);
    }).catch(() => undefined);
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
        if (loadedAccount.nutritionAccess) break;
      } catch {
        if (controller.signal.aborted || requestId !== accountSequence.current) return;
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

  useEffect(() => {
    const controller = new AbortController();
    accountController.current = controller;
    const currentUrl = new URL(window.location.href);
    const checkoutStatus = currentUrl.searchParams.get('checkout');
    const returnedFromCheckout = checkoutStatus === 'success';
    if (checkoutStatus === 'success' || checkoutStatus === 'cancelled') {
      currentUrl.searchParams.delete('checkout');
      window.history.replaceState(null, '', `${currentUrl.pathname}${currentUrl.search}${currentUrl.hash}`);
    }
    if (checkoutStatus === 'cancelled') {
      void Promise.resolve().then(() => {
        if (!controller.signal.aborted) setCheckoutCancelled(true);
      });
    }

    void Promise.all([loadAccount(controller, returnedFromCheckout), refreshRecent(controller.signal)]);
    return () => {
      accountController.current?.abort();
      searchController.current?.abort();
    };
  }, []);
  useEffect(() => { document.documentElement.lang = locale; }, [locale]);

  async function runSearch(term: string, searchLocale: Locale = locale) {
    const clean = term.trim();
    if (!clean) return;
    const searchKey = `${searchLocale}\u0000${clean}`;
    if (activeSearchKey.current === searchKey) return;
    const operationId = retrySearchAttempt.current?.key === searchKey
      ? retrySearchAttempt.current.requestId
      : crypto.randomUUID();
    retrySearchAttempt.current = { key: searchKey, requestId: operationId };
    const sequenceId = ++searchSequence.current;
    searchController.current?.abort();
    const controller = new AbortController();
    searchController.current = controller;
    activeSearchKey.current = searchKey;
    setQuery(clean); setProducts(null); setLoading(true); setSearchError(false);
    try {
      const result = await api<{ products: Product[] }>(
        '/api/products/search',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ requestId: operationId, q: clean, lang: searchLocale }),
          signal: controller.signal,
        },
        REQUEST_TIMEOUT_MS.search,
      );
      if (sequenceId !== searchSequence.current) return;
      setProducts(result.products);
      if (retrySearchAttempt.current?.requestId === operationId) retrySearchAttempt.current = null;
      await refreshRecent(controller.signal);
    } catch (searchError) {
      if (sequenceId === searchSequence.current && !(searchError instanceof DOMException && searchError.name === 'AbortError')) {
        setSearchError(true); setProducts(null);
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
    searchController.current = null;
    activeSearchKey.current = null;
    retrySearchAttempt.current = null;
    setLoading(false); setProducts(null); setSearchError(false); setLocale(nextLocale);
  }

  function submit(event: FormEvent) { event.preventDefault(); void runSearch(query); }
  async function subscribe() {
    setSubscribing(true); setCheckoutError(false); setCheckoutCancelled(false);
    try {
      const { url } = await api<{ url: string }>(
        '/api/billing/checkout-session',
        { method: 'POST' },
        REQUEST_TIMEOUT_MS.checkout,
      );
      window.location.assign(url);
    } catch (error) {
      if (error instanceof ApiResponseError && error.status === 409) {
        accountController.current?.abort();
        const controller = new AbortController();
        accountController.current = controller;
        setAccountState('loading');
        await loadAccount(controller);
      } else {
        setCheckoutError(true);
      }
      setSubscribing(false);
    }
  }

  function retryAccount() {
    accountController.current?.abort();
    const controller = new AbortController();
    accountController.current = controller;
    setAccountState('loading');
    void loadAccount(controller);
  }

  return (
    <main>
      <header className="topbar">
        <a href="#content" className="wordmark" aria-label="Foodscope home"><span className="logo-mark">f</span>foodscope</a>
        <label className="locale-control"><span>{messages.language}</span><select aria-label={messages.language} value={locale} onChange={(event) => changeLocale(event.target.value as Locale)}>{locales.map((item) => <option key={item} value={item}>{localeNames[item]}</option>)}</select></label>
      </header>

      <section className="hero" id="content">
        <div className="hero-copy">
          <p className="eyebrow"><span />{messages.eyebrow}</p>
          <h1>{messages.titleStart}<br /><em>{messages.titleAccent}</em></h1>
          <p className="intro">{messages.intro}</p>
          <form onSubmit={submit} className="search-form">
            <label className="sr-only" htmlFor="product-search">{messages.searchLabel}</label>
            <span aria-hidden="true" className="search-symbol">⌕</span>
            <input id="product-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={messages.searchPlaceholder} maxLength={120} />
            <button disabled={loading || !query.trim()}>{loading ? messages.searching : messages.search}<span aria-hidden="true">→</span></button>
          </form>
          {recent.length > 0 && <div className="recent"><span>{messages.recent}</span><div>{recent.map((item) => <button key={item.id} onClick={() => { const recentLocale = locales.includes(item.locale as Locale) ? item.locale as Locale : locale; setLocale(recentLocale); void runSearch(item.query, recentLocale); }}>{item.query}</button>)}</div></div>}
          {checkoutCancelled && <p className="notice" role="status">{messages.checkoutCancelled}</p>}
          {searchError && <p className="alert" role="alert">{messages.error}</p>}
        </div>

        <aside className="plan-card">
          <div className="plan-top"><span className="spark" aria-hidden="true">✣</span><div><p>{messages.plan}</p><strong>{accountState === 'loading' ? messages.loading : accountState === 'error' ? messages.accountUnavailable : user?.nutritionAccess ? messages.active : messages.inactive}</strong></div><span aria-hidden="true" className={`status-dot ${accountState === 'ready' && user?.nutritionAccess ? 'on' : ''}`} /></div>
          <p>{messages.subscriptionBody}</p>
          {accountState === 'error' && <button onClick={retryAccount}>{messages.retryAccount}<span aria-hidden="true">↻</span></button>}
          {accountState === 'ready' && !user?.nutritionAccess && user?.billingAvailable === true && <button onClick={() => void subscribe()} disabled={subscribing}>{subscribing ? messages.redirecting : messages.subscribe}<span aria-hidden="true">↗</span></button>}
          {accountState === 'ready' && !user?.nutritionAccess && user?.billingAvailable === false && <p className="plan-note">{messages.checkoutUnavailable}</p>}
          {checkoutError && <p className="plan-alert" role="alert">{messages.checkoutError}</p>}
          <small>{messages.monthly}</small>
        </aside>
      </section>

      <section className="results-section" aria-live="polite" aria-busy={loading}>
        {products && <div className="results-header"><div><p>{messages.results}</p><span>{products.length} {messages.resultCount}</span></div><button onClick={() => setProducts(null)}>{messages.clear}</button></div>}
        {!loading && products === null && !searchError && <div className="empty"><span aria-hidden="true">⌕</span><p>{messages.emptyStart}</p></div>}
        {!loading && products?.length === 0 && <div className="empty"><span aria-hidden="true">○</span><p>{messages.emptyResults}</p></div>}
        {loading && <div className="empty"><span className="spinner" aria-hidden="true" /><p>{messages.searching}</p></div>}
        {products && products.length > 0 && <div className="product-grid">{products.map((product) => <ProductCard key={product.id} product={product} messages={messages} />)}</div>}
      </section>
      <footer>
        <span>Foodscope</span>
        <span className="attribution">
          {messages.attributionPrefix} <a href="https://world.openfoodfacts.org/">Open Food Facts</a>,
          {' '}{messages.attributionLicense} <a href="https://opendatacommons.org/licenses/odbl/1-0/">ODbL</a>.
          {' '}{messages.imageAttribution} <a href="https://creativecommons.org/licenses/by-sa/3.0/">CC BY-SA 3.0</a>.
        </span>
      </footer>
    </main>
  );
}
