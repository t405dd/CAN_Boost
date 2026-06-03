// Web Bluetooth connection manager for MS3 CAN BC.
// Handles connect, disconnect, auto-reconnect, service/characteristic caching.

import { ALL_SERVICE_UUIDS, BLE_DEVICE_NAME_PREFIX, SVC_LIVE_DATA, SVC_SYSTEM, CHR_ENGINE_DATA, CHR_CURRENT_TIME, CHR_COMMAND } from './uuids';

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

export interface BleConnection {
	device: BluetoothDevice | null;
	server: BluetoothRemoteGATTServer | null;
	services: Map<string, BluetoothRemoteGATTService>;
	characteristics: Map<string, BluetoothRemoteGATTCharacteristic>;
}

let connection: BleConnection = {
	device: null,
	server: null,
	services: new Map(),
	characteristics: new Map()
};

let stateCallback: ((state: ConnectionState) => void) | null = null;
let statusMsgCallback: ((step: string, detail?: string) => void) | null = null;
let liveDataCallback: ((data: DataView) => void) | null = null;
// Пауза live-данных делается ФЛАГОМ, а не stop/startNotifications: повторный
// startNotifications() после stop на Android BLE часто не возвращает нотификации
// (live-данные «умирают» после chunked-чтения конфига). Подписку не трогаем —
// на время передачи просто игнорируем входящие пакеты.
let liveDataPaused = false;
let pinProvider: (() => string) | null = null; // Поставщик PIN для авторизации
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempts = 0;
let connectInProgress = false;
const MAX_RECONNECT_ATTEMPTS = 10;
let pinSentAt = 0; // timestamp когда PIN был успешно отправлен (для детекции отклонения)
let onPinRejectedCallback: (() => void) | null = null;

// --- BLE operation queue: serialize all GATT reads/writes ---
// ESP32 NimBLE can only handle one GATT operation at a time.
// Concurrent reads/writes cause disconnection.
let _bleQueueTail: Promise<unknown> = Promise.resolve();

/** Queue a BLE operation to run sequentially (prevents concurrent GATT access) */
export function queueBleOperation<T>(fn: () => Promise<T>): Promise<T> {
	const prev = _bleQueueTail;
	const result = prev.then(fn, fn); // run even if previous failed
	_bleQueueTail = result.then(() => {}, () => {}); // swallow errors for chain
	return result;
}

export function onStateChange(cb: (state: ConnectionState) => void) {
	stateCallback = cb;
}

export function onStatusMessage(cb: (step: string, detail?: string) => void) {
	statusMsgCallback = cb;
}

export function onLiveData(cb: (data: DataView) => void) {
	liveDataCallback = cb;
}

/** Register a function that returns the current device PIN for auto-auth */
export function setPinProvider(fn: () => string) {
	pinProvider = fn;
}

/** Register callback fired when device rejects the PIN (disconnect shortly after PIN send) */
export function onPinRejected(cb: () => void) {
	onPinRejectedCallback = cb;
}

function setState(state: ConnectionState) {
	stateCallback?.(state);
}

function setStatus(step: string, detail?: string) {
	statusMsgCallback?.(step, detail);
}

/** Request BLE device and connect (filtered by name) */
export async function connect(): Promise<boolean> {
	return connectWithOptions({
		filters: [
			{ namePrefix: BLE_DEVICE_NAME_PREFIX },
			{ services: [SVC_LIVE_DATA] }
		],
		optionalServices: ALL_SERVICE_UUIDS
	});
}

/** Scan all BLE devices (debug mode — no name filter) */
export async function connectScanAll(): Promise<boolean> {
	return connectWithOptions({
		acceptAllDevices: true,
		optionalServices: ALL_SERVICE_UUIDS
	});
}

async function connectWithOptions(options: RequestDeviceOptions): Promise<boolean> {
	try {
		setState('connecting');
		setStatus('selecting_device');
		console.log('[BLE] requestDevice with options:', JSON.stringify(options, null, 2));

		const device = await navigator.bluetooth.requestDevice(options);
		console.log('[BLE] Device selected:', device.name, device.id);
		setStatus('device_selected', device.name ?? undefined);

		device.addEventListener('gattserverdisconnected', onDisconnected);
		connection.device = device;

		return await connectToServer();
	} catch (err) {
		console.error('[BLE] Connection failed:', err);
		setStatus('idle');
		setState('disconnected');
		return false;
	}
}

async function connectToServer(): Promise<boolean> {
	if (!connection.device?.gatt) return false;
	if (connectInProgress) {
		console.warn('[BLE] connectToServer already in progress, skipping');
		return false;
	}
	connectInProgress = true;
	pinSentAt = 0; // сбрасываем при каждой новой попытке подключения

	// Retry GATT connection up to 3 times (Windows BLE cache can cause failures)
	let server: BluetoothRemoteGATTServer | null = null;
	for (let attempt = 1; attempt <= 3; attempt++) {
		try {
			setStatus('gatt_connecting', `${attempt}/3`);
			console.log(`[BLE] GATT connect attempt ${attempt}/3...`);
			server = await connection.device.gatt.connect();
			console.log('[BLE] GATT connected, server:', server.connected);
			break;
		} catch (err: unknown) {
			const errMsg = err instanceof Error ? err.message : String(err);
			console.warn(`[BLE] GATT attempt ${attempt} failed: ${errMsg}`);
			if (errMsg.includes('Connection attempt failed')) {
				console.warn('[BLE] Hint: On Windows, try removing the device from Bluetooth settings, or restart Bluetooth service');
			}
			if (attempt < 3) {
				const delay = attempt * 2000; // 2s, 4s
				setStatus('gatt_retry', `${attempt + 1}/3`);
				console.log(`[BLE] Waiting ${delay}ms before retry...`);
				await new Promise(r => setTimeout(r, delay));
			} else {
				console.error('[BLE] All GATT connection attempts failed');
				connectInProgress = false;
				setStatus('idle');
				setState('disconnected');
				return false;
			}
		}
	}

	if (!server) {
		connectInProgress = false;
		setStatus('idle');
		setState('disconnected');
		return false;
	}

	try {
		connection.server = server;
		connection.services.clear();
		connection.characteristics.clear();

		// Wait for ESP32 to stabilize after GATT connection.
		setStatus('gatt_stabilizing');
		console.log('[BLE] Waiting 0.8s for ESP32 to stabilize...');
		await new Promise(r => setTimeout(r, 800));   // было 1.5s — сокращено, чтобы быстрее доходить до чтений

		// Discover services one-by-one with small delays and timeout
		let found = 0;
		for (const uuid of ALL_SERVICE_UUIDS) {
			// Abort if disconnected during discovery
			if (!connection.server?.connected) {
				console.warn('[BLE] Server disconnected during discovery, aborting');
				connectInProgress = false;
				setState('disconnected');
				return false;
			}
			setStatus('discovering_services', `${found}/${ALL_SERVICE_UUIDS.length}`);
			try {
				const service = await Promise.race([
					connection.server.getPrimaryService(uuid),
					new Promise<never>((_, reject) =>
						setTimeout(() => reject(new Error('timeout')), 5000)
					)
				]);
				connection.services.set(uuid, service);
				found++;
				console.log(`[BLE]   Found service: ${uuid.substring(0, 8)}...`);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				console.warn(`[BLE]   Service ${uuid.substring(0, 8)}... not found (${msg})`);
			}
			await new Promise(r => setTimeout(r, 50));   // было 150мс на сервис — сокращено
		}

		setStatus('discovering_services', `${found}/${ALL_SERVICE_UUIDS.length}`);
		console.log(`[BLE] Discovered ${connection.services.size}/${ALL_SERVICE_UUIDS.length} services`);

		// Subscribe to live data notifications
		setStatus('subscribing_live');
		await subscribeLiveData();

		// Sync time
		setStatus('syncing_time');
		await syncTime();

		// Отправляем app-level PIN для авторизации нового клиента
		setStatus('authenticating');
		await sendAuthPin();

		// Ждём 400мс — прошивка дисконнектит через ~300мс если PIN неверный (запас над окном детекции).
		// Это также даёт Windows время завершить BLE-паринг без ложного срабатывания.
		await new Promise(r => setTimeout(r, 400));

		// Проверяем соединение после отправки PIN
		if (!connection.server?.connected) {
			connectInProgress = false;
			const wasPinSent = pinSentAt > 0;
			pinSentAt = 0;
			if (wasPinSent) {
				// Разрыв сразу после PIN — прошивка отклонила (неверный PIN)
				console.warn('[BLE] PIN rejected by device');
				reconnectAttempts = MAX_RECONNECT_ATTEMPTS;
				onPinRejectedCallback?.();
			} else {
				console.warn('[BLE] Connection lost during setup — aborting');
			}
			setStatus('idle');
			setState('disconnected');
			return false;
		}

		// PIN принят, соединение живое — сбрасываем трекинг
		pinSentAt = 0;
		setStatus('done');
		reconnectAttempts = 0;
		connectInProgress = false;
		setState('connected');
		console.log('[BLE] Connected successfully');
		return true;
	} catch (err) {
		console.error('[BLE] Service discovery failed:', err);
		connectInProgress = false;
		setStatus('idle');
		setState('disconnected');
		return false;
	}
}

async function subscribeLiveData() {
	const service = connection.services.get(SVC_LIVE_DATA);
	if (!service) return;

	try {
		liveDataPaused = false;   // на случай, если прошлая передача оборвалась с паузой
		const char = await service.getCharacteristic(CHR_ENGINE_DATA);
		connection.characteristics.set(CHR_ENGINE_DATA, char);

		char.addEventListener('characteristicvaluechanged', (event: Event) => {
			if (liveDataPaused) return;   // во время chunked-передачи игнорируем пакеты
			const target = event.target as BluetoothRemoteGATTCharacteristic;
			if (target.value) {
				liveDataCallback?.(target.value);
			}
		});

		await char.startNotifications();
		console.log('[BLE] Live data notifications started');
	} catch (err) {
		console.error('[BLE] Failed to subscribe to live data:', err);
	}
}

/** Execute a BLE write with optional retries (delayMs between attempts). */
async function retryBleWrite(fn: () => Promise<void>, label: string, maxAttempts = 1, delayMs = 800): Promise<void> {
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			await fn();
			return;
		} catch (err) {
			if (attempt < maxAttempts) {
				// Не ждать повторов если соединение уже разорвано
				if (!connection.server?.connected) {
					console.warn(`[BLE] ${label}: GATT disconnected — aborting retries`);
					return;
				}
				console.warn(`[BLE] ${label} attempt ${attempt}/${maxAttempts} failed, waiting ${delayMs}ms for pairing...`, err);
				await new Promise(r => setTimeout(r, delayMs));
			} else {
				console.error(`[BLE] ${label} failed after ${maxAttempts} attempts:`, err);
			}
		}
	}
}

/** Send app-level PIN to CHR_COMMAND (cmd 0x0F + ASCII PIN bytes) */
async function sendAuthPin() {
	const pin = pinProvider ? pinProvider() : '1234';
	const service = connection.services.get(SVC_SYSTEM);
	if (!service) {
		console.warn('[BLE] Cannot send PIN: SVC_SYSTEM not found');
		return;
	}
	await retryBleWrite(async () => {
		const char = await service.getCharacteristic(CHR_COMMAND);
		const encoded = new TextEncoder().encode(pin);
		const buf = new Uint8Array(1 + encoded.length);
		buf[0] = 0x0F;
		buf.set(encoded, 1);
		await char.writeValue(buf);
		pinSentAt = Date.now(); // фиксируем момент отправки для детекции отклонения
		console.log('[BLE] Auth PIN sent');
	}, 'sendAuthPin');
}

async function syncTime() {
	const service = connection.services.get(SVC_SYSTEM);
	if (!service) return;

	await retryBleWrite(async () => {
		const char = await service.getCharacteristic(CHR_CURRENT_TIME);
		const timestamp = Math.floor(Date.now() / 1000);
		const buffer = new ArrayBuffer(4);
		new DataView(buffer).setUint32(0, timestamp, true);
		await char.writeValue(buffer);
		console.log('[BLE] Time synced:', timestamp);
	}, 'syncTime');
}

function onDisconnected() {
	console.log('[BLE] Disconnected');
	connection.server = null;
	connection.services.clear();
	connection.characteristics.clear();
	pinSentAt = 0; // PIN-детекция ведётся в connectToServer, здесь только сброс

	if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
		setState('reconnecting');
		const delay = Math.min(1000 * Math.pow(1.5, reconnectAttempts), 15000);
		reconnectAttempts++;
		setStatus('reconnect_waiting', `${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}`);
		console.log(`[BLE] Reconnecting in ${delay}ms (attempt ${reconnectAttempts})`);
		reconnectTimer = setTimeout(attemptReconnect, delay);
	} else {
		setStatus('idle');
		setState('disconnected');
	}
}

async function attemptReconnect() {
	if (!connection.device?.gatt) {
		setStatus('idle');
		setState('disconnected');
		return;
	}

	try {
		await connectToServer();
	} catch {
		onDisconnected();
	}
}

/** Disconnect from device */
export function disconnect() {
	if (reconnectTimer) {
		clearTimeout(reconnectTimer);
		reconnectTimer = null;
	}
	reconnectAttempts = MAX_RECONNECT_ATTEMPTS; // prevent auto-reconnect

	if (connection.device?.gatt?.connected) {
		connection.device.gatt.disconnect();
	}
	connection.device = null;
	connection.server = null;
	connection.services.clear();
	connection.characteristics.clear();
	setStatus('idle');
	setState('disconnected');
}

/** Get a cached characteristic or discover it */
export async function getCharacteristic(
	serviceUuid: string,
	charUuid: string
): Promise<BluetoothRemoteGATTCharacteristic | null> {
	const cached = connection.characteristics.get(charUuid);
	if (cached) return cached;

	const service = connection.services.get(serviceUuid);
	if (!service) return null;

	try {
		const char = await service.getCharacteristic(charUuid);
		connection.characteristics.set(charUuid, char);
		return char;
	} catch {
		return null;
	}
}

/** Read a characteristic value (queued to prevent concurrent GATT access) */
export async function readCharacteristic(
	serviceUuid: string,
	charUuid: string
): Promise<DataView | null> {
	return queueBleOperation(async () => {
		const char = await getCharacteristic(serviceUuid, charUuid);
		if (!char) return null;
		return await char.readValue();
	});
}

/** Write data to a characteristic (queued to prevent concurrent GATT access) */
export async function writeCharacteristic(
	serviceUuid: string,
	charUuid: string,
	data: BufferSource
): Promise<boolean> {
	return queueBleOperation(async () => {
		const char = await getCharacteristic(serviceUuid, charUuid);
		if (!char) return false;
		await char.writeValue(data);
		return true;
	});
}

/** Check if Web Bluetooth is supported */
export function isWebBluetoothSupported(): boolean {
	return typeof navigator !== 'undefined' && 'bluetooth' in navigator;
}

/** Check if currently connected */
export function isConnected(): boolean {
	return connection.device?.gatt?.connected ?? false;
}

/** Pause live data processing (call before chunked transfer).
 *  Флаг, без stopNotifications — см. комментарий у liveDataPaused. */
export async function pauseLiveData(): Promise<void> {
	liveDataPaused = true;
}

/** Resume live data processing (call after chunked transfer). */
export async function resumeLiveData(): Promise<void> {
	liveDataPaused = false;
}

/** Subscribe to notifications on a characteristic */
export async function subscribeCharacteristic(
	serviceUuid: string,
	charUuid: string,
	callback: (value: DataView) => void
): Promise<(() => void) | null> {
	const char = await getCharacteristic(serviceUuid, charUuid);
	if (!char) return null;

	const handler = (event: Event) => {
		const target = event.target as BluetoothRemoteGATTCharacteristic;
		if (target.value) callback(target.value);
	};

	try {
		char.addEventListener('characteristicvaluechanged', handler);
		await char.startNotifications();
		return () => {
			char.removeEventListener('characteristicvaluechanged', handler);
			char.stopNotifications().catch(() => {});
		};
	} catch (err) {
		console.warn('[BLE] Failed to subscribe:', err);
		char.removeEventListener('characteristicvaluechanged', handler);
		return null;
	}
}
