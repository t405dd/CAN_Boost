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
import { PARAM_BOOST_STATE, PARAM_BOOST_BIAS } from '$lib/ble/protocol';

export interface HistSample {
	t: number; // ms since session start (monotonic, sorted)
	rpm: number; // NaN when the signal is absent
	map: number; // actual MAP (configured signal)
	target: number; // BST_TGT (4) — target MAP
	boost: number; // BST_OUT (3) — actuator duty %
	bias: number; // BST_BIAS (57) — feedforward duty, computed by firmware (single source of truth)
	state: number; // BST_ST (55) — regulator phase (NaN if absent)
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
	samples.push({
		t: Date.now() - histState.startedAt,
		rpm: p[boostSettings.value.rpmSignalParam]?.value ?? NaN,
		map: p[boostSettings.value.mapSignalParam]?.value ?? NaN,
		target: p[4]?.value ?? NaN,
		boost: p[3]?.value ?? NaN,
		bias: p[PARAM_BOOST_BIAS]?.value ?? NaN, // прошивка считает bias по таблице — читаем готовое
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
