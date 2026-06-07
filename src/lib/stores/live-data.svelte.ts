// Reactive live data store using Svelte 5 runes.
// Receives binary notifications from ESP32 and updates parameter values.

import { onLiveData } from '$lib/ble/connection';
import { decodeLiveDataPacket, isUserParam, getUserParamIndex, PARAM_NAMES, PARAM_CACHE_SLOT_START, buildCacheSlotLabels } from '$lib/ble/protocol';
import { BOOST_PID_DISPLAY_SCALE } from '$lib/utils/boost-pid-scale';
import type { CanMessageConfig } from '$lib/types/config';

export interface ParamValue {
	name: string;
	value: number;
	paramType: number;
	lastUpdate: number;
}

// Use plain object instead of Map for reliable Svelte 5 reactivity
export const liveData = $state({
	params: {} as Record<string, ParamValue>,
	sequence: 0,
	packetsReceived: 0,
	lastPacketTime: 0
});

// Cache slot labels: index → user label (loaded from localStorage or updated by can-receive page)
let _cacheLabels: string[] = new Array(40).fill('');

/** Update cache slot labels from a loaded CAN receive config */
export function setCacheLabelsFromConfig(messages: CanMessageConfig[]) {
	_cacheLabels = buildCacheSlotLabels(messages);
	if (typeof window !== 'undefined') {
		localStorage.setItem('can_rx_cache_labels', JSON.stringify(_cacheLabels));
	}
}

function loadCacheLabelsFromStorage() {
	if (typeof window === 'undefined') return;
	try {
		const stored = localStorage.getItem('can_rx_cache_labels');
		if (stored) _cacheLabels = JSON.parse(stored);
	} catch {}
}

function getParamName(paramType: number): string {
	if (isUserParam(paramType)) return `user_${getUserParamIndex(paramType)}`;
	// Cache slot: use stored label if available
	if (paramType >= PARAM_CACHE_SLOT_START && paramType < PARAM_CACHE_SLOT_START + 40) {
		const slotIdx = paramType - PARAM_CACHE_SLOT_START;
		const label = _cacheLabels[slotIdx];
		if (label) return label;
	}
	return PARAM_NAMES[paramType] ?? `param_${paramType}`;
}

// Initialize live data listener
if (typeof window !== 'undefined') {
	loadCacheLabelsFromStorage();
	let logCounter = 0;

	onLiveData((dataView: DataView) => {
		const packet = decodeLiveDataPacket(dataView);
		const now = Date.now();
		const dt = liveData.lastPacketTime > 0 ? now - liveData.lastPacketTime : 0;

		liveData.sequence = packet.sequence;
		liveData.packetsReceived++;
		liveData.lastPacketTime = now;

		// Debug: log first 5 packets and then every 30th, with timestamp
		if (logCounter < 5 || logCounter % 30 === 0) {
			const ts = new Date().toISOString().substring(11, 23); // HH:MM:SS.mmm
			console.log(`[LiveData ${ts}] pkt #${logCounter} seq=${packet.sequence} entries=${packet.entries.length} dt=${dt}ms`);
		}
		logCounter++;

		for (const entry of packet.entries) {
			// BST_KP(9)/BST_KD(10) — эффективные коэффициенты регулятора; приводим к display-масштабу
			// (×100), чтобы лог/график совпадали с таблицами Kp/Kd. P/I/D-вклады (6/7/8) — это %duty,
			// зонные множители (11/12) — безразмерные, их НЕ трогаем.
			const value =
				entry.paramType === 9 || entry.paramType === 10
					? entry.value * BOOST_PID_DISPLAY_SCALE
					: entry.value;
			liveData.params[entry.paramType] = {
				name: getParamName(entry.paramType),
				value,
				paramType: entry.paramType,
				lastUpdate: now
			};
		}
	});
}

/** Get a sorted array of all current parameter values */
export function getParamList(): ParamValue[] {
	return Object.values(liveData.params).sort((a, b) => a.paramType - b.paramType);
}
