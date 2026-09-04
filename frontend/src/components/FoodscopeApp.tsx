'use client';

import Image from 'next/image';
import React, { FormEvent, useEffect, useState } from 'react';
import { dictionaries, locales, type Locale, type Messages } from '@/i18n';
import type { Nutrition, Product, RecentSearch, UserState } from '@/types';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
const localeNames: Record<Locale, string> = { en: 'EN', nl: 'NL', de: 'DE', fr: 'FR' };
const nutritionKeys: Array<keyof Nutrition> = ['energyKcal', 'fat', 'saturatedFat', 'carbohydrates', 'sugars', 'protein', 'salt', 'sodium'];

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, init);
  if (!response.ok) throw new Error('Request failed');
  return response.json() as Promise<T>;
}

function ProductCard({ product, messages }: { product: Product; messages: Messages }) {
  return (
    <article className="product-card">
      <div className="product-image-wrap">
        {product.image ? <Image src={product.image} alt={product.name ?? messages.unavailable} fill sizes="(max-width: 720px) 100vw, 33vw" className="product-image" /> : <span className="image-fallback" aria-hidden="true">◌</span>}
      </div>
      <div className="product-content">
        <p className="brand">{product.brand ?? messages.unknownBrand}</p>
        <h3>{product.name ?? messages.unavailable}</h3>
        {product.nutritionLocked ? (
          <div className="locked-panel"><span className="lock-icon" aria-hidden="true">⌾</span><div><strong>{messages.locked}</strong><p>{messages.lockedBody}</p></div></div>
        ) : (
          <div className="nutrition">
            <p className="nutrition-title">{messages.nutrition}</p>
            {product.nutrition && nutritionKeys.filter((key) => product.nutrition?.[key] !== undefined).map((key) => (
              <div className="nutrient" key={key}><span>{messages[key]}</span><strong>{product.nutrition?.[key]} {key === 'energyKcal' ? 'kcal' : 'g'}</strong></div>
            ))}
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
  const messages = dictionaries[locale];

  const refreshAccount = () => api<UserState>('/api/user').then(setUser).catch(() => setError(true));
  const refreshRecent = () => api<{ searches: RecentSearch[] }>('/api/searches/recent').then(({ searches }) => setRecent(searches)).catch(() => undefined);

  useEffect(() => { void Promise.all([refreshAccount(), refreshRecent()]); }, []);
  useEffect(() => { document.documentElement.lang = locale; }, [locale]);

  async function runSearch(term: string, searchLocale: Locale = locale) {
    const clean = term.trim();
    if (!clean) return;
    setQuery(clean); setLoading(true); setError(false);
    try {
      const result = await api<{ products: Product[] }>(`/api/products/search?q=${encodeURIComponent(clean)}&lang=${searchLocale}`);
      setProducts(result.products);
      await refreshRecent();
    } catch { setError(true); setProducts(null); }
    finally { setLoading(false); }
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
        <label className="locale-control"><span>{messages.language}</span><select value={locale} onChange={(event) => setLocale(event.target.value as Locale)}>{locales.map((item) => <option key={item} value={item}>{localeNames[item]}</option>)}</select></label>
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
          <div className="plan-top"><span className="spark" aria-hidden="true">✣</span><div><p>{messages.plan}</p><strong>{user?.nutritionAccess ? messages.active : messages.inactive}</strong></div><span className={`status-dot ${user?.nutritionAccess ? 'on' : ''}`} /></div>
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
