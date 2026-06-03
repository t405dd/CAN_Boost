// Единый порядок загрузки конфигов при подключении. BLE-очередь строго последовательная (один
// GATT-op за раз), поэтому грузим осознанно, мелкое/критичное — первым:
//   boost_maps (сквозной селектор) → boost_settings → co1_settings → signal labels.
// Большой chunked-read подписей (can_receive) идёт ПОСЛЕДНИМ, чтобы не блокировать видимые тумблеры.
// Мелкие конфиги читаем с ретраем (chunked на Android может сорваться с первой попытки).

import { ensureBoostMapsLoaded, resetBoostMaps } from './boost-maps.svelte';
import { loadBoostSettings, resetBoostSettings } from './boost-settings.svelte';
import { loadCo1Config, resetCo1Config } from './co1-settings.svelte';
import { loadSignalLabels, resetSignalLabels } from './signal-labels.svelte';

async function loadWithRetry(fn: () => Promise<boolean>, attempts = 3): Promise<void> {
	for (let i = 0; i < attempts; i++) {
		if (await fn()) return;
		await new Promise((r) => setTimeout(r, 300 * (i + 1)));
	}
}

/** Выполнить шаг гидрации изолированно: сбой/исключение одного чтения (на Android `readValue`
 *  может отклониться — «GATT busy» и т.п.) НЕ должен отменять остальные шаги. Без этого один
 *  throw в ensureBoostMapsLoaded ронял всю цепочку → ни boost_settings, ни co1, ни подписи не
 *  читались (симптом «на телефоне ничего не грузится, а на ПК всё ок»). */
async function step(name: string, fn: () => Promise<unknown>): Promise<void> {
	try {
		await fn();
	} catch (e) {
		console.error(`[hydrate] step '${name}' failed (продолжаем остальные):`, e);
	}
}

/** Прочитать с устройства все «лёгкие» конфиги в правильном порядке. Вызывается на КАЖДЫЙ
 *  'connected' (в т.ч. реконнект) — без guard'а _running, иначе залипший флаг блокировал бы чтения
 *  на всех последующих подключениях (авто-реконнект идёт через статус 'reconnecting', а не
 *  'disconnected', поэтому сброс не срабатывал). Дублирующиеся чтения гасит in-flight дедуп в
 *  загрузчиках. Тяжёлые таблицы грузятся лениво по раскрытию секций на страницах. */
export async function hydrateOnConnect(): Promise<void> {
	console.log('[hydrate] старт чтения конфигов с устройства');
	await step('boost_maps', ensureBoostMapsLoaded);        // мелкое прямое чтение — селектор карт во всех страницах
	await step('boost_settings', () => loadWithRetry(loadBoostSettings)); // Enable/актуатор/сигналы/PID (/boost)
	await step('co1_settings', () => loadWithRetry(loadCo1Config));       // настройки CO1 (/can-transmit)
	await step('signal_labels', () => loadSignalLabels());  // большой chunked can_receive — ПОСЛЕДНИМ
	console.log('[hydrate] чтение конфигов завершено');
}

/** Сброс всех сторов при разрыве связи. */
export function resetHydration(): void {
	resetBoostMaps();
	resetBoostSettings();
	resetCo1Config();
	resetSignalLabels();
}
