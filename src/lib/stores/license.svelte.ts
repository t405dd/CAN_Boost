// license.svelte.ts — активация устройства BoostPilot.
//
// Схема как на MS3 Touch Dash: ключ = HMAC(секрет, MAC чипа), считает сервер
// (megasquirt.online/api/activate), проверяет и хранит прошивка. Отличие — транспорт:
// у дисплея ключ уезжает по USB-serial с сайта, здесь всё делает PWA по BLE, потому что
// у контроллера нет ни экрана, ни своего сервера (PWA — статика на GitHub Pages).
//
// Порядок: читаем MAC с устройства → просим у сервера ключ (промокод или уже оплаченный
// MAC) → пишем ключ в устройство → перечитываем статус. Ключ ничего не расшифровывает и
// не является секретом сам по себе: он привязан к MAC и проверяется прошивкой.
//
// ГРУППА КОДОВ у BoostPilot своя (product=boostpilot): ключ от дисплея здесь не подойдёт.

import { readJsonConfig } from '$lib/ble/chunked-transfer';
import { writeCharacteristic } from '$lib/ble/connection';
import { SVC_SYSTEM, CHR_LICENSE } from '$lib/ble/uuids';
import type { LicenseStatus } from '$lib/types/config';

/** Сервер выдачи ключей. Продукт задаёт группу кодов (у дисплея — своя). */
const ACTIVATE_URL = 'https://megasquirt.online/api/activate';
const PRODUCT = 'boostpilot';

export type ActivateStep = '' | 'reading' | 'server' | 'writing' | 'verifying';

export const license = $state({
	/** Статус прочитан с устройства (до этого баннеры не показываем — не пугаем по незнанию). */
	loaded: false,
	licensed: false,
	/** Секунд полного функционала осталось (тикает локально, без опроса по BLE). */
	trialLeft: 0,
	trialSec: 60,
	boostAllowed: true,
	mac: '',
	/** Ключ устройства — прошивка отдаёт его только активированному (для поддержки). */
	key: '',
	// --- процесс активации ---
	busy: false,
	step: '' as ActivateStep,
	error: '',
	/** Активация только что прошла — показываем «готово» в UI. */
	justActivated: false
});

let ticker: ReturnType<typeof setInterval> | null = null;
/** Автопопытка «может, этот MAC уже оплачен» делается один раз за подключение. */
let autoTried = false;

function stopTicker() {
	if (ticker) { clearInterval(ticker); ticker = null; }
}

/** Локальный отсчёт триала: устройство прислало остаток один раз, дальше считаем сами —
 *  секундный опрос по BLE ради таймера не нужен (канал занят живыми данными). */
function startTicker() {
	stopTicker();
	if (license.licensed || license.trialLeft <= 0) return;
	ticker = setInterval(() => {
		if (license.licensed) { stopTicker(); return; }
		license.trialLeft = Math.max(0, license.trialLeft - 1);
		if (license.trialLeft === 0) { license.boostAllowed = false; stopTicker(); }
	}, 1000);
}

function applyStatus(s: LicenseStatus) {
	license.licensed = !!s.licensed;
	license.trialLeft = Number.isFinite(s.trialLeft) ? s.trialLeft : 0;
	license.trialSec = s.trialSec ?? 60;
	license.boostAllowed = s.boostAllowed ?? (license.licensed || license.trialLeft > 0);
	license.mac = s.mac ?? '';
	license.key = s.key ?? '';
	license.loaded = true;
	startTicker();
}

/** Прочитать статус активации с устройства. */
export async function loadLicense(): Promise<boolean> {
	try {
		const s = await readJsonConfig<LicenseStatus>(SVC_SYSTEM, CHR_LICENSE);
		// Старая прошивка без характеристики: null. Тогда молчим — устройство не лицензируется,
		// и городить баннер «не активировано» на нём нельзя.
		if (!s || typeof s.licensed !== 'boolean') return false;
		applyStatus(s);
		// Один тихий заход на сервер: MAC мог быть активирован раньше (перепрошивка, сброс NVS,
		// покупка на сайте до подключения). Ошибки не показываем — это фоновая попытка.
		if (!license.licensed && !autoTried) {
			autoTried = true;
			activate(undefined, true).catch(() => {});
		}
		return true;
	} catch (e) {
		console.warn('[License] чтение статуса не удалось:', e);
		return false;
	}
}

export function resetLicense(): void {
	stopTicker();
	autoTried = false;
	license.loaded = false;
	license.licensed = false;
	license.trialLeft = 0;
	license.boostAllowed = true;
	license.mac = '';
	license.key = '';
	license.busy = false;
	license.step = '';
	license.error = '';
	license.justActivated = false;
}

/** Запросить ключ у сервера. promoCode пустой = «проверь, не оплачен ли уже этот MAC». */
async function fetchKey(mac: string, promoCode?: string): Promise<string> {
	const res = await fetch(ACTIVATE_URL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(promoCode ? { mac, promoCode, product: PRODUCT } : { mac, product: PRODUCT })
	});
	if (!res.ok) {
		let msg = `http_${res.status}`;
		try {
			const j = await res.json();
			if (j?.error) msg = String(j.error);
		} catch { /* тело не JSON — оставляем код */ }
		throw new Error(msg);
	}
	const data = (await res.json()) as { key?: string };
	if (!data?.key || data.key.length !== 64) throw new Error('bad_key');
	return data.key;
}

/** Записать ключ в устройство и убедиться, что оно его приняло. */
export async function activateWithKey(keyHex: string): Promise<boolean> {
	const hex = keyHex.trim().toLowerCase();
	if (!/^[0-9a-f]{64}$/.test(hex)) {
		license.error = 'bad_key';
		return false;
	}
	license.step = 'writing';
	const payload = new TextEncoder().encode(`ACTIVATE:${hex}`);
	const sent = await writeCharacteristic(SVC_SYSTEM, CHR_LICENSE, payload);
	if (!sent) { license.error = 'ble_write_failed'; return false; }

	// Прошивка проверяет ключ и пишет NVS не в BLE-колбэке, а в loop() (стек nimble ~4КБ),
	// поэтому результат появляется не мгновенно: перечитываем статус, пока не увидим ACTIVE.
	license.step = 'verifying';
	for (let i = 0; i < 8; i++) {
		await new Promise((r) => setTimeout(r, 400));
		const s = await readJsonConfig<LicenseStatus>(SVC_SYSTEM, CHR_LICENSE);
		if (s && typeof s.licensed === 'boolean') {
			applyStatus(s);
			if (s.licensed) return true;
		}
	}
	license.error = 'device_rejected';
	return false;
}

/**
 * Полный цикл активации. promoCode не задан — проверяем, не активирован ли MAC ранее
 * (тогда сервер отдаёт ключ бесплатно). Возвращает true, если устройство активировано.
 *
 * silent — для фоновой попытки при подключении: её отказ («нужен промокод», нет интернета)
 * это норма, и вываливать пользователю ошибку, которую он не запрашивал, нельзя.
 */
export async function activate(promoCode?: string, silent = false): Promise<boolean> {
	if (license.busy) return false;
	license.busy = true;
	license.error = '';
	license.justActivated = false;
	try {
		// MAC берём с устройства (не из имени в эфире: там BT-MAC, он отличается).
		if (!license.mac) {
			license.step = 'reading';
			const s = await readJsonConfig<LicenseStatus>(SVC_SYSTEM, CHR_LICENSE);
			if (!s?.mac) throw new Error('no_mac');
			applyStatus(s);
		}
		if (license.licensed) return true;

		license.step = 'server';
		const key = await fetchKey(license.mac, promoCode?.trim() || undefined);

		const ok = await activateWithKey(key);
		if (ok) license.justActivated = true;
		else if (silent) license.error = '';   // фоновая попытка молчит и об отказе устройства
		return ok;
	} catch (e) {
		if (!silent) license.error = e instanceof Error ? e.message : String(e);
		return false;
	} finally {
		license.busy = false;
		license.step = '';
	}
}
