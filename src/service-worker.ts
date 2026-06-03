/// <reference types="@sveltejs/kit" />
/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />

// Service worker для офлайн-работы MS3 CAN BC PWA.
// Предкэширует всё приложение (JS/CSS) + статику (manifest, иконки, predefined_signals.json)
// при установке. После первой загрузки приложение полностью работает без интернета.
// SvelteKit автоматически регистрирует этот файл в продакшен-сборке.

import { base, build, files, version, prerendered } from '$service-worker';

const sw = self as unknown as ServiceWorkerGlobalScope;

const CACHE = `can-boost-${version}`;

// Оболочка SPA: корень приложения с учётом base-path (на GitHub Pages — /<repo>/).
const SHELL = `${base}/`;

// Всё, что precache при установке: код приложения + статика + предрендеренные страницы + оболочка SPA.
// Дедуп через Set: prerendered уже содержит оболочку (${base}/), а Cache.addAll падает с
// InvalidStateError на дублирующихся запросах → установка SW проваливалась, новый SW не активировался
// (браузер продолжал отдавать старую сборку).
const PRECACHE = [...new Set([...build, ...files, ...prerendered, SHELL])];

sw.addEventListener('install', (event) => {
	event.waitUntil(
		caches.open(CACHE)
			.then((cache) => cache.addAll(PRECACHE))
			.then(() => sw.skipWaiting())
	);
});

sw.addEventListener('activate', (event) => {
	event.waitUntil(
		(async () => {
			// Удаляем кэши прошлых версий
			for (const key of await caches.keys()) {
				if (key !== CACHE) await caches.delete(key);
			}
			await sw.clients.claim();
		})()
	);
});

sw.addEventListener('fetch', (event) => {
	const req = event.request;
	if (req.method !== 'GET') return;

	const url = new URL(req.url);
	if (url.origin !== location.origin) return; // не трогаем сторонние запросы

	event.respondWith(
		(async () => {
			const cache = await caches.open(CACHE);

			// Статические ассеты приложения — cache-first (они неизменны в рамках version)
			if (PRECACHE.includes(url.pathname)) {
				const hit = await cache.match(url.pathname);
				if (hit) return hit;
			}

			// Остальное — network-first с откатом в кэш (офлайн)
			try {
				const res = await fetch(req);
				if (res.status === 200) cache.put(req, res.clone());
				return res;
			} catch {
				const hit = await cache.match(req);
				if (hit) return hit;
				// Навигация (SPA) офлайн → отдаём кэшированную оболочку
				if (req.mode === 'navigate') {
					const shell = (await cache.match(SHELL)) ?? (await cache.match(`${base}/index.html`));
					if (shell) return shell;
				}
				throw new Error('offline: ресурс не закэширован');
			}
		})()
	);
});
