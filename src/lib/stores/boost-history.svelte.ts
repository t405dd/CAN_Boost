// In-memory live history for the boost picture, sampled on a uniform time grid
// from the moment of BLE connection. Powers the expandable header chart
// (RPM / MAP / target / boost / bias + regulator state).
//
// Independent of the IndexedDB CSV logger (client-log.svelte.ts), which is
// opt-in and persisted. This buffer is always-on while connected and lives only
// in RAM — it exists so the user can pull up a scrollable/zoomable graph at any
// time without having armed a recording first.

import { liveData } from './live-data.svelte';
import { boostSettings } from './boost-settings.svelte';
import { bleState } from './ble-connection.svelte';
import { signalLabels } from './signal-labels.svelte';
import { PARAM_BOOST_STATE, PARAM_BOOST_BIAS, PARAM_MAP_DOT, PARAM_TPS_DOT, PARAM_CACHE_SLOT_START, PARAM_CO_MUL_1, PARAM_CO_MUL_2, PARAM_CO_MUL_3, PARAM_CO_BASE } from '$lib/ble/protocol';

export interface HistSample {
	t: number; // ms since session start (monotonic, sorted)
	rpm: number; // NaN when the signal is absent
	tps: number; // throttle % (configured signal)
	map: number; // actual MAP (configured signal)
	target: number; // BST_TGT (4) — target MAP
	boost: number; // BST_OUT (3) — actuator duty %
	bias: number; // BST_BIAS (57) — feedforward duty, computed by firmware (single source of truth)
	co1: number; // CO1 (2) — CAN-out 1 duty %
	rpmdot: number; // BST_dRPM (14) — dRPM/dt, RPM/s (firmware)
	mapdot: number; // MAPdot (58) — dMAP/dt, kPa/s (firmware)
	tpsdot: number; // TPSdot (59) — dTPS/dt, %/s (firmware)
	cobase: number; // COBase (63) — результат таблицы T1 (база), % (firmware)
	comul1: number; // COmul1 (60) — результат таблицы-мультипликатора 1 (T2), % (firmware)
	comul2: number; // COmul2 (61) — результат таблицы-мультипликатора 2 (T3), % (firmware)
	comul3: number; // COmul3 (62) — результат таблицы-мультипликатора 3 (T4), % (firmware)
	// Принятые CAN-сигналы (cache-слоты), резолвятся по подписи/настройке — NaN если не найдены.
	knk: number; // детонация (knockSignalParam или слот с подписью knock)
	afr: number; // AFR (факт)
	afrTarget: number; // AFR target (цель)
	ign: number; // угол зажигания
	state: number; // BST_ST (55) — regulator phase (NaN if absent)
}

// --- Резолв принятых сигналов по подписи cache-слота (зависит от CAN Receive config) -------
/** Найти enum cache-слота, чья подпись (в нижнем регистре) удовлетворяет предикату; -1 если нет. */
function findSlotEnum(match: (label: string) => boolean): number {
	for (const [k, v] of Object.entries(signalLabels)) {
		if (v && v.label && match(v.label.toLowerCase())) return PARAM_CACHE_SLOT_START + Number(k);
	}
	return -1;
}
const isAfrTarget = (l: string) =>
	l.includes('afr') && (l.includes('tgt') || l.includes('target') || l.includes('цел') || l.includes('aim') || l.includes('desired'));
function resolveKnk(): number {
	const k = boostSettings.value.knockSignalParam;
	if (k && k !== 0) return k; // явно выбранный сигнал детонации
	return findSlotEnum((l) => l.includes('knock') || l.includes('knk') || l.includes('детон'));
}
function resolveIgn(): number {
	return findSlotEnum(
		(l) => l.includes('ign') || l.includes('spark') || l.includes('timing') || l.includes('advance') ||
			l.includes('угол') || l.includes('зажиг') || l.includes('опереж')
	);
}
function slotValue(p: Record<number, { value: number }>, en: number): number {
	return en >= 0 ? (p[en]?.value ?? NaN) : NaN;
}

const SAMPLE_HZ = 10;
const PERIOD_MS = Math.round(1000 / SAMPLE_HZ);
const MAX_SAMPLES = 36_000; // ~1 h @ 10 Hz; oldest dropped past this
const DROP_CHUNK = 3_600; // drop 10 % at a time to keep the splice cheap

// Small reactive surface; the bulk sample array is kept OUT of $state to avoid
// proxying tens of thousands of entries. `count` is bumped on every sample so
// the chart can react (redraw / follow) without touching the array proxy.
export const histState = $state({
	open: false, // chart panel visible
	count: 0, // sample counter — read this to react to new data
	startedAt: 0 // Date.now() at session start
});

let samples: HistSample[] = [];
let timer: ReturnType<typeof setInterval> | null = null;

/** The raw sample buffer (read-only use; sorted by `t` ascending). */
export function getHistory(): HistSample[] {
	return samples;
}

export function toggleChart(): void {
	histState.open = !histState.open;
}

function tick(): void {
	// Без связи liveData держит застывшие значения — не плодим дубль-мусор.
	if (bleState.status !== 'connected') return;
	const p = liveData.params;
	const knkEnum = resolveKnk();
	const afrEnum = findSlotEnum((l) => (l.includes('afr') || l.includes('lambda') || l.includes('λ')) && !isAfrTarget(l));
	const afrTgtEnum = findSlotEnum(isAfrTarget);
	const ignEnum = resolveIgn();
	samples.push({
		t: Date.now() - histState.startedAt,
		rpm: p[boostSettings.value.rpmSignalParam]?.value ?? NaN,
		tps: p[boostSettings.value.tpsSignalParam]?.value ?? NaN,
		map: p[boostSettings.value.mapSignalParam]?.value ?? NaN,
		target: p[4]?.value ?? NaN,
		boost: p[3]?.value ?? NaN,
		bias: p[PARAM_BOOST_BIAS]?.value ?? NaN, // прошивка считает bias по таблице — читаем готовое
		co1: p[2]?.value ?? NaN,
		rpmdot: p[14]?.value ?? NaN, // BST_dRPM
		mapdot: p[PARAM_MAP_DOT]?.value ?? NaN,
		tpsdot: p[PARAM_TPS_DOT]?.value ?? NaN,
		cobase: p[PARAM_CO_BASE]?.value ?? NaN,
		comul1: p[PARAM_CO_MUL_1]?.value ?? NaN,
		comul2: p[PARAM_CO_MUL_2]?.value ?? NaN,
		comul3: p[PARAM_CO_MUL_3]?.value ?? NaN,
		knk: slotValue(p, knkEnum),
		afr: slotValue(p, afrEnum),
		afrTarget: slotValue(p, afrTgtEnum),
		ign: slotValue(p, ignEnum),
		state: p[PARAM_BOOST_STATE]?.value ?? NaN
	});
	if (samples.length > MAX_SAMPLES) samples.splice(0, DROP_CHUNK);
	histState.count++;
}

/** Begin a fresh history session (called on each new BLE connection). */
export function startHistory(): void {
	stopHistory();
	samples = [];
	histState.startedAt = Date.now();
	histState.count = 0;
	timer = setInterval(tick, PERIOD_MS);
}

/** Stop sampling but KEEP the buffer — the user can still review after a drop. */
export function stopHistory(): void {
	if (timer) {
		clearInterval(timer);
		timer = null;
	}
}
