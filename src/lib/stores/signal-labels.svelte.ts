// Reactive store mapping cache slot indices to human-readable signal labels.
// Loads CAN Receive config from BLE to build the mapping.

import { readJsonConfig } from '$lib/ble/chunked-transfer';
import { SVC_CAN_CONFIG, CHR_CAN_RECEIVE } from '$lib/ble/uuids';
import { PARAM_CACHE_SLOT_START } from '$lib/ble/protocol';
import { setCacheLabelsFromConfig } from '$lib/stores/live-data.svelte';
import { normalizeTempUnit } from '$lib/utils/param-mapping';
import { localInputsStore, loadLocalInputs } from '$lib/stores/local-inputs.svelte';
import type { CanMessageConfig } from '$lib/types/config';

export interface SignalLabel {
	label: string;
	unit: string;
}

// Cache slot index → {label, unit}
export const signalLabels = $state<Record<number, SignalLabel>>({});

let loaded = false;

/** Load CAN Receive config and build cache slot → label mapping.
 *  Firmware assigns cache slots sequentially to enabled signals.
 *  CHR_CAN_RECEIVE — большой chunked-read (на Android несколько секунд). Грузим один раз за сессию:
 *  повторные вызовы с разных страниц/эффектов — no-op (force=false), чтобы не вставать в общую
 *  последовательную BLE-очередь вторым тяжёлым чтением и не тормозить мелкие чтения (карты буста).
 *  force=true — явное обновление после правки CAN Receive (слоты кэша перемапились). */
export async function loadSignalLabels(force = false): Promise<void> {
	if (loaded && !force) return;
	try {
		const config = await readJsonConfig<CanMessageConfig[]>(SVC_CAN_CONFIG, CHR_CAN_RECEIVE);
		if (!config || config.length === 0) return;

		let slotIndex = 0;
		const newLabels: Record<number, SignalLabel> = {};

		for (const msg of config) {
			if (!msg.isEnabled || !msg.signals) continue;
			for (const sig of msg.signals) {
				// Слот-индекс ДОЛЖЕН совпадать с прошивкой (init_utils): сигнал без имени
				// слот НЕ занимает. Иначе подписи слотов «съезжают» и оси/резолверы графика
				// (knk/afr/clt/mat/ign) мапятся на чужой сигнал. Та же логика в buildCacheSlotLabels.
				if (!sig.isEnabled || !sig.signalName) continue;
				newLabels[slotIndex] = {
					label: sig.userLabel || sig.signalName,
					unit: normalizeTempUnit(sig.userUnit || '', sig.requiresFtoC)
				};
				slotIndex++;
			}
		}

		// Локальные входы занимают слоты ПОСЛЕ CAN-сигналов (раскладка прошивки, init_utils).
		// Конфиг входов мелкий — читаем (in-flight дедуп внутри), без него подписи локальных
		// слотов остались бы "cacheN".
		await loadLocalInputs();
		if (localInputsStore.loaded) {
			for (const li of localInputsStore.inputs) {
				if (!li.en || !li.name) continue;
				if (slotIndex >= 40) break;
				newLabels[slotIndex] = { label: li.label || li.name, unit: li.unit || '' };
				slotIndex++;
			}
		}

		// Update reactive state
		for (const key of Object.keys(signalLabels)) {
			delete signalLabels[Number(key)];
		}
		Object.assign(signalLabels, newLabels);
		loaded = true;

		// Тот же конфиг — в стор live-данных, чтобы и живые значения показывались
		// с понятными именами (RPM/MAP/…), а не CACHE0.
		setCacheLabelsFromConfig(config, localInputsStore.loaded ? localInputsStore.inputs : undefined);

		console.log(`[SignalLabels] Loaded ${slotIndex} cache slot labels`);
	} catch (e) {
		console.warn('[SignalLabels] Failed to load:', e);
	}
}

/** Get a human-readable display name for a cache slot.
 *  Returns "MAP (kPa)" format or falls back to "cache_0". */
export function getCacheSlotDisplayName(slotIndex: number): string {
	const info = signalLabels[slotIndex];
	if (!info) return `cache_${slotIndex}`;
	if (info.unit) return `${info.label} (${info.unit})`;
	return info.label;
}

/** Short name for a cache slot (label only, no units).
 *  Returns "MAP" or falls back to "cache_0". */
export function getCacheSlotShortName(slotIndex: number): string {
	const info = signalLabels[slotIndex];
	if (!info) return `cache_${slotIndex}`;
	return info.label;
}

/** Get display name for any PWA param name.
 *  For cache_N params, uses loaded labels. Others pass through. */
export function getParamDisplayName(pwaName: string): string {
	const match = pwaName.match(/^cache_(\d+)$/);
	if (match) {
		return getCacheSlotDisplayName(parseInt(match[1]));
	}
	return pwaName;
}

/** Short name for any PWA param (label only, no units).
 *  For cache_N params returns just the label. Others pass through. */
export function getParamShortName(pwaName: string): string {
	const match = pwaName.match(/^cache_(\d+)$/);
	if (match) {
		return getCacheSlotShortName(parseInt(match[1]));
	}
	return pwaName;
}

/** Short name for a param enum value (for boost signal dropdowns).
 *  Cache slots (enum >= PARAM_CACHE_SLOT_START = 21) use loaded labels. */
export function getEnumParamShortName(enumVal: number): string {
	if (enumVal >= PARAM_CACHE_SLOT_START) {
		return getCacheSlotShortName(enumVal - PARAM_CACHE_SLOT_START);
	}
	// For built-in params, return firmware name
	return '';
}

export function isLabelsLoaded(): boolean {
	return loaded;
}

/** Сброс при разрыве связи: следующее подключение перечитает подписи (иначе guard в
 *  loadSignalLabels не дал бы перезагрузиться на реконнекте). */
export function resetSignalLabels(): void {
	loaded = false;
}
