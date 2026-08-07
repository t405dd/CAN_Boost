// Глобальный стор обновления прошивки. Живёт вне страниц СПЕЦИАЛЬНО: обновление запускается
// из баннера в шапке и должно продолжаться, пока пользователь листает вкладки — размонтирование
// компонента не имеет права оборвать заливку образа.
//
// Версию устройства отдельным чтением НЕ запрашиваем: её уже приносит гидрация в
// deviceState.info (а на /system она ещё и обновляется по таймеру). Дублирующее чтение только
// отбирало бы очередь GATT.

import { base } from '$app/paths';
import { fetchManifest, compareVersions, runOta, type FirmwareManifest, type OtaPhase } from '$lib/ota/firmware-update';
import { deviceState } from './device-state.svelte';

/** Сколько ждём перед перезагрузкой страницы, чтобы пользователь успел прочитать «готово». */
const RELOAD_DELAY_MS = 2500;

export const fwUpdate = $state({
	manifest: null as FirmwareManifest | null,
	manifestChecked: false,
	phase: 'idle' as OtaPhase,
	pct: 0,
	speedKbs: 0,
	etaSec: 0,
	error: '',
	log: [] as string[],
	/** true после успеха — страница вот-вот перезагрузится, кнопки прятать. */
	reloading: false
});

/** Идёт обновление (любая фаза, кроме покоя/финала). */
export function fwBusy(): boolean {
	return fwUpdate.phase !== 'idle' && fwUpdate.phase !== 'error';
}

/** Версия прошивки на устройстве, или null (не подключены / ещё не прочитали). */
export function fwDeviceVersion(): string | null {
	return deviceState.info?.version ?? null;
}

/** Железо умеет OTA. Старая однораздельная таблица → false (нужен переход по USB). */
export function fwOtaSupported(): boolean {
	return deviceState.info?.otaSupported !== false;
}

/** Есть выложенная версия новее той, что на устройстве. */
export function fwHasUpdate(): boolean {
	const device = fwDeviceVersion();
	const avail = fwUpdate.manifest?.version;
	if (!device || !avail) return false;
	return compareVersions(avail, device) > 0;
}

/** Прочитать манифест с origin приложения. Файл статический — одного раза за сессию хватает;
 *  force=true для кнопки «проверить» вручную. Отсутствие манифеста — норма (артефакт не выложен),
 *  тогда остаётся путь «выбрать файл .bin» на /system. */
export async function checkFwManifest(force = false): Promise<void> {
	if (fwUpdate.manifestChecked && !force) return;
	fwUpdate.manifestChecked = true;
	fwUpdate.manifest = await fetchManifest(base);
}

function reset() {
	fwUpdate.pct = 0;
	fwUpdate.speedKbs = 0;
	fwUpdate.etaSec = 0;
	fwUpdate.error = '';
	fwUpdate.log = [];
	fwUpdate.reloading = false;
}

/**
 * Запуск обновления. Без аргумента шьём выложенный образ по манифесту; с `file` — выбранный
 * пользователем .bin.
 *
 * После успеха устройство перезагружается САМО (прошивка коммитит и рестартует, см. ota_update.h),
 * а мы перезагружаем страницу: так гарантированно исчезают все стора со старой версией прошивки,
 * а заодно подхватывается ожидающее обновление самой PWA.
 *
 * ⚠️ Перезагрузка страницы теряет выбранное BLE-устройство: Web Bluetooth требует жеста
 * пользователя на requestDevice, поэтому после неё нужно один раз нажать «Подключить».
 */
export async function startFwUpdate(file?: ArrayBuffer): Promise<void> {
	if (fwBusy()) return;   // защита от двойного тапа по баннеру и от гонки баннер/карточка
	if (!file && !fwUpdate.manifest) return;
	reset();
	fwUpdate.phase = 'preparing';
	try {
		await runOta({
			file,
			manifest: file ? undefined : fwUpdate.manifest!,
			basePath: base,
			onState: (p) => {
				if (p.phase !== undefined) fwUpdate.phase = p.phase;
				if (p.pct !== undefined) fwUpdate.pct = p.pct;
				if (p.speedKbs !== undefined) fwUpdate.speedKbs = p.speedKbs;
				if (p.etaSec !== undefined) fwUpdate.etaSec = p.etaSec;
			},
			onLog: (line) => {
				fwUpdate.log = [...fwUpdate.log, line];
			}
		});
		fwUpdate.phase = 'done';
		fwUpdate.pct = 100;
		fwUpdate.reloading = true;
		setTimeout(() => location.reload(), RELOAD_DELAY_MS);
	} catch (e) {
		fwUpdate.phase = 'error';
		fwUpdate.error = e instanceof Error ? e.message : String(e);
		fwUpdate.log = [...fwUpdate.log, `✗ ${fwUpdate.error}`];
	}
}

/** Сброс после неудачи — вернуть баннер/кнопки в исходное состояние. */
export function dismissFwError(): void {
	if (fwUpdate.phase !== 'error') return;
	fwUpdate.phase = 'idle';
	reset();
}
