// Обновление PWA под контролем пользователя (Svelte 5 runes).
//
// SvelteKit сам регистрирует service-worker.js в проде. Здесь мы НАБЛЮДАЕМ за регистрацией:
// показываем, что готова новая версия (waiting-воркер), умеем проверить обновление по кнопке
// и применить его (skipWaiting → controllerchange → reload). SW намеренно не делает skipWaiting
// сам — переезд на новую сборку инициирует пользователь.

import { browser } from '$app/environment';

export const pwaUpdate = $state({
	supported: false,
	updateReady: false, // установлена новая версия и ждёт активации
	checking: false      // идёт ручная проверка обновления
});

let registration: ServiceWorkerRegistration | null = null;
let reloading = false;

function markIfWaiting(reg: ServiceWorkerRegistration): void {
	// waiting-воркер при наличии активного контроллера = именно ОБНОВЛЕНИЕ (не первая установка).
	if (reg.waiting && navigator.serviceWorker.controller) pwaUpdate.updateReady = true;
}

function watchInstalling(reg: ServiceWorkerRegistration): void {
	const nw = reg.installing;
	if (!nw) return;
	nw.addEventListener('statechange', () => {
		if (nw.state === 'installed' && navigator.serviceWorker.controller) {
			pwaUpdate.updateReady = true; // новая версия скачана и ждёт
		}
	});
}

if (browser && 'serviceWorker' in navigator) {
	pwaUpdate.supported = true;

	navigator.serviceWorker.ready
		.then((reg) => {
			registration = reg;
			markIfWaiting(reg);
			reg.addEventListener('updatefound', () => watchInstalling(reg));
		})
		.catch(() => { /* нет SW (dev/неподдерживается) — кнопка просто перезагрузит */ });

	// Новый воркер стал контроллером (после applyUpdate) → перезагружаем страницу один раз.
	navigator.serviceWorker.addEventListener('controllerchange', () => {
		if (reloading) return;
		reloading = true;
		location.reload();
	});

	// Авто-проверка обновления при возврате на вкладку (онлайн — чтобы баннер появлялся сам).
	document.addEventListener('visibilitychange', () => {
		if (document.visibilityState === 'visible') void registration?.update().catch(() => {});
	});
}

async function getReg(): Promise<ServiceWorkerRegistration | null> {
	if (registration) return registration;
	if (!browser || !('serviceWorker' in navigator)) return null;
	registration = (await navigator.serviceWorker.getRegistration()) ?? null;
	return registration;
}

/** Проверить обновление в сети. 'ready' — новая версия готова к применению; 'fresh' — уже последняя. */
export async function checkForUpdate(): Promise<'ready' | 'fresh' | 'unsupported'> {
	const reg = await getReg();
	if (!reg) return 'unsupported';
	pwaUpdate.checking = true;
	try {
		await reg.update();
		// update() может вернуться до завершения install — дождёмся, если воркер ставится.
		const installing = reg.installing;
		if (installing) {
			await new Promise<void>((resolve) => {
				const done = () => {
					if (['installed', 'activated', 'redundant'].includes(installing.state)) resolve();
				};
				installing.addEventListener('statechange', done);
				done();
			});
		}
		markIfWaiting(reg);
		return pwaUpdate.updateReady ? 'ready' : 'fresh';
	} finally {
		pwaUpdate.checking = false;
	}
}

/** Применить готовое обновление: активировать waiting-воркер и перезагрузиться. */
export function applyUpdate(): void {
	const w = registration?.waiting;
	if (w) {
		w.postMessage({ type: 'SKIP_WAITING' }); // controllerchange → reload
	} else {
		// Нет ожидающего воркера — просто перезагрузим (онлайн навигация network-first отдаст свежее).
		location.reload();
	}
}
