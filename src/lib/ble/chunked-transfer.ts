// Chunked transfer protocol for reading/writing large JSON configs over BLE.
// Implements the protocol defined in firmware ble_chunked_transfer.h
//
// Read flow for large configs:
//   1. PWA reads characteristic → gets CHUNK_HEADER marker (0x80 + 4-byte totalLen)
//   2. PWA subscribes to notifications, then writes BLE_CMD_READ_REQ (0x01)
//   3. Firmware sends data as notifications: CHUNK_HEADER → CHUNK_DATA(s) → CHUNK_END
//   4. PWA assembles chunks, unsubscribes, returns parsed JSON

import {
	BLE_CMD_READ_REQ, BLE_CHUNK_HEADER, BLE_CHUNK_DATA, BLE_CHUNK_END,
	BLE_CMD_WRITE_START, BLE_CMD_WRITE_DATA, BLE_CMD_WRITE_END
} from './uuids';
import { getCharacteristic, queueBleOperation } from './connection';

const BLE_MTU = 512;
// Dynamic timeout: base 10s + ~1s per 10KB for large payloads
function chunkedReadTimeout(expectedLen: number): number {
	return Math.max(15000, 10000 + Math.ceil(expectedLen / 10000) * 1000);
}

// На Android Chrome нотификации часто не идут сразу после startNotifications() (CCCD регистрируется
// с задержкой) — первый notify (header/чанк) теряется и chunked-чтение виснет в таймаут. Поэтому
// ждём перед READ_REQ, а само chunked-чтение при провале повторяем. Это и есть причина, по которой
// boost_settings/can_receive «не дочитывались» на телефоне и UI показывал дефолты.
const CHUNKED_SUBSCRIBE_SETTLE_MS = 300;
// Потеря data-чанка под потоком live-data раньше стоила ПОЛНЫЙ 15-сек таймаут (receivedBytes
// не доходил до totalLen, END тоже терялся → залипание). Теперь потеря детектится сразу (разрыв
// seq) или по бездействию (CHUNKED_INACTIVITY_MS) и ретраится мгновенно — поэтому попыток больше.
const CHUNKED_READ_ATTEMPTS = 4;
// Если за это время не пришло НИ ОДНОГО нового чанка — считаем чтение зависшим (потерян хвост/END)
// и ретраим, не дожидаясь общего таймаута. Это и есть лекарство от «долгой загрузки таблиц».
const CHUNKED_INACTIVITY_MS = 2500;

// Android Chrome часто отклоняет САМ readValue() сразу после коннекта с «GATT operation failed for
// unknown reason» (конфликт с потоком live-нотификаций / неустоявшийся GATT). На десктопе этого нет.
// Поэтому ретраим сам readValue с нарастающей паузой — попадаем в окно между нотификациями.
const READ_VALUE_ATTEMPTS = 5;
async function readValueRetry(char: BluetoothRemoteGATTCharacteristic, label: string): Promise<DataView> {
	let lastErr: unknown;
	for (let i = 0; i < READ_VALUE_ATTEMPTS; i++) {
		try {
			return await char.readValue();
		} catch (e) {
			lastErr = e;
			console.warn(`[BLE Transfer] readValue ${label} попытка ${i + 1}/${READ_VALUE_ATTEMPTS}: ${(e as Error)?.message ?? e}`);
			await new Promise((r) => setTimeout(r, 300 * (i + 1)));   // 300→600→900→1200мс
		}
	}
	throw lastErr;
}

/** Read a JSON config from a BLE characteristic (handles chunked if needed).
 *  Queued to prevent concurrent GATT access that crashes ESP32 NimBLE. */
export async function readJsonConfig<T = unknown>(
	serviceUuid: string,
	charUuid: string
): Promise<T | null> {
	return queueBleOperation(async () => {
		const char = await getCharacteristic(serviceUuid, charUuid);
		if (!char) {
			console.warn('[BLE Transfer] Characteristic not found:', charUuid.substring(0, 8));
			return null;
		}

		console.log(`[BLE Transfer] Reading ${charUuid.substring(0, 8)}...`);

		// Chunked-notify чтения на Android иногда теряют нотификацию → null. Повторяем chunked-путь
		// до CHUNKED_READ_ATTEMPTS раз. Прямое (мелкое) чтение надёжно и возвращается сразу.
		for (let attempt = 1; attempt <= CHUNKED_READ_ATTEMPTS; attempt++) {
			const value = await readValueRetry(char, charUuid.substring(0, 8));
			if (value.byteLength === 0) {
				console.warn('[BLE Transfer] Empty response');
				return null;
			}

			const firstByte = value.getUint8(0);

			// If first byte is CHUNK_HEADER, data is too large for direct read
			if (firstByte === BLE_CHUNK_HEADER && value.byteLength >= 5) {
				const totalLen = value.getUint32(1, true);
				console.log(`[BLE Transfer] Large config (${totalLen} bytes), chunked read (attempt ${attempt}/${CHUNKED_READ_ATTEMPTS})`);
				// Live-данные НЕ ставим на паузу: прошивка их шлёт всё равно (пауза была лишь флагом,
				// скрывавшим пакеты в UI → моргание; канал она не разгружала). Reassembly чанков идёт на
				// другой характеристике, поэтому параллельный live-стрим ему не мешает.
				const result = await readChunkedViaNotify<T>(char, totalLen);
				if (result !== null) return result;
				if (attempt < CHUNKED_READ_ATTEMPTS) {
					console.warn(`[BLE Transfer] Chunked read of ${charUuid.substring(0, 8)} returned null, retrying...`);
					await new Promise((r) => setTimeout(r, 250));
					continue;
				}
				console.error(`[BLE Transfer] Chunked read of ${charUuid.substring(0, 8)} failed after ${CHUNKED_READ_ATTEMPTS} attempts`);
				return null;
			}

			// Small payload — direct JSON
			const text = new TextDecoder().decode(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
			console.log(`[BLE Transfer] Direct read: ${text.length} chars`);
			try {
				return JSON.parse(text) as T;
			} catch (e) {
				console.error('[BLE Transfer] JSON parse error:', e, 'Raw:', text.substring(0, 200));
				return null;
			}
		}
		return null;
	});
}

/** Chunked read via notifications: subscribe → write READ_REQ → collect notifications → unsubscribe */
async function readChunkedViaNotify<T>(
	char: BluetoothRemoteGATTCharacteristic,
	expectedLen: number
): Promise<T | null> {
	return new Promise<T | null>(async (resolve) => {
		const chunks: Uint8Array[] = [];
		let totalLen = expectedLen;
		let resolved = false;

		function finish(result: T | null) {
			if (resolved) return;
			resolved = true;
			clearTimeout(timer);
			clearTimeout(inactTimer);
			char.removeEventListener('characteristicvaluechanged', onNotification);
			char.stopNotifications().catch(() => {});
			resolve(result);
		}

		let receivedBytes = 0;
		let expectedSeq = 0;                              // следующий ожидаемый chunkIndex (детект потери)
		let inactTimer: ReturnType<typeof setTimeout>;

		// Сброс таймера бездействия: любой пришедший notify (header/chunk) продлевает ожидание.
		// Срабатывание = поток чанков оборвался (потерян хвост/END) → ретраим сразу.
		function resetInactivity() {
			clearTimeout(inactTimer);
			inactTimer = setTimeout(() => {
				console.warn(`[BLE Transfer] Stall: нет новых чанков ${CHUNKED_INACTIVITY_MS}ms (получено ${receivedBytes}/${totalLen}, ${chunks.length} чанков) — ретрай`);
				finish(null);
			}, CHUNKED_INACTIVITY_MS);
		}

		// Собрать накопленные чанки в JSON и завершить. Вызывается ЛИБО по приходу всех байт
		// (receivedBytes>=totalLen), ЛИБО по маркеру CHUNK_END — что наступит раньше. На десктопе
		// (WinRT) одиночный 1-байтовый END-notify под потоком live-data часто теряется, поэтому
		// завязываться ТОЛЬКО на END нельзя — иначе чтение виснет в таймаут с уже полными данными.
		function completeAssembly(via: string) {
			const assembled = assembleChunks(chunks);
			const text = new TextDecoder().decode(assembled);
			console.log(`[BLE Transfer] Chunked read complete (${via}): ${text.length} chars, ${chunks.length} chunks`);
			try {
				finish(JSON.parse(text) as T);
			} catch (e) {
				console.error('[BLE Transfer] Chunked JSON parse error:', e);
				finish(null);
			}
		}

		function onNotification(event: Event) {
			const target = event.target as BluetoothRemoteGATTCharacteristic;
			if (!target.value) return;
			resetInactivity();                            // любой notify продлевает окно ожидания
			const view = target.value;
			const cmd = view.getUint8(0);

			if (cmd === BLE_CHUNK_HEADER && view.byteLength >= 5) {
				totalLen = view.getUint32(1, true);
				console.log(`[BLE Transfer] Chunk header: ${totalLen} bytes total`);
			} else if (cmd === BLE_CHUNK_DATA && view.byteLength > 3) {
				// chunkIndex в байтах [1..2] (u16LE). Разрыв последовательности = потерян пакет
				// на линке (notify дропнут под live-data) → не ждём 15с, ретраим немедленно.
				const seq = view.getUint16(1, true);
				if (seq !== expectedSeq) {
					console.warn(`[BLE Transfer] Потерян чанк: ожидался seq ${expectedSeq}, пришёл ${seq} — ретрай`);
					finish(null);
					return;
				}
				expectedSeq = seq + 1;
				const payload = new Uint8Array(
					view.buffer, view.byteOffset + 3, view.byteLength - 3
				);
				chunks.push(new Uint8Array(payload));
				receivedBytes += payload.length;
				// Log progress every 10 chunks
				if (chunks.length % 10 === 0) {
					const pct = totalLen > 0 ? Math.round(receivedBytes * 100 / totalLen) : 0;
					console.log(`[BLE Transfer] Chunk ${chunks.length}: ${receivedBytes}/${totalLen} bytes (${pct}%)`);
				}
				// Все байты получены — собираем СРАЗУ, не дожидаясь END (он может потеряться).
				if (totalLen > 0 && receivedBytes >= totalLen) completeAssembly('all bytes');
			} else if (cmd === BLE_CHUNK_END) {
				completeAssembly('END');
			} else {
				// Might be a direct small notification (firmware sent data as single notify)
				const raw = new Uint8Array(
					view.buffer, view.byteOffset, view.byteLength
				);
				const text = new TextDecoder().decode(raw);
				try {
					finish(JSON.parse(text) as T);
				} catch {
					// Not JSON — could be intermediate data, ignore
				}
			}
		}

		const timeoutMs = chunkedReadTimeout(expectedLen);
		console.log(`[BLE Transfer] Timeout set to ${timeoutMs}ms for ${expectedLen} bytes`);
		const timer = setTimeout(() => {
			console.error(`[BLE Transfer] Chunked read timeout after ${timeoutMs}ms (received ${receivedBytes}/${totalLen} bytes, ${chunks.length} chunks)`);
			finish(null);
		}, timeoutMs);

		try {
			char.addEventListener('characteristicvaluechanged', onNotification);
			await char.startNotifications();

			// Android: даём подписке (CCCD) реально зарегистрироваться, иначе прошивка успеет
			// прислать header раньше, чем браузер начнёт слушать → потеря и таймаут.
			await new Promise((r) => setTimeout(r, CHUNKED_SUBSCRIBE_SETTLE_MS));

			// Send read request → firmware calls sendChunkedData() via notify
			await char.writeValueWithoutResponse(new Uint8Array([BLE_CMD_READ_REQ]));
			console.log('[BLE Transfer] READ_REQ sent, waiting for chunks...');
			resetInactivity();                            // взвести stall-таймер ожидания первого чанка
		} catch (e) {
			console.error('[BLE Transfer] Failed to start chunked read:', e);
			finish(null);
		}
	});
}

function assembleChunks(chunks: Uint8Array[]): Uint8Array {
	let total = 0;
	for (const c of chunks) total += c.length;
	const assembled = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		assembled.set(chunk, offset);
		offset += chunk.length;
	}
	return assembled;
}

/** Write a JSON config to a BLE characteristic (uses chunked if > MTU).
 *  Queued to prevent concurrent GATT access. */
export async function writeJsonConfig(
	serviceUuid: string,
	charUuid: string,
	data: unknown
): Promise<boolean> {
	return queueBleOperation(async () => {
		const char = await getCharacteristic(serviceUuid, charUuid);
		if (!char) return false;

		const json = JSON.stringify(data);
		const encoded = new TextEncoder().encode(json);

		console.log(`[BLE Transfer] Writing ${charUuid.substring(0, 8)}: ${encoded.length} bytes`);

		if (encoded.length < BLE_MTU - 3) {
			await char.writeValue(encoded);
			return true;
		}

		return await writeChunked(char, encoded);
	});
}

async function writeChunked(
	char: BluetoothRemoteGATTCharacteristic,
	data: Uint8Array
): Promise<boolean> {
	const chunkSize = BLE_MTU - 8;

	console.log(`[BLE Transfer] Chunked write: ${data.length} bytes`);

	// START command — with response to ensure device is ready
	const startCmd = new Uint8Array(5);
	startCmd[0] = BLE_CMD_WRITE_START;
	new DataView(startCmd.buffer).setUint32(1, data.length, true);
	await char.writeValue(startCmd);

	// DATA chunks — without response for speed
	let offset = 0;
	let chunkIndex = 0;
	while (offset < data.length) {
		const remaining = data.length - offset;
		const payloadSize = Math.min(remaining, chunkSize);
		const chunk = new Uint8Array(3 + payloadSize);
		chunk[0] = BLE_CMD_WRITE_DATA;
		chunk[1] = chunkIndex & 0xFF;
		chunk[2] = (chunkIndex >> 8) & 0xFF;
		chunk.set(data.subarray(offset, offset + payloadSize), 3);
		await char.writeValueWithoutResponse(chunk);
		offset += payloadSize;
		chunkIndex++;
	}

	// END command — with response to ensure all data processed
	await char.writeValue(new Uint8Array([BLE_CMD_WRITE_END]));
	console.log(`[BLE Transfer] Chunked write complete: ${chunkIndex} chunks`);
	return true;
}

/** Read a single uint8 value (queued) */
export async function readUint8(
	serviceUuid: string,
	charUuid: string
): Promise<number | null> {
	return queueBleOperation(async () => {
		const char = await getCharacteristic(serviceUuid, charUuid);
		if (!char) return null;
		const value = await readValueRetry(char, charUuid.substring(0, 8));
		if (value.byteLength === 0) return null;
		return value.getUint8(0);
	});
}

/** Write a single uint8 value (queued) */
export async function writeUint8(
	serviceUuid: string,
	charUuid: string,
	value: number
): Promise<boolean> {
	return queueBleOperation(async () => {
		const char = await getCharacteristic(serviceUuid, charUuid);
		if (!char) return false;
		await char.writeValue(new Uint8Array([value & 0xFF]));
		return true;
	});
}
