// Общий (сквозной) стор карт буста: шарится между шапкой (+layout) и страницей /boost,
// чтобы переключать активную карту с любой страницы. Состояние держим здесь, тяжёлый
// switch/copy выполняется на устройстве отложенно — ждём busy=false, затем бампаем
// reloadEpoch (страница /boost по нему перечитывает открытую таблицу edit-слота).

import { readJsonConfig, writeJsonConfig } from '$lib/ble/chunked-transfer';
import { SVC_BOOST, CHR_BOOST_MAPS } from '$lib/ble/uuids';
import type { BoostMapMeta, BoostMapsState } from '$lib/types/config';

export const NUM_BOOST_MAPS = 4;

function defaultMapsMeta(): BoostMapMeta[] {
	return Array.from({ length: NUM_BOOST_MAPS }, (_, i) => ({
		name: `Map ${i + 1}`,
		overboostLimit_kPa: 250.0
	}));
}

export const boostMaps = $state({
	mapsMeta: defaultMapsMeta(),
	activeMap: 0,
	editMap: 0,
	busy: false,        // устройство ещё выполняет отложенный switch/copy
	switching: false,   // UI: операция переключения/копирования/сохранения в полёте
	loaded: false,      // прочитали ли состояние карт с устройства в этой сессии
	/** Бампается после завершения switch/copy → страница /boost перечитывает таблицы edit-слота. */
	reloadEpoch: 0
});

/** Прочитать состояние карт с устройства. Возвращает true, если устройство ещё busy (switch/copy идёт). */
export async function loadBoostMaps(): Promise<boolean> {
	const m = await readJsonConfig<BoostMapsState>(SVC_BOOST, CHR_BOOST_MAPS);
	if (m && Array.isArray(m.maps) && m.maps.length > 0) {
		boostMaps.mapsMeta = m.maps;
		boostMaps.activeMap = m.activeMap ?? 0;
		boostMaps.editMap = m.editMap ?? boostMaps.activeMap;
		boostMaps.busy = !!m.busy;
		boostMaps.loaded = true;
		return boostMaps.busy;
	}
	return false;
}

/** Загрузить карты с устройства с несколькими попытками. На Android первое чтение мелкого
 *  конфига иногда теряется (гонка startNotifications) — повторяем, пока не загрузится. */
export async function ensureBoostMapsLoaded(): Promise<void> {
	for (let i = 0; i < 4 && !boostMaps.loaded; i++) {
		await loadBoostMaps();
		if (boostMaps.loaded) return;
		await new Promise((r) => setTimeout(r, 300 * (i + 1)));
	}
}

// Дождаться завершения отложенного switch/copy на устройстве (busy=false).
async function waitMapsReady(): Promise<void> {
	for (let i = 0; i < 40; i++) {           // до ~6с страховки
		const busy = await loadBoostMaps();
		if (!busy) break;
		await new Promise((r) => setTimeout(r, 150));
	}
}

/** Сделать карту n активной (одно нажатие): пишем, ждём готовность, сигналим перечитку таблиц. */
export async function setActiveBoostMap(n: number): Promise<void> {
	if (n < 0 || n >= NUM_BOOST_MAPS) return;
	if (boostMaps.switching) return;
	if (n === boostMaps.activeMap && n === boostMaps.editMap) return;
	boostMaps.switching = true;
	try {
		const ok = await writeJsonConfig(SVC_BOOST, CHR_BOOST_MAPS, { activeMap: n });
		if (ok) {
			// Оптимистично двигаем подсветку сразу — на Android подтверждающее чтение может
			// запоздать или потеряться, но запись на устройство уже прошла.
			boostMaps.activeMap = n;
			boostMaps.editMap = n;
			boostMaps.loaded = true;
			await waitMapsReady();
			boostMaps.reloadEpoch++;   // /boost перечитает открытую таблицу нового слота
		}
	} finally {
		boostMaps.switching = false;
	}
}

/** Сохранить мету всех карт (имена + per-map overboost). */
export async function saveBoostMapsMeta(): Promise<boolean> {
	boostMaps.switching = true;
	try {
		return await writeJsonConfig(SVC_BOOST, CHR_BOOST_MAPS, { maps: boostMaps.mapsMeta });
	} finally {
		boostMaps.switching = false;
	}
}

/** Заполнить текущий edit-слот из слота src (target+corr+overboost; имя приёмника не трогаем). */
export async function copyBoostMapFrom(src: number): Promise<boolean> {
	boostMaps.switching = true;
	try {
		const ok = await writeJsonConfig(SVC_BOOST, CHR_BOOST_MAPS, {
			copy: { from: src, to: boostMaps.editMap }
		});
		if (ok) {
			await waitMapsReady();
			boostMaps.reloadEpoch++;
		}
		return ok;
	} finally {
		boostMaps.switching = false;
	}
}

/** Сброс при разрыве связи. */
export function resetBoostMaps(): void {
	boostMaps.mapsMeta = defaultMapsMeta();
	boostMaps.activeMap = 0;
	boostMaps.editMap = 0;
	boostMaps.busy = false;
	boostMaps.switching = false;
	boostMaps.loaded = false;
}
