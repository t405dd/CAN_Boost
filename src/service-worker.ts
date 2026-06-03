/// <reference types="@sveltejs/kit" />
/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />

// NETWORK-ONLY service worker. Приложение остаётся устанавливаемым PWA (манифест + этот SW
// с fetch-обработчиком), НО НИЧЕГО НЕ КЭШИРУЕТ — каждый запрос идёт прямо в сеть.
//
// Почему так: офлайн-precache залипал на Android — установленный PWA крутил старый
// закэшированный бандл (самообновление SW не доезжало) → приложение работало на устаревшем
// коде. Для BLE-тюнера офлайн не нужен (телефон рядом с устройством), а гарантия «всегда
// свежий код» важнее. Залипнуть теперь не на чем: кэша нет.
//
// При активации этот воркер дополнительно УДАЛЯЕТ ВСЕ старые кэши — то есть любое устройство,
// которое подтянет этот SW при проверке обновления, очистит залипший бандл предыдущих версий.

const sw = self as unknown as ServiceWorkerGlobalScope;

sw.addEventListener('install', () => {
	// Сразу становимся активным, не ждём закрытия старых вкладок.
	sw.skipWaiting();
});

sw.addEventListener('activate', (event) => {
	event.waitUntil(
		(async () => {
			// Сносим ВСЕ кэши (в т.ч. старые can-boost-* со stale-бандлами).
			for (const key of await caches.keys()) {
				await caches.delete(key);
			}
			await sw.clients.claim();
		})()
	);
});

sw.addEventListener('fetch', (event) => {
	// Только GET; остальное (BLE и т.п. — не сеть, но на всякий) не трогаем.
	if (event.request.method !== 'GET') return;
	// NETWORK-ONLY: всегда из сети, ничего не кэшируем. fetch-обработчик присутствует →
	// Chrome считает приложение устанавливаемым PWA.
	event.respondWith(fetch(event.request));
});
