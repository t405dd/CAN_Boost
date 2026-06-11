// Лёгкий стор системного состояния устройства (DeviceInfo): canEnabled управляет
// видимостью CAN-вкладок в навигации (standalone-режим прячет CAN-receive/transmit).

import { readJsonConfig } from '$lib/ble/chunked-transfer';
import { SVC_SYSTEM, CHR_DEVICE_INFO } from '$lib/ble/uuids';
import type { DeviceInfo } from '$lib/types/config';

export const deviceState = $state({
	// null = ещё не читали (вкладки показываем — не прячем по незнанию)
	canEnabled: null as boolean | null,
	info: null as DeviceInfo | null
});

export async function loadDeviceState(): Promise<boolean> {
	try {
		const info = await readJsonConfig<DeviceInfo>(SVC_SYSTEM, CHR_DEVICE_INFO);
		if (!info) return false;
		deviceState.info = info;
		// Старая прошивка без поля canEnabled → считаем CAN включённым
		deviceState.canEnabled = info.canEnabled !== false;
		return true;
	} catch (e) {
		console.warn('[DeviceState] load failed:', e);
		return false;
	}
}

export function resetDeviceState(): void {
	deviceState.canEnabled = null;
	deviceState.info = null;
}
