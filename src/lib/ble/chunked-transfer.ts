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

		const value = await char.readValue();
		if (value.byteLength === 0) {
			console.warn('[BLE Transfer] Empty response');
			return null;
		}

		const firstByte = value.getUint8(0);

		// If first byte is CHUNK_HEADER, data is too large for direct read
		if (firstByte === BLE_CHUNK_HEADER && value.byteLength >= 5) {
			const totalLen = value.getUint32(1, true);
			console.log(`[BLE Transfer] Large config detected (${totalLen} bytes), using chunked read`);
			// Live-данные НЕ ставим на паузу: прошивка их шлёт всё равно (пауза была лишь флагом,
			// скрывавшим пакеты в UI → моргание; канал она не разгружала). Reassembly чанков идёт на
			// другой характеристике, поэтому параллельный live-стрим ему не мешает.
			return await readChunkedViaNotify<T>(char, totalLen);
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
			char.removeEventListener('characteristicvaluechanged', onNotification);
			char.stopNotifications().catch(() => {});
			resolve(result);
		}

		let receivedBytes = 0;

		function onNotification(event: Event) {
			const target = event.target as BluetoothRemoteGATTCharacteristic;
			if (!target.value) return;
			const view = target.value;
			const cmd = view.getUint8(0);

			if (cmd === BLE_CHUNK_HEADER && view.byteLength >= 5) {
				totalLen = view.getUint32(1, true);
				console.log(`[BLE Transfer] Chunk header: ${totalLen} bytes total`);
			} else if (cmd === BLE_CHUNK_DATA && view.byteLength > 3) {
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
			} else if (cmd === BLE_CHUNK_END) {
				const assembled = assembleChunks(chunks);
				const text = new TextDecoder().decode(assembled);
				console.log(`[BLE Transfer] Chunked read complete: ${text.length} chars, ${chunks.length} chunks`);
				try {
					finish(JSON.parse(text) as T);
				} catch (e) {
					console.error('[BLE Transfer] Chunked JSON parse error:', e);
					finish(null);
				}
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

			// Send read request → firmware calls sendChunkedData() via notify
			await char.writeValueWithoutResponse(new Uint8Array([BLE_CMD_READ_REQ]));
			console.log('[BLE Transfer] READ_REQ sent, waiting for chunks...');
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
		const value = await char.readValue();
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
