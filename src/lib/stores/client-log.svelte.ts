// Client-side data logger (Svelte 5 runes).
// Records live-data samples to a local CSV, persisted in IndexedDB so the log
// survives BLE disconnects AND page reloads/crashes. Lets the user share the
// file (Web Share API → Telegram/email/… on mobile) or download it.
//
// Sampling is timer-based (uniform time grid) from the latest liveData snapshot,
// independent of BLE packet rate — convenient for plotting the learning process.

import { liveData, getParamList } from './live-data.svelte';

// --- IndexedDB (minimal, no external dep) ----------------------------------
const DB_NAME = 'canboost-log';
const DB_VERSION = 1;
const STORE_ROWS = 'rows';   // autoIncrement: { t, seq, ev, v:number[] }
const STORE_META = 'meta';   // keyPath 'id': { id:'session', startedAt, rateHz, columns }

interface ColumnSpec { paramType: number; name: string; }
interface RowRec { t: number; seq: number; ev: string; v: number[]; }
interface MetaRec { id: 'session'; startedAt: number; rateHz: number; columns: ColumnSpec[]; }

function idbAvailable(): boolean {
	return typeof window !== 'undefined' && typeof indexedDB !== 'undefined';
}

function openDb(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open(DB_NAME, DB_VERSION);
		req.onupgradeneeded = () => {
			const db = req.result;
			if (!db.objectStoreNames.contains(STORE_ROWS))
				db.createObjectStore(STORE_ROWS, { autoIncrement: true });
			if (!db.objectStoreNames.contains(STORE_META))
				db.createObjectStore(STORE_META, { keyPath: 'id' });
		};
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

let dbPromise: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
	if (!dbPromise) dbPromise = openDb();
	return dbPromise;
}

function txDone(tx: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
		tx.onabort = () => reject(tx.error);
	});
}

// --- Reactive state (small; row data is kept out of the proxy for perf) -----
export const logState = $state({
	recording: false,
	rowCount: 0,
	startedAt: 0,        // Date.now() at recording start
	rateHz: 10,
	columns: [] as string[],   // human-readable headers (params only)
	approxBytes: 0,
	hasData: false,            // a session (current or restored) holds rows
	lastError: '' as string,
	capped: false              // hit MAX_ROWS — recording stopped
});

// Row data lives outside $state to avoid proxying tens of thousands of entries.
let rows: RowRec[] = [];
let columnsSpec: ColumnSpec[] = [];
let pendingFlush: RowRec[] = [];
let sampleTimer: ReturnType<typeof setInterval> | null = null;
let flushTimer: ReturnType<typeof setInterval> | null = null;
let pendingEvent = '';

const MAX_ROWS = 500_000;        // ~safety cap (≈8 h @ 20 Hz)
const FLUSH_INTERVAL_MS = 1500;  // batch IDB writes
const BYTES_PER_ROW_EST = 14;    // rough per-column char estimate for size readout

// --- Lifecycle: restore a previous session on load -------------------------
let restored = false;
export async function restoreLog(): Promise<void> {
	if (restored || !idbAvailable()) return;
	restored = true;
	try {
		const d = await db();
		const meta = await new Promise<MetaRec | undefined>((resolve, reject) => {
			const tx = d.transaction(STORE_META, 'readonly');
			const r = tx.objectStore(STORE_META).get('session');
			r.onsuccess = () => resolve(r.result as MetaRec | undefined);
			r.onerror = () => reject(r.error);
		});
		if (!meta) return;
		const loaded = await new Promise<RowRec[]>((resolve, reject) => {
			const tx = d.transaction(STORE_ROWS, 'readonly');
			const r = tx.objectStore(STORE_ROWS).getAll();
			r.onsuccess = () => resolve((r.result as RowRec[]) ?? []);
			r.onerror = () => reject(r.error);
		});
		columnsSpec = meta.columns;
		rows = loaded;
		logState.startedAt = meta.startedAt;
		logState.rateHz = meta.rateHz;
		logState.columns = columnsSpec.map((c) => c.name);
		logState.rowCount = rows.length;
		logState.hasData = rows.length > 0;
		logState.approxBytes = estimateBytes();
	} catch (e) {
		logState.lastError = String((e as Error).message ?? e);
	}
}

function estimateBytes(): number {
	const cols = columnsSpec.length + 4; // t,iso,seq,event
	return rows.length * cols * BYTES_PER_ROW_EST;
}

// --- Recording control ------------------------------------------------------
export async function startRecording(rateHz = 10): Promise<void> {
	if (logState.recording) return;
	await clearLog(); // fresh session
	logState.recording = true;
	logState.rateHz = rateHz;
	logState.startedAt = Date.now();
	logState.capped = false;
	logState.lastError = '';
	columnsSpec = [];
	logState.columns = [];

	const periodMs = Math.max(20, Math.round(1000 / rateHz));
	sampleTimer = setInterval(sampleTick, periodMs);
	flushTimer = setInterval(() => { void flush(); }, FLUSH_INTERVAL_MS);
}

export async function stopRecording(): Promise<void> {
	if (!logState.recording) return;
	logState.recording = false;
	if (sampleTimer) { clearInterval(sampleTimer); sampleTimer = null; }
	if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }
	await flush();
}

export async function clearLog(): Promise<void> {
	await stopRecording();
	rows = [];
	columnsSpec = [];
	pendingFlush = [];
	pendingEvent = '';
	logState.rowCount = 0;
	logState.hasData = false;
	logState.approxBytes = 0;
	logState.columns = [];
	logState.capped = false;
	if (!idbAvailable()) return;
	try {
		const d = await db();
		const tx = d.transaction([STORE_ROWS, STORE_META], 'readwrite');
		tx.objectStore(STORE_ROWS).clear();
		tx.objectStore(STORE_META).clear();
		await txDone(tx);
	} catch (e) {
		logState.lastError = String((e as Error).message ?? e);
	}
}

/** Tag the next sample with a text marker (e.g. "calibration start"). */
export function markEvent(text: string): void {
	pendingEvent = text;
}

function sampleTick(): void {
	const list = getParamList();

	// Lazily lock column set on the first tick that actually has data.
	if (columnsSpec.length === 0) {
		if (list.length === 0) return; // wait for the stream
		columnsSpec = list.map((p) => ({ paramType: p.paramType, name: p.name }));
		logState.columns = columnsSpec.map((c) => c.name);
		void writeMeta();
	}

	const v = columnsSpec.map((c) => liveData.params[c.paramType]?.value ?? NaN);
	const rec: RowRec = {
		t: Date.now() - logState.startedAt,
		seq: liveData.sequence,
		ev: pendingEvent,
		v
	};
	pendingEvent = '';
	rows.push(rec);
	pendingFlush.push(rec);
	logState.rowCount = rows.length;
	logState.hasData = true;
	logState.approxBytes = estimateBytes();

	if (rows.length >= MAX_ROWS) {
		logState.capped = true;
		void stopRecording();
	}
}

async function writeMeta(): Promise<void> {
	if (!idbAvailable()) return;
	try {
		const d = await db();
		const tx = d.transaction(STORE_META, 'readwrite');
		const meta: MetaRec = {
			id: 'session',
			startedAt: logState.startedAt,
			rateHz: logState.rateHz,
			columns: columnsSpec
		};
		tx.objectStore(STORE_META).put(meta);
		await txDone(tx);
	} catch (e) {
		logState.lastError = String((e as Error).message ?? e);
	}
}

async function flush(): Promise<void> {
	if (pendingFlush.length === 0 || !idbAvailable()) return;
	const batch = pendingFlush;
	pendingFlush = [];
	try {
		const d = await db();
		const tx = d.transaction(STORE_ROWS, 'readwrite');
		const store = tx.objectStore(STORE_ROWS);
		for (const r of batch) store.add(r);
		await txDone(tx);
	} catch (e) {
		// On failure, re-queue so we retry next flush (don't lose data).
		pendingFlush = batch.concat(pendingFlush);
		logState.lastError = String((e as Error).message ?? e);
	}
}

// --- Export -----------------------------------------------------------------
function csvCell(s: string): string {
	// Quote if it contains comma, quote, or newline.
	if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
	return s;
}

export function buildCsv(): string {
	const header = ['t_ms', 'iso_time', 'seq', 'event', ...columnsSpec.map((c) => c.name)];
	const lines: string[] = [header.map(csvCell).join(',')];
	for (const r of rows) {
		const iso = new Date(logState.startedAt + r.t).toISOString();
		const cells = [
			String(r.t),
			iso,
			String(r.seq),
			csvCell(r.ev ?? ''),
			...r.v.map((x) => (Number.isFinite(x) ? formatNum(x) : ''))
		];
		lines.push(cells.join(','));
	}
	return lines.join('\n');
}

function formatNum(x: number): string {
	// Trim to 4 significant decimals without scientific notation noise.
	if (Number.isInteger(x)) return String(x);
	return x.toFixed(4).replace(/\.?0+$/, '');
}

export function logFileName(ext = 'csv'): string {
	const d = new Date(logState.startedAt || Date.now());
	const p = (n: number) => String(n).padStart(2, '0');
	const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
	return `canboost-log_${stamp}.${ext}`;
}

function downloadBlob(blob: Blob, name: string): void {
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = name;
	document.body.appendChild(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** Share via Web Share API (file). Returns a status: 'shared' | 'downloaded' | 'empty'. */
export async function shareLog(): Promise<'shared' | 'downloaded' | 'empty'> {
	if (rows.length === 0) return 'empty';
	await flush();
	const csv = buildCsv();
	const name = logFileName('csv');
	const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
	const file = new File([blob], name, { type: 'text/csv' });

	const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
	try {
		if (nav.canShare && nav.canShare({ files: [file] })) {
			await nav.share({ files: [file], title: 'MS3 CAN BC log' });
			return 'shared';
		}
	} catch (e) {
		// User cancelled the share sheet → don't fall through to a download.
		if ((e as Error).name === 'AbortError') return 'shared';
		logState.lastError = String((e as Error).message ?? e);
	}
	downloadBlob(blob, name);
	return 'downloaded';
}

export function downloadLog(): 'downloaded' | 'empty' {
	if (rows.length === 0) return 'empty';
	const csv = buildCsv();
	downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }), logFileName('csv'));
	return 'downloaded';
}
