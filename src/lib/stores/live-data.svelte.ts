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

// Реестр «когда-либо виденных» параметров — переживает перезагрузку (localStorage), чтобы на
// выключённом авто (нет live-данных) плашки всё равно были видны и их можно было настроить.
export interface KnownParam {
	paramType: number;
	name: string;
	lastValue: number;
}
const KNOWN_KEY = 'dash_known_params_v1';
export const knownParams = $state<Record<number, KnownParam>>({});

function loadKnownParams() {
	if (typeof window === 'undefined') return;
	try {
		const raw = localStorage.getItem(KNOWN_KEY);
		if (!raw) return;
		const obj = JSON.parse(raw) as Record<string, KnownParam>;
		for (const k of Object.keys(obj)) {
			const v = obj[k];
			if (v && typeof v.paramType === 'number') knownParams[Number(k)] = v;
		}
	} catch {
		/* битый json — игнор */
	}
}

let _knownSaveTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleSaveKnownParams() {
	if (_knownSaveTimer || typeof window === 'undefined') return;
	// Дебаунс: пишем не чаще раза в 2с, иначе localStorage дёргается на каждом пакете.
	_knownSaveTimer = setTimeout(() => {
		_knownSaveTimer = null;
		try {
			localStorage.setItem(KNOWN_KEY, JSON.stringify(knownParams));
		} catch {
			/* квота/приватный режим */
		}
	}, 2000);
}

/** Убрать плашку из реестра (очистка случайно «прилетевших» параметров).
 *  Появится снова, если придёт с авто. */
export function forgetKnownParam(paramType: number) {
	delete knownParams[paramType];
	if (typeof window !== 'undefined') {
		try {
			localStorage.setItem(KNOWN_KEY, JSON.stringify(knownParams));
		} catch {
			/* ignore */
		}
	}
}

// Cache slot labels: index → user label (loaded from localStorage or updated by can-receive page)
let _cacheLabels: string[] = new Array(40).fill('');

/** Update cache slot labels from a loaded CAN receive config.
 *  localInputs (опц.) — включённые локальные входы занимают слоты ПОСЛЕ CAN-сигналов. */
export function setCacheLabelsFromConfig(
	messages: CanMessageConfig[],
	localInputs?: { en: boolean; name: string; label?: string }[]
) {
	_cacheLabels = buildCacheSlotLabels(messages, localInputs);
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
	loadKnownParams();
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
			const pname = getParamName(entry.paramType);
			liveData.params[entry.paramType] = {
				name: pname,
				value,
				paramType: entry.paramType,
				lastUpdate: now
			};
			// Запомнить параметр (имя+последнее значение) для офлайн-настройки. Мутируем поля
			// существующей записи (а не создаём объект каждый пакет), чтобы не плодить реактивную
			// перерисовку реестра — union-ключи меняются только при появлении НОВОГО параметра.
			const kp = knownParams[entry.paramType];
			if (kp) {
				kp.name = pname;
				kp.lastValue = value;
			} else {
				knownParams[entry.paramType] = { paramType: entry.paramType, name: pname, lastValue: value };
			}
			scheduleSaveKnownParams();
		}
	});
}

/** Get a sorted array of all current parameter values.
 *  Порядок — по enum, но семейство OUT держим вместе: OUT2..4 (поздние enum 64..66)
 *  встают сразу за OUT1 (исторический enum 2). Влияет на live-список и колонки лога. */
const SORT_TWEAK: Record<number, number> = { 64: 2.1, 65: 2.2, 66: 2.3 };
const sortKey = (p: ParamValue) => SORT_TWEAK[p.paramType] ?? p.paramType;
export function getParamList(): ParamValue[] {
	return Object.values(liveData.params).sort((a, b) => sortKey(a) - sortKey(b));
}

export interface DashParam extends ParamValue {
	online: boolean;
}
const FRESH_MS = 3000;
/** Список плашек главного экрана: объединение live-параметров и реестра «виденных».
 *  online=false — данные не свежие (нет связи / параметр пока не пришёл) → значение последнее
 *  известное, плашку показываем приглушённой, но настраивать пороги можно. */
export function getDashParamList(): DashParam[] {
	const now = Date.now();
	const types = new Set<number>();
	for (const k of Object.keys(liveData.params)) types.add(Number(k));
	for (const k of Object.keys(knownParams)) types.add(Number(k));

	const out: DashParam[] = [];
	for (const pt of types) {
		const live = liveData.params[pt];
		if (live) {
			out.push({ ...live, online: now - live.lastUpdate < FRESH_MS });
		} else {
			const known = knownParams[pt];
			if (known)
				out.push({ name: known.name, value: known.lastValue, paramType: pt, lastUpdate: 0, online: false });
		}
	}
	return out.sort((a, b) => sortKey(a) - sortKey(b));
}
