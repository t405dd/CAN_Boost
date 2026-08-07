// firmware-update.ts — обновление прошивки BoostPilot «по воздуху» через BLE.
//
// Порт быстрого пайплайна с CamGrinder (cnc_firmware.js) на статический PWA: там образ
// отдавал Django (/api/firmware/latest/ + предсжатый ?fmt=deflate), здесь того же добиваемся
// без сервера — артефакты лежат рядом с приложением на GitHub Pages (firmware/manifest.json),
// а сжатие делает tools/make_ota.py при выпуске. Плюс всегда доступен ручной путь: выбрать
// .bin с телефона (когда артефакт ещё не выложен или нужна своя сборка).
//
// Откуда берётся скорость (порядок важности):
//   1. Образ жмётся raw-deflate: ~950 КБ → ~600 КБ. По воздуху летит на треть меньше.
//      Предсжатый .z с сервера ещё и экономит браузеру проход CompressionStream по мегабайту.
//   2. writeWithoutResponse: нет ACK на каждый пакет — пакеты идут подряд в conn-события.
//   3. Чанк 500 байт (почти весь MTU 512) вместо дефолтных 20.
//   4. Синхронизация раз в 32 КБ, а не на каждый чанк: round-trip'ы не съедают канал.
//   5. Прошивка на OTA_BEGIN просит короткий conn-интервал и DLE (см. ota_update.h) —
//      сюда это приходит строкой OTA_LINK, чтобы было видно, ЧТО согласовалось.
//   6. Live-данные на время передачи заглушены (иначе конкурируют за тот же канал).
//
// Целостность: SHA-256 распакованного образа считается ЗДЕСЬ (WebCrypto) и уезжает в
// OTA_BEGIN. Прошивка считает свой хеш по ходу записи и сверяет САМА перед коммитом —
// поэтому обрыв BLE после 100% больше не оставляет образ неактивированным (ровно тот
// сценарий, из-за которого на CamGrinder станок оставался на старой версии).

import { getCharacteristic, queueBleOperation, pauseLiveData, resumeLiveData, isConnected } from '$lib/ble/connection';
import { SVC_SYSTEM, CHR_OTA_CTRL, CHR_OTA_DATA } from '$lib/ble/uuids';

/** Размер чанка. MTU 512 ⇒ полезная нагрузка ≤509; 500 — с запасом и круглое. */
const CHUNK_SIZE = 500;
/** Сколько байт льём между сверками OTA_SYNC. */
const SYNC_BYTES = 32 * 1024;
/** Минимальный чанк, до которого опускаемся при отказах записи. */
const MIN_CHUNK = 64;
/** Магический первый байт образа ESP32 (esp_image_header_t.magic). */
const ESP_IMAGE_MAGIC = 0xe9;

export type OtaPhase =
	| 'idle' | 'preparing' | 'downloading' | 'compressing'
	| 'uploading' | 'flashing' | 'verifying' | 'done' | 'error';

export interface OtaState {
	phase: OtaPhase;
	/** Прогресс текущей фазы, 0..100. */
	pct: number;
	log: string[];
	error: string;
	/** Скорость передачи по воздуху, КБ/с (считается по ходу upload). */
	speedKbs: number;
	/** Остаток времени передачи, с. */
	etaSec: number;
}

export interface FirmwareManifest {
	version: string;
	built?: string;
	/** Размер РАСПАКОВАННОГО образа, байт. */
	size: number;
	/** SHA-256 распакованного образа, hex. */
	sha256: string;
	/** Имя файла образа рядом с манифестом. */
	bin: string;
	/** Имя предсжатого raw-deflate образа (необязательно). */
	deflate?: string;
	deflateSize?: number;
	notes?: string;
}

/** Сравнение semver-подобных версий: 1 если a>b, -1 если a<b, 0 если равны. */
export function compareVersions(a: string, b: string): number {
	const parse = (v: string) => v.replace(/[-+].*$/, '').split('.').map((n) => parseInt(n, 10) || 0);
	const pa = parse(a), pb = parse(b);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const x = pa[i] ?? 0, y = pb[i] ?? 0;
		if (x > y) return 1;
		if (x < y) return -1;
	}
	return 0;
}

/** Манифест прошивки с origin приложения. null — не выложен (норма: путь «выбрать файл»). */
export async function fetchManifest(basePath: string): Promise<FirmwareManifest | null> {
	try {
		// cache:'no-store' — манифест обязан быть свежим. Service worker его не precache-ит
		// (см. service-worker.ts), но браузерный кэш всё равно мог бы отдать вчерашний.
		const res = await fetch(`${basePath}/firmware/manifest.json`, { cache: 'no-store' });
		if (!res.ok) return null;
		const data = (await res.json()) as FirmwareManifest;
		if (!data?.version || !data?.bin || !data?.sha256 || !data?.size) return null;
		return data;
	} catch {
		return null;
	}
}

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', buf);
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function inflateRaw(buf: ArrayBuffer): Promise<ArrayBuffer> {
	const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
	return await new Response(stream).arrayBuffer();
}

async function deflateRaw(buf: ArrayBuffer): Promise<ArrayBuffer> {
	const stream = new Blob([buf]).stream().pipeThrough(new CompressionStream('deflate-raw'));
	return await new Response(stream).arrayBuffer();
}

/** Что уходит в устройство: `raw` — для проверок и размера, `send` — фактические байты. */
interface OtaPayload {
	raw: ArrayBuffer;
	send: ArrayBuffer;
	compressed: boolean;
}

/**
 * Проверки образа ДО передачи. Смысл — не потратить минуту на заливку мусора и, что важнее,
 * не оставить устройство с неисправным образом в загрузочном разделе. Прошивка проверит
 * SHA-256 сама, но здесь ошибка ловится мгновенно и объяснимо.
 */
function validateImage(raw: ArrayBuffer, expectedSize?: number): string | null {
	const bytes = new Uint8Array(raw);
	if (bytes.length < 4096) return `too_small:${bytes.length}`;
	if (bytes[0] !== ESP_IMAGE_MAGIC) return `bad_magic:0x${bytes[0].toString(16)}`;
	if (expectedSize && bytes.length !== expectedSize) return `size_mismatch:${bytes.length}/${expectedSize}`;
	return null;
}

/**
 * Скачивание образа по манифесту. Сначала пробуем ПРЕДСЖАТЫЙ .z — это ровно те байты,
 * что уйдут в устройство: трафик меньше, и браузер не жмёт мегабайт сам. Байты всё равно
 * проверяются РАСПАКОВАННЫМИ (magic/размер/SHA-256) ⇒ проверено именно то, что отправляется.
 * Любая осечка (нет артефакта, нет DecompressionStream) — молчаливый откат на .bin.
 */
async function fetchPayload(
	basePath: string,
	m: FirmwareManifest,
	log: (s: string) => void
): Promise<OtaPayload> {
	if (m.deflate && typeof DecompressionStream !== 'undefined') {
		try {
			const res = await fetch(`${basePath}/firmware/${m.deflate}`);
			if (res.ok) {
				const send = await res.arrayBuffer();
				const raw = await inflateRaw(send);
				if (raw.byteLength > 0) {
					log(`${(send.byteLength / 1024).toFixed(0)} KB (предсжато) → ${(raw.byteLength / 1024).toFixed(0)} KB`);
					return { raw, send, compressed: true };
				}
			}
		} catch (e) {
			log(`предсжатый образ недоступен, беру .bin (${e})`);
		}
	}
	const res = await fetch(`${basePath}/firmware/${m.bin}`);
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	const raw = await res.arrayBuffer();
	return { raw, send: raw, compressed: false };
}

// =============================================================================
// === Диалог с прошивкой по CHR_OTA_CTRL ======================================
// =============================================================================
type CtrlMsg = { kind: string; text: string };

/** Классификация статусных строк. Всё, что не опознано, попадает в лог как есть. */
function classify(text: string): CtrlMsg {
	if (text.startsWith('OTA_READY')) return { kind: 'ready', text };
	if (text.startsWith('OTA_ACK:')) return { kind: 'ack', text };
	if (text.startsWith('OTA_LINK:')) return { kind: 'link', text };
	if (text.startsWith('OTA_FLASH_PROGRESS:')) return { kind: 'flash_progress', text };
	if (text.startsWith('OTA_FLASH_DONE:')) return { kind: 'flash_done', text };
	if (text.startsWith('OTA_FLASH:')) return { kind: 'flash_start', text };
	if (text.startsWith('OTA_HASH_OK')) return { kind: 'hash_ok', text };
	if (text.startsWith('OTA_FINALIZING')) return { kind: 'finalizing', text };
	if (text.startsWith('OTA_SUCCESS')) return { kind: 'success', text };
	if (text.startsWith('OTA_ABORTED')) return { kind: 'aborted', text };
	if (text.startsWith('OTA_ERROR')) return { kind: 'error', text };
	return { kind: 'info', text };
}

/**
 * Канал статуса: подписка + очередь пришедших сообщений + ожидание по типу.
 * Очередь обязательна — ответ прошивки часто приходит РАНЬШЕ, чем мы успеваем начать ждать
 * (write возвращается уже после того, как устройство успело ответить).
 */
class CtrlChannel {
	private queue: CtrlMsg[] = [];
	private waiter: ((m: CtrlMsg) => void) | null = null;
	private unsubscribe: (() => void) | null = null;

	constructor(
		private char: BluetoothRemoteGATTCharacteristic,
		private onMessage: (m: CtrlMsg) => void
	) {}

	async start() {
		const decoder = new TextDecoder();
		const handler = (event: Event) => {
			const target = event.target as BluetoothRemoteGATTCharacteristic;
			if (!target.value) return;
			const text = decoder.decode(target.value).replace(/\0+$/, '').trim();
			if (!text) return;
			const msg = classify(text);
			this.onMessage(msg);
			if (this.waiter) {
				const w = this.waiter;
				this.waiter = null;
				w(msg);
			} else {
				this.queue.push(msg);
			}
		};
		this.char.addEventListener('characteristicvaluechanged', handler);
		await queueBleOperation(() => this.char.startNotifications());
		this.unsubscribe = () => {
			this.char.removeEventListener('characteristicvaluechanged', handler);
			this.char.stopNotifications().catch(() => {});
		};
	}

	stop() {
		this.unsubscribe?.();
		this.unsubscribe = null;
		this.waiter = null;
		this.queue = [];
	}

	/** Выбросить накопленное (перед фазой, где важен только свежий ответ). */
	drain() {
		this.queue = [];
	}

	next(timeoutMs: number): Promise<CtrlMsg> {
		const queued = this.queue.shift();
		if (queued) return Promise.resolve(queued);
		return new Promise((resolve, reject) => {
			this.waiter = resolve;
			setTimeout(() => {
				if (this.waiter === resolve) {
					this.waiter = null;
					reject(new Error('timeout'));
				}
			}, timeoutMs);
		});
	}

	async send(cmd: string) {
		const data = new TextEncoder().encode(cmd);
		await queueBleOperation(() => this.char.writeValue(data));
	}
}

// =============================================================================
// === Основной сценарий =======================================================
// =============================================================================
export interface StartOtaOptions {
	/** Готовые байты образа (ручной выбор .bin). Взаимоисключимо с manifest. */
	file?: ArrayBuffer;
	/** Манифест + basePath приложения — качаем сами (предпочтительно предсжатое). */
	manifest?: FirmwareManifest;
	basePath?: string;
	/** Колбэк прогресса — вызывается часто, держать дешёвым. */
	onState: (patch: Partial<OtaState>) => void;
	/** Строка в лог обновления. */
	onLog: (line: string) => void;
}

/**
 * Полный цикл обновления. Возвращает время всей операции в секундах.
 * Бросает Error при любом отказе — вызывающий показывает текст и уводит фазу в 'error'.
 */
export async function runOta(opts: StartOtaOptions): Promise<number> {
	const { onState, onLog } = opts;
	const t0 = performance.now();

	if (!isConnected()) throw new Error('not_connected');

	// --- 1. Получить образ ---
	onState({ phase: 'downloading', pct: 0 });
	let payload: OtaPayload;
	if (opts.file) {
		payload = { raw: opts.file, send: opts.file, compressed: false };
		onLog(`файл: ${(opts.file.byteLength / 1024).toFixed(0)} KB`);
	} else if (opts.manifest) {
		onLog(`версия ${opts.manifest.version}`);
		payload = await fetchPayload(opts.basePath ?? '', opts.manifest, onLog);
	} else {
		throw new Error('no_source');
	}

	const validationError = validateImage(payload.raw, opts.manifest?.size);
	if (validationError) throw new Error(validationError);

	const hash = await sha256Hex(payload.raw);
	if (opts.manifest && opts.manifest.sha256.toLowerCase() !== hash) {
		throw new Error(`sha_mismatch:${hash.slice(0, 12)}/${opts.manifest.sha256.slice(0, 12)}`);
	}
	onLog(`SHA-256 ${hash.slice(0, 16)}…`);

	// --- 2. Сжать, если ещё не сжато ---
	if (!payload.compressed && typeof CompressionStream !== 'undefined') {
		onState({ phase: 'compressing', pct: 0 });
		try {
			const send = await deflateRaw(payload.raw);
			// Сжатие «в минус» бывает на уже упакованных данных — тогда просто не жмём.
			if (send.byteLength < payload.raw.byteLength) {
				payload = { ...payload, send, compressed: true };
				const saved = (1 - send.byteLength / payload.raw.byteLength) * 100;
				onLog(`сжатие: ${(payload.raw.byteLength / 1024).toFixed(0)} → ${(send.byteLength / 1024).toFixed(0)} KB (−${saved.toFixed(0)}%)`);
			}
		} catch (e) {
			onLog(`сжатие недоступно, шлём как есть (${e})`);
		}
	}

	const imageSize = payload.raw.byteLength;
	const sendBytes = new Uint8Array(payload.send);
	const totalToSend = sendBytes.length;

	// --- 3. Открыть каналы ---
	onState({ phase: 'preparing', pct: 0 });
	const ctrlChar = await getCharacteristic(SVC_SYSTEM, CHR_OTA_CTRL);
	const dataChar = await getCharacteristic(SVC_SYSTEM, CHR_OTA_DATA);
	if (!ctrlChar || !dataChar) throw new Error('no_ota_service');

	// Живые данные — молчать. Иначе 10 Гц нотификаций отбирают у образа TX-очередь
	// прошивки и conn-события (та же болезнь, что у chunked-таблиц).
	// Всё дальше — под try/finally: сбой на подписке (а не только в передаче) не должен
	// оставить live-данные заглушенными до переподключения.
	await pauseLiveData();

	const ctrl = new CtrlChannel(ctrlChar, (m) => {
		if (m.kind === 'flash_progress') {
			onState({ phase: 'flashing', pct: parseInt(m.text.split(':')[1], 10) || 0 });
			return;
		}
		if (m.kind === 'ack') return; // шумно, показываем агрегированно в фазе upload
		onLog(`← ${m.text}`);
	});

	try {
		await ctrl.start();

		// Дождаться, пока общая очередь GATT опустеет: дальше мы пишем в DATA НАПРЯМУЮ,
		// минуя очередь, и параллельная чужая операция сорвала бы передачу.
		await queueBleOperation(async () => {});

		// Быстрый путь записи. Если центральный не умеет writeWithoutResponse — работаем
		// обычной записью: медленнее, но обновление проходит.
		const useFast = dataChar.properties.writeWithoutResponse;
		onLog(useFast ? 'режим: writeWithoutResponse (быстрый)' : 'режим: writeValue (медленный)');
		const writeData = useFast
			? (d: Uint8Array) => dataChar.writeValueWithoutResponse(d as unknown as BufferSource)
			: (d: Uint8Array) => dataChar.writeValue(d as unknown as BufferSource);

		// --- 4. OTA_BEGIN ---
		const beginCmd = `OTA_BEGIN:${imageSize}:${hash}${payload.compressed ? ':GZ' : ''}`;
		onLog(`→ OTA_BEGIN ${imageSize} B${payload.compressed ? ' (GZ)' : ''}`);
		ctrl.drain();
		await ctrl.send(beginCmd);
		// Ждём OTA_READY. Долго: Update.begin стирает 1.4 МБ раздела.
		const ready = await waitFor(ctrl, 'ready', 20000);
		if (ready.kind === 'error') throw new Error(ready.text);

		// --- 5. Стрим чанков ---
		onState({ phase: 'uploading', pct: 0 });
		const upStart = performance.now();
		let offset = 0;
		let chunk = CHUNK_SIZE;
		let chunkCount = 0;
		let lastPct = -1;

		while (offset < totalToSend) {
			const batchEnd = Math.min(offset + SYNC_BYTES, totalToSend);
			let retries = 0;

			while (offset < batchEnd) {
				const end = Math.min(offset + chunk, totalToSend);
				try {
					await writeData(sendBytes.subarray(offset, end));
					offset = end;
					chunkCount++;
					retries = 0;
				} catch (e) {
					// Адаптация под фактический MTU: пакет не пролез — режем вдвое.
					// Так связка «телефон + адаптер», согласовавшая меньший MTU, не роняет OTA.
					if (chunk > MIN_CHUNK && retries < 3) {
						const old = chunk;
						chunk = Math.max(MIN_CHUNK, Math.floor(chunk / 2));
						retries++;
						onLog(`чанк ${old} → ${chunk} B`);
						continue;
					}
					throw e;
				}

				// Отдаём поток UI и обновляем прогресс не чаще, чем раз в ~8 КБ:
				// иначе рендер съедает больше времени, чем сама передача.
				if (chunkCount % 16 === 0) {
					const pct = Math.floor((offset / totalToSend) * 100);
					const elapsed = (performance.now() - upStart) / 1000;
					if (pct !== lastPct) {
						lastPct = pct;
						const kbs = elapsed > 0 ? offset / 1024 / elapsed : 0;
						onState({
							phase: 'uploading',
							pct,
							speedKbs: kbs,
							etaSec: kbs > 0 ? (totalToSend - offset) / 1024 / kbs : 0
						});
					}
					await new Promise((r) => setTimeout(r, 0));
				}
			}

			// Сверка после батча: прошивка отвечает, сколько байт реально приняла.
			await ctrl.send('OTA_SYNC');
			const ack = await waitFor(ctrl, 'ack', 30000);
			if (ack.kind === 'error') throw new Error(ack.text);
			const acked = parseInt(ack.text.split(':')[1], 10);
			if (Number.isFinite(acked) && acked !== offset) {
				// Расхождение = потерянные пакеты. Продолжать бессмысленно: образ будет битым,
				// и это вскроется только на SHA-256 в конце, потратив всю передачу.
				throw new Error(`sync_mismatch:${acked}/${offset}`);
			}
		}

		const upSec = (performance.now() - upStart) / 1000;
		onLog(`передано ${(totalToSend / 1024).toFixed(0)} KB за ${upSec.toFixed(1)} с (${(totalToSend / 1024 / upSec).toFixed(1)} KB/с)`);

		// --- 6. OTA_END: распаковка + запись + сверка хеша + коммит на устройстве ---
		onState({ phase: 'flashing', pct: 0 });
		ctrl.drain();
		await ctrl.send('OTA_END');

		// Ждём финала. OTA_FLASH_PROGRESS / OTA_FLASH* работают как keepalive: пока
		// устройство рапортует прогресс записи, окно ожидания продлевается. Без этого
		// долгая запись мегабайта читается как «таймаут на 99%», хотя всё идёт штатно.
		const deadlineMs = 90000;
		let windowStart = performance.now();
		for (;;) {
			const left = deadlineMs - (performance.now() - windowStart);
			if (left <= 0) throw new Error('verify_timeout');
			const msg = await ctrl.next(left);
			if (msg.kind === 'error') throw new Error(msg.text);
			if (msg.kind === 'success') break;
			if (msg.kind === 'hash_ok') {
				onState({ phase: 'verifying', pct: 100 });
				windowStart = performance.now();
				continue;
			}
			// flash_start / flash_progress / flash_done / finalizing / info — keepalive.
			windowStart = performance.now();
		}

		onState({ phase: 'done', pct: 100 });
		const totalSec = (performance.now() - t0) / 1000;
		onLog(`готово за ${totalSec.toFixed(1)} с — устройство перезагружается`);
		return totalSec;
	} catch (err) {
		// Прервать приём на устройстве, чтобы оно не висело в OTA до таймаута с выходами
		// в safe-state. Best-effort: канал мог уже умереть, и тогда сторож сделает это сам.
		try {
			await ctrl.send('OTA_ABORT');
		} catch {
			/* канал недоступен — сторож тишины в прошивке выведет её из OTA сам */
		}
		throw err;
	} finally {
		ctrl.stop();
		await resumeLiveData();
	}
}

/** Ждать сообщение нужного типа, пропуская информационные; ошибку возвращаем сразу. */
async function waitFor(ctrl: CtrlChannel, kind: string, timeoutMs: number): Promise<CtrlMsg> {
	const deadline = performance.now() + timeoutMs;
	for (;;) {
		const left = deadline - performance.now();
		if (left <= 0) throw new Error('timeout');
		const msg = await ctrl.next(left);
		if (msg.kind === kind || msg.kind === 'error') return msg;
	}
}
