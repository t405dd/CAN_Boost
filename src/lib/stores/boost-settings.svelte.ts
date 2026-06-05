// Общий стор настроек бустконтроллера (boost_settings). Грузится централизованно через hydrate()
// на коннекте; страница /boost держит редактируемую копию и пересинхронит её из value по epoch.
// Так Enable/актуатор/сигналы/PID показывают реальное состояние устройства сразу, а не дефолты.

import { readJsonConfig } from '$lib/ble/chunked-transfer';
import { SVC_BOOST, CHR_BOOST_SETTINGS } from '$lib/ble/uuids';
import type { BoostControllerSettings } from '$lib/types/config';

export function defaultBoostSettings(): BoostControllerSettings {
	return {
		enabled: false,
		actuatorType: 0,
		canId: 0x26A,
		canByteOffset: 0,
		canBigEndian: true,
		canSendIntervalMs: 50,
		kp: 2.0, ki: 0.5, kd: 0.3,
		iWindupLimit: 50.0,
		dFilterAlpha: 0.2,
		knockThreshold_deg: 2.0,
		knockReduction_pct: 15.0,
		canTimeoutMs: 500.0,
		rateLimitPctPerSec: 200.0,
		learnEnabled: true,
		learnBias: true,
		learnKi: true,
		learnGains: true,
		learnRate: 0.05,
		learnErrorThreshold: 5.0,
		learnStabilityTimeMs: 2000.0,
		mapSignalParam: 15,    // PARAM_CACHE_SLOT_0 = cache slot 0 (map). База cache-слотов = 15!
		rpmSignalParam: 16,    // PARAM_CACHE_SLOT_1 = cache slot 1 (rpm)
		tpsSignalParam: 18,    // PARAM_CACHE_SLOT_3 = cache slot 3 (tps)
		knockSignalParam: 0,   // PARAM_NONE
		cltSignalParam: 0,     // PARAM_NONE (P7: гейт прогрева выключен, пока не выбран источник)
		corr1AxisParam: 0,
		corr1YAxisParam: 0,
		corr2AxisParam: 0,
		corr2YAxisParam: 0,
		learnKpRate: 0.05,
		learnKdRate: 0.05,
		kpMin: 0.1,
		kpMax: 20.0,
		kdMin: 0.0,
		kdMax: 10.0,
		oscillationThreshold: 3,
		oscillationWindowMs: 1000.0,
		persistentErrorTimeMs: 3000.0,
		persistentErrorMinKpa: 3.0,
		transientGain: 0.5,
		dRpmFilterAlpha: 0.1,
		phaseHysteresis: 1.1,
		learnBiasRate: 0.05,
		learnMinClt: 60,
		learnSaveIntervalMin: 10,
		learnSaveMaxTps: 5
	};
}

// value — последнее прочитанное с устройства; loaded — было ли успешное чтение в этой сессии;
// epoch — ++ при каждой успешной загрузке/сбросе → страница пересинхронит редактируемую копию.
export const boostSettings = $state({
	value: defaultBoostSettings() as BoostControllerSettings,
	loaded: false,
	epoch: 0
});

// Дедуп одновременных вызовов (hydrate + фолбэк страницы) — одно чтение на всех.
let _inFlight: Promise<boolean> | null = null;

/** Прочитать boost_settings с устройства в стор. true — успех. */
export function loadBoostSettings(): Promise<boolean> {
	if (_inFlight) return _inFlight;
	_inFlight = (async () => {
		const s = await readJsonConfig<BoostControllerSettings>(SVC_BOOST, CHR_BOOST_SETTINGS);
		if (s) {
			boostSettings.value = s;
			boostSettings.loaded = true;
			boostSettings.epoch++;
			return true;
		}
		return false;
	})().finally(() => { _inFlight = null; });
	return _inFlight;
}

/** Сброс при разрыве связи. Чистим и in-flight промис, чтобы реконнект не переиспользовал
 *  «зависшее» чтение от оборванного соединения. */
export function resetBoostSettings(): void {
	_inFlight = null;
	boostSettings.value = defaultBoostSettings();
	boostSettings.loaded = false;
	boostSettings.epoch++;
}
