// Общий стор настроек CO1-выхода (can_out_settings). Грузится централизованно через hydrate() на
// коннекте; страница /can-transmit держит редактируемую копию и пересинхронит её из value по epoch.

import { readJsonConfig } from '$lib/ble/chunked-transfer';
import { SVC_CAN_CONFIG, CHR_CAN_OUT_SETTINGS } from '$lib/ble/uuids';
import type { Co1Settings } from '$lib/types/config';

export function defaultCo1Settings(): Co1Settings {
	return { canId: 0x269, canByteOffset: 0, canBigEndian: true, canSendIntervalMs: 50 };
}

export const co1Config = $state({
	value: defaultCo1Settings() as Co1Settings,
	loaded: false,
	epoch: 0
});

let _inFlight: Promise<boolean> | null = null;

/** Прочитать can_out_settings с устройства в стор. true — успех. */
export function loadCo1Config(): Promise<boolean> {
	if (_inFlight) return _inFlight;
	_inFlight = (async () => {
		const s = await readJsonConfig<Co1Settings>(SVC_CAN_CONFIG, CHR_CAN_OUT_SETTINGS);
		if (s) {
			co1Config.value = s;
			co1Config.loaded = true;
			co1Config.epoch++;
			return true;
		}
		return false;
	})().finally(() => { _inFlight = null; });
	return _inFlight;
}

/** Сброс при разрыве связи (чистим in-flight промис — см. boost-settings). */
export function resetCo1Config(): void {
	_inFlight = null;
	co1Config.value = defaultCo1Settings();
	co1Config.loaded = false;
	co1Config.epoch++;
}
