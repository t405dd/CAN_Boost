// Client-side data logger (Svelte 5 runes).
// Records live-data samples to a local CSV, persisted in IndexedDB so the log
// survives BLE disconnects AND page reloads/crashes. Lets the user share the
// file (Web Share API → Telegram/email/… on mobile) or download it.
//
// Sampling is timer-based (uniform time grid) from the latest liveData snapshot,
// independent of BLE packet rate — convenient for plotting the learning process.

import { liveData, getParamList } from './live-data.svelte';
import { onLearnDelta, type LearnDelta } from './boost-learn-stream.svelte';
import { readJsonConfig } from '$lib/ble/chunked-transfer';
import { SVC_BOOST, CHR_BOOST_LEARN, CHR_BOOST_BIAS, CHR_BOOST_TARGET } from '$lib/ble/uuids';
import { bleState } from './ble-connection.svelte';

// --- IndexedDB (minimal, no external dep) ----------------------------------
const DB_NAME = 'canboost-log';
const DB_VERSION = 1;
const STORE_ROWS = 'rows';   // autoIncrement: { t, seq, ev, v:number[] }
const STORE_META = 'meta';   // keyPath 'id': { id:'session', startedAt, rateHz, columns }

interface ColumnSpec { paramType: number; name: string; }
// kind 'lrn' = строка-корректировка обучения; 'mark' = маркер (пауза/возобновление и т.п.).
// У обеих param-колонки пустые (v=[]), текст — в ev. У 'mark' ev начинается с "PAUSE"/"RESUME".
interface RowRec { t: number; seq: number; ev: string; v: number[]; kind?: 'lrn' | 'mark'; }
// Снимок всех PID/наддувных таблиц в момент времени (как читаются с устройства).
interface TablesSnapshot { ki?: unknown; kp?: unknown; kd?: unknown; bias?: unknown; target?: unknown; }
interface MetaRec {
	id: 'session'; startedAt: number; rateHz: number; columns: ColumnSpec[];
	tablesStart?: TablesSnapshot | null; tablesEnd?: TablesSnapshot | null;
}

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
	paused: false,             // запись приостановлена (обрыв BLE / ручная пауза) — сессия жива
	rowCount: 0,
	startedAt: 0,        // Date.now() at recording start
	rateHz: 10,
	columns: [] as string[],   // human-readable headers (params only)
	approxBytes: 0,
	hasData: false,            // a session (current or restored) holds rows
	lastError: '' as string,
	capped: false,             // hit MAX_ROWS — recording stopped
	learnEvents: 0             // число пойманных корректировок обучения в текущей сессии
});

// Причина паузы определяет авто-возобновление: только непреднамеренный обрыв ('disconnect')
// возобновляется сам при реконнекте. Ручная пауза и ручное отключение — нет.
type PauseReason = 'disconnect' | 'manual-disconnect' | 'manual' | null;
let pauseReason: PauseReason = null;
// Выставляется кнопкой Disconnect ПЕРЕД разрывом → отличаем ручное отключение от обрыва.
let manualDisconnectPending = false;

// Row data lives outside $state to avoid proxying tens of thousands of entries.
let rows: RowRec[] = [];
let columnsSpec: ColumnSpec[] = [];
let pendingFlush: RowRec[] = [];
let sampleTimer: ReturnType<typeof setInterval> | null = null;
let flushTimer: ReturnType<typeof setInterval> | null = null;
let pendingEvent = '';

// --- Снимки таблиц + поток корректировок обучения --------------------------
let tablesStart: TablesSnapshot | null = null;
let tablesEnd: TablesSnapshot | null = null;
let learnUnsub: (() => void) | null = null;

const LEARN_TABLE_NAME: Record<number, string> = { 0: 'ki', 1: 'kp', 2: 'kd', 3: 'bias' };

/** Прочитать с устройства текущие PID/наддувные таблицы (best-effort; null-поля при сбое). */
async function snapshotBoostTables(): Promise<TablesSnapshot | null> {
	if (bleState.status !== 'connected') return null;
	const snap: TablesSnapshot = {};
	try {
		const learn = await readJsonConfig<{ ki?: unknown; kp?: unknown; kd?: unknown }>(SVC_BOOST, CHR_BOOST_LEARN);
		if (learn) { snap.ki = learn.ki ?? learn; snap.kp = learn.kp; snap.kd = learn.kd; }
	} catch { /* пропускаем — таблица останется без поля */ }
	try { snap.bias = await readJsonConfig(SVC_BOOST, CHR_BOOST_BIAS); } catch { /* skip */ }
	try { snap.target = await readJsonConfig(SVC_BOOST, CHR_BOOST_TARGET); } catch { /* skip */ }
	return snap;
}

/** Записать одну строку-корректировку обучения (приходит из общего стора learn-дельт). */
function recordLearnDeltas(deltas: LearnDelta[]): void {
	if (!logState.recording || deltas.length === 0) return;
	// Формат токена: name[row:col]=value. Двоеточие (а не запятая) — чтобы не плодить
	// CSV-кавычки внутри колонки event. Анализатор парсит ровно этот формат.
	const parts = deltas.map((d) => {
		const name = LEARN_TABLE_NAME[d.tableId] ?? `t${d.tableId}`;
		return `${name}[${d.row}:${d.col}]=${formatNum(d.value)}`;
	});
	const rec: RowRec = {
		t: Date.now() - logState.startedAt,
		seq: liveData.sequence,
		ev: 'LRN ' + parts.join(' '),
		v: [],
		kind: 'lrn'
	};
	rows.push(rec);
	pendingFlush.push(rec);
	logState.rowCount = rows.length;
	logState.learnEvents += deltas.length;
	logState.hasData = true;
}

/** Записать строку-маркер (пауза/возобновление). Param-колонки пустые, текст — в ev.
 *  Пишется даже без связи (значения с устройства не нужны), фиксирует момент события. */
function pushMarker(text: string): void {
	if (!logState.recording) return;
	const rec: RowRec = {
		t: Date.now() - logState.startedAt,
		seq: liveData.sequence,
		ev: text,
		v: [],
		kind: 'mark'
	};
	rows.push(rec);
	pendingFlush.push(rec);
	logState.rowCount = rows.length;
	logState.hasData = true;
}

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
		tablesStart = meta.tablesStart ?? null;
		tablesEnd = meta.tablesEnd ?? null;
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
	logState.paused = false;
	pauseReason = null;
	logState.rateHz = rateHz;
	logState.startedAt = Date.now();
	logState.capped = false;
	logState.lastError = '';
	columnsSpec = [];
	logState.columns = [];

	const periodMs = Math.max(20, Math.round(1000 / rateHz));
	sampleTimer = setInterval(sampleTick, periodMs);
	flushTimer = setInterval(() => { void flush(); }, FLUSH_INTERVAL_MS);

	// Ловим корректировки обучения на ЛЮБОЙ странице (общий ref-counted стор).
	if (!learnUnsub) learnUnsub = onLearnDelta(recordLearnDeltas);
	// Снимок таблиц на старте (не блокируем запись — читаем в фоне через BLE-очередь).
	void snapshotBoostTables().then((s) => { tablesStart = s; void writeMeta(); });
}

export async function stopRecording(): Promise<void> {
	if (!logState.recording) return;
	logState.recording = false;
	if (sampleTimer) { clearInterval(sampleTimer); sampleTimer = null; }
	if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }
	if (learnUnsub) { learnUnsub(); learnUnsub = null; }
	logState.paused = false;
	pauseReason = null;
	// Снимок таблиц на стопе — чтобы видеть, что обучение изменило за сессию (diff со стартом).
	tablesEnd = await snapshotBoostTables();
	await writeMeta();
	await flush();
}

// --- Пауза/возобновление записи (обрыв BLE / ручная пауза) ---------------------
// Сессия остаётся живой, sampleTimer глушится (мусор не пишется), ставится маркер с причиной.
function pauseRecording(reason: Exclude<PauseReason, null>, markerText: string): void {
	if (!logState.recording || logState.paused) return;
	logState.paused = true;
	pauseReason = reason;
	if (sampleTimer) { clearInterval(sampleTimer); sampleTimer = null; }
	pushMarker(markerText);
	void flush();   // дописать хвост в IDB, чтобы ничего не потерять
}

function resumeRecording(markerText: string): void {
	if (!logState.recording || !logState.paused) return;
	logState.paused = false;
	pauseReason = null;
	pushMarker(markerText);
	const periodMs = Math.max(20, Math.round(1000 / logState.rateHz));
	if (!sampleTimer) sampleTimer = setInterval(sampleTick, periodMs);
	if (!flushTimer) flushTimer = setInterval(() => { void flush(); }, FLUSH_INTERVAL_MS);
}

/** Ручная пауза/возобновление кнопкой на странице логирования. */
export function toggleManualPause(): void {
	if (!logState.recording) return;
	if (logState.paused) resumeRecording('RESUME (manual)');
	else pauseRecording('manual', 'PAUSE (manual)');
}

/** Кнопка Disconnect вызывает это ПЕРЕД разрывом — чтобы отличить ручное отключение от обрыва. */
export function markManualDisconnect(): void {
	manualDisconnectPending = true;
}

/** Вызывается из layout на КАЖДУЮ смену статуса BLE. Пауза при потере связи, авто-возобновление
 *  только после НЕпреднамеренного обрыва (не после ручного Disconnect и не после ручной паузы). */
export function handleConnectionChange(connected: boolean): void {
	if (connected) {
		const wasInvoluntary = logState.paused && pauseReason === 'disconnect';
		manualDisconnectPending = false;
		if (wasInvoluntary) resumeRecording('RESUME (BLE reconnected)');
		return;
	}
	// Потеря связи.
	if (!logState.recording || logState.paused) return;
	if (manualDisconnectPending) pauseRecording('manual-disconnect', 'PAUSE (manual disconnect)');
	else pauseRecording('disconnect', 'PAUSE (BLE disconnected)');
}

export async function clearLog(): Promise<void> {
	await stopRecording();
	rows = [];
	columnsSpec = [];
	pendingFlush = [];
	pendingEvent = '';
	tablesStart = null;
	tablesEnd = null;
	logState.rowCount = 0;
	logState.hasData = false;
	logState.approxBytes = 0;
	logState.columns = [];
	logState.capped = false;
	logState.learnEvents = 0;
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
	// Страховка: без связи liveData держит ЗАСТЫВШИЕ значения — не пишем дубль-мусор.
	// (Основной механизм — пауза глушит таймер; это защита от гонок.)
	if (bleState.status !== 'connected') return;
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
			columns: columnsSpec,
			tablesStart,
			tablesEnd
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
	const blanks = columnsSpec.map(() => '');
	for (const r of rows) {
		const iso = new Date(logState.startedAt + r.t).toISOString();
		// Строки-корректировки обучения (kind='lrn') и маркеры (kind='mark') несут текст в event,
		// param-колонки пустые. У них v=[], поэтому отдаём пустые ячейки.
		const params = r.v.length === 0
			? blanks
			: r.v.map((x) => (Number.isFinite(x) ? formatNum(x) : ''));
		const cells = [String(r.t), iso, String(r.seq), csvCell(r.ev ?? ''), ...params];
		lines.push(cells.join(','));
	}
	// Снимки таблиц — закомментированным (# ...) блоком в конце файла. Анализатор читает обе строки;
	// обычные CSV-парсеры строки с ведущим '#' игнорируют/отбрасывают как мусор.
	if (tablesStart || tablesEnd) {
		lines.push('# CANBOOST_TABLES v1');
		if (tablesStart) lines.push('# TABLES_START ' + JSON.stringify(tablesStart));
		if (tablesEnd) lines.push('# TABLES_END ' + JSON.stringify(tablesEnd));
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
			await nav.share({ files: [file], title: 'BoostPilot log' });
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
