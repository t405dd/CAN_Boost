/// <reference types="@sveltejs/kit" />
/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />

// Service worker MS3 CAN BC PWA — офлайн + контролируемое обновление.
//
// Поведение:
//   • Установка → precache всего приложения (JS/CSS) + статики + оболочки SPA.
//     После первой загрузки приложение полностью работает БЕЗ интернета.
//   • Навигации (HTML-оболочка) — NETWORK-FIRST: с интернетом всегда свежая оболочка
//     (и свежие хэши JS-бандлов), без интернета — откат в кэш. Это снимает старый баг
//     «залипания» на устаревшей сборке: онлайн контент всегда из сети.
//   • Хэшированные ассеты (build/*) — cache-first (неизменны в рамках version).
//   • Новый SW НЕ активируется молча (нет skipWaiting на install): он ждёт, а UI показывает
//     кнопку «Обновить». По сообщению {type:'SKIP_WAITING'} от страницы — активируется и
//     страница перезагружается (controllerchange в pwa-update). Так пользователь сам решает,
//     когда переехать на новую сборку, и сессия не прерывается внезапно.

import { base, build, files, version, prerendered } from '$service-worker';

const sw = self as unknown as ServiceWorkerGlobalScope;

const CACHE = `can-boost-${version}`;

// Оболочка SPA: корень приложения с учётом base-path (на GitHub Pages — /<repo>/).
const SHELL = `${base}/`;

// Всё, что precache при установке. Дедуп через Set: prerendered уже содержит оболочку (${base}/),
// а Cache.addAll падает с InvalidStateError на дублирующихся запросах → установка SW провалилась бы.
const PRECACHE = [...new Set([...build, ...files, ...prerendered, SHELL])];

sw.addEventListener('install', (event) => {
	// НЕ вызываем skipWaiting — даём новому воркеру встать в waiting. Активирует его явная
	// команда из UI (кнопка «Обновить»). Первый в истории SW (контроллера ещё нет) активируется
	// сам после install, без ожидания.
	event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)));
});

sw.addEventListener('activate', (event) => {
	event.waitUntil(
		(async () => {
			// Удаляем кэши прошлых версий.
			for (const key of await caches.keys()) {
				if (key !== CACHE) await caches.delete(key);
			}
			await sw.clients.claim();
		})()
	);
});

// Команда от страницы: применить ожидающее обновление немедленно.
sw.addEventListener('message', (event) => {
	if ((event.data as { type?: string })?.type === 'SKIP_WAITING') sw.skipWaiting();
});

sw.addEventListener('fetch', (event) => {
	const req = event.request;
	if (req.method !== 'GET') return;

	const url = new URL(req.url);
	if (url.origin !== location.origin) return; // сторонние запросы не трогаем

	event.respondWith(
		(async () => {
			const cache = await caches.open(CACHE);

			// Навигации (HTML-оболочка SPA) — NETWORK-FIRST: онлайн всегда свежая оболочка,
			// офлайн — откат в кэш.
			if (req.mode === 'navigate') {
				try {
					const res = await fetch(req);
					if (res.status === 200) cache.put(SHELL, res.clone());
					return res;
				} catch {
					const shell = (await cache.match(SHELL)) ?? (await cache.match(`${base}/index.html`));
					if (shell) return shell;
					throw new Error('offline: оболочка не закэширована');
				}
			}

			// Хэшированные ассеты приложения (build/*) и статика — cache-first (неизменны в рамках version).
			if (PRECACHE.includes(url.pathname)) {
				const hit = await cache.match(url.pathname);
				if (hit) return hit;
			}

			// Остальное — network-first с откатом в кэш (офлайн).
			try {
				const res = await fetch(req);
				if (res.status === 200) cache.put(req, res.clone());
				return res;
			} catch {
				const hit = await cache.match(req);
				if (hit) return hit;
				throw new Error('offline: ресурс не закэширован');
			}
		})()
	);
});
