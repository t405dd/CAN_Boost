// Стор конфига локальных входов (ADC/импульсные). Нужен двум потребителям:
// странице «Локальные входы» (редактирование) и сборке подписей cache-слотов
// (локальные входы занимают слоты ПОСЛЕ CAN-сигналов — как в прошивке).

import { readJsonConfig, writeJsonConfig } from '$lib/ble/chunked-transfer';
import { SVC_CAN_CONFIG, CHR_LOCAL_INPUTS } from '$lib/ble/uuids';
import type { LocalInputConfig } from '$lib/types/config';

export const MAX_LOCAL_INPUTS = 6;

export function defaultLocalInput(): LocalInputConfig {
	return {
		en: false, type: 0, pin: -1, name: '', label: '', unit: '', prec: 1, role: 0,
		div: 0.667, v1: 0.5, val1: 0, v2: 4.5, val2: 100, vmin: 0.2, vmax: 4.9,
		mult: 30, minUs: 200, toMs: 1500
	};
}

export const localInputsStore = $state({
	inputs: [] as LocalInputConfig[],
	loaded: false,
	epoch: 0   // ++ при каждом успешном чтении (страница клонирует в редактируемую копию)
});

let inflight: Promise<boolean> | null = null;

/** Прочитать конфиг входов с устройства (с live-полями volts/value). */
export async function loadLocalInputs(): Promise<boolean> {
	if (inflight) return inflight;
	inflight = (async () => {
		try {
			const data = await readJsonConfig<{ inputs: LocalInputConfig[] }>(SVC_CAN_CONFIG, CHR_LOCAL_INPUTS);
			if (!data || !Array.isArray(data.inputs)) return false;
			const filled = data.inputs.slice(0, MAX_LOCAL_INPUTS);
			while (filled.length < MAX_LOCAL_INPUTS) filled.push(defaultLocalInput());
			localInputsStore.inputs = filled;
			localInputsStore.loaded = true;
			localInputsStore.epoch++;
			return true;
		} catch (e) {
			console.warn('[LocalInputs] load failed:', e);
			return false;
		} finally {
			inflight = null;
		}
	})();
	return inflight;
}

/** Записать конфиг входов на устройство (прошивка перераскладывает кэш и железо). */
export async function saveLocalInputs(inputs: LocalInputConfig[]): Promise<boolean> {
	// live-поля не отправляем
	const clean = inputs.map(({ liveVolts, liveValue, slot, ...rest }) => rest);
	const ok = await writeJsonConfig(SVC_CAN_CONFIG, CHR_LOCAL_INPUTS, { inputs: clean });
	if (ok) {
		localInputsStore.inputs = inputs.map(i => ({ ...i }));
		localInputsStore.loaded = true;
	}
	return ok;
}

export function resetLocalInputs(): void {
	localInputsStore.loaded = false;
	localInputsStore.inputs = [];
}
