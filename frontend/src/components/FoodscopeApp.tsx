'use client';

import Image from 'next/image';
import React, { FormEvent, useEffect, useRef, useState } from 'react';
import { resolveApiUrl } from '@/config';
import { dictionaries, locales, type Locale, type Messages } from '@/i18n';
import type { Nutrition, Product, RecentSearch, UserState } from '@/types';

const API_URL = resolveApiUrl(process.env.NEXT_PUBLIC_API_URL, process.env.NODE_ENV);
const localeNames: Record<Locale, string> = { en: 'EN', nl: 'NL', de: 'DE', fr: 'FR' };
const nutritionKeys: Array<keyof Nutrition> = ['energyKcal', 'fat', 'saturatedFat', 'carbohydrates', 'sugars', 'protein', 'salt', 'sodium'];

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, { ...init, cache: 'no-store' });
  if (!response.ok) throw new Error('Request failed');
  return response.json() as Promise<T>;
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
  const [loading, setLoading] = useState(false);
  const [subscribing, setSubscribing] = useState(false);
  const [error, setError] = useState(false);
  const searchSequence = useRef(0);
  const searchController = useRef<AbortController | null>(null);
  const recentSequence = useRef(0);
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

  useEffect(() => {
    const controller = new AbortController();
    const currentUrl = new URL(window.location.href);
    const returnedFromCheckout = currentUrl.searchParams.get('checkout') === 'success';
    if (returnedFromCheckout) {
      currentUrl.searchParams.delete('checkout');
      window.history.replaceState(null, '', `${currentUrl.pathname}${currentUrl.search}${currentUrl.hash}`);
    }

    const loadAccount = async () => {
      const delays = returnedFromCheckout ? [0, 1_000, 2_000, 4_000, 8_000] : [0];
      let loaded = false;
      for (const delayMs of delays) {
        try {
          if (delayMs) await wait(delayMs, controller.signal);
          const account = await api<UserState>('/api/user', { signal: controller.signal });
          if (controller.signal.aborted) return;
          loaded = true;
          setUser(account);
          if (account.nutritionAccess) return;
        } catch {
          if (controller.signal.aborted) return;
        }
      }
      if (!loaded) setError(true);
    };

    void Promise.all([loadAccount(), refreshRecent(controller.signal)]);
    return () => {
      controller.abort();
      searchController.current?.abort();
    };
  }, []);
  useEffect(() => { document.documentElement.lang = locale; }, [locale]);

  async function runSearch(term: string, searchLocale: Locale = locale) {
    const clean = term.trim();
    if (!clean) return;
    const requestId = ++searchSequence.current;
    searchController.current?.abort();
    const controller = new AbortController();
    searchController.current = controller;
    setQuery(clean); setProducts(null); setLoading(true); setError(false);
    try {
      const result = await api<{ products: Product[] }>(
        `/api/products/search?q=${encodeURIComponent(clean)}&lang=${searchLocale}`,
        { signal: controller.signal },
      );
      if (requestId !== searchSequence.current) return;
      setProducts(result.products);
      await refreshRecent(controller.signal);
    } catch (searchError) {
      if (requestId === searchSequence.current && !(searchError instanceof DOMException && searchError.name === 'AbortError')) {
        setError(true); setProducts(null);
      }
    } finally {
      if (requestId === searchSequence.current) {
        setLoading(false);
        searchController.current = null;
      }
    }
  }

  function changeLocale(nextLocale: Locale) {
    searchSequence.current += 1;
    searchController.current?.abort();
    searchController.current = null;
    setLoading(false); setProducts(null); setError(false); setLocale(nextLocale);
  }

  function submit(event: FormEvent) { event.preventDefault(); void runSearch(query); }
  async function subscribe() {
    setSubscribing(true); setError(false);
    try {
      const { url } = await api<{ url: string }>('/api/billing/checkout-session', { method: 'POST' });
      window.location.assign(url);
    } catch { setError(true); setSubscribing(false); }
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
          {error && <p className="alert" role="alert">{messages.error}</p>}
        </div>

        <aside className="plan-card">
          <div className="plan-top"><span className="spark" aria-hidden="true">✣</span><div><p>{messages.plan}</p><strong>{user?.nutritionAccess ? messages.active : messages.inactive}</strong></div><span aria-hidden="true" className={`status-dot ${user?.nutritionAccess ? 'on' : ''}`} /></div>
          <p>{messages.subscriptionBody}</p>
          {!user?.nutritionAccess && <button onClick={() => void subscribe()} disabled={subscribing}>{subscribing ? messages.redirecting : messages.subscribe}<span>↗</span></button>}
          <small>{messages.monthly}</small>
        </aside>
      </section>

      <section className="results-section" aria-live="polite" aria-busy={loading}>
        {products && <div className="results-header"><div><p>{messages.results}</p><span>{products.length} {messages.resultCount}</span></div><button onClick={() => setProducts(null)}>{messages.clear}</button></div>}
        {!loading && products === null && !error && <div className="empty"><span aria-hidden="true">⌕</span><p>{messages.emptyStart}</p></div>}
        {!loading && products?.length === 0 && <div className="empty"><span aria-hidden="true">○</span><p>{messages.emptyResults}</p></div>}
        {loading && <div className="empty"><span className="spinner" aria-hidden="true" /><p>{messages.searching}</p></div>}
        {products && products.length > 0 && <div className="product-grid">{products.map((product) => <ProductCard key={product.id} product={product} messages={messages} />)}</div>}
      </section>
      <footer><span>Foodscope</span><span>Data by Open Food Facts</span></footer>
    </main>
  );
}
