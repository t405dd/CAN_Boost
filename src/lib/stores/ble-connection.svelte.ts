// Reactive BLE connection state using Svelte 5 runes.

import type { ConnectionState } from '$lib/ble/connection';
import { connect as bleConnect, connectScanAll as bleScanAll, disconnect as bleDisconnect, onStateChange, onStatusMessage, isWebBluetoothSupported, setPinProvider, onPinRejected } from '$lib/ble/connection';

export const bleState = $state({
	status: 'disconnected' as ConnectionState,
	supported: false,
	lastError: '' as string,
	/** Current connection step identifier (e.g. 'gatt_connecting', 'discovering_services') */
	statusStep: 'idle' as string,
	/** Extra detail for current step (e.g. '2/3', '5/7') */
	statusDetail: '' as string,
	/** True when device disconnected because PIN was rejected */
	pinRejected: false
});

// Initialize: register callback and check support
if (typeof window !== 'undefined') {
	bleState.supported = isWebBluetoothSupported();
	// Provide PIN from localStorage for auto-auth on connect
	setPinProvider(() => localStorage.getItem('ble_pin') ?? '1234');
	onStateChange((state) => {
		bleState.status = state;
		if (state === 'connected' || state === 'disconnected') {
			bleState.statusStep = state === 'connected' ? 'done' : 'idle';
			bleState.statusDetail = '';
		}
	});
	onStatusMessage((step, detail) => {
		bleState.statusStep = step;
		bleState.statusDetail = detail ?? '';
	});
	onPinRejected(() => {
		bleState.pinRejected = true;
	});
}

export async function connect() {
	bleState.lastError = '';
	bleState.pinRejected = false;
	const ok = await bleConnect();
	if (!ok && bleState.status === 'disconnected') {
		bleState.lastError = 'Connection failed. Check that the device is powered on and nearby.';
	}
}

export async function connectScanAll() {
	bleState.lastError = '';
	bleState.pinRejected = false;
	const ok = await bleScanAll();
	if (!ok && bleState.status === 'disconnected') {
		bleState.lastError = 'Scan failed. No devices found. Try restarting Bluetooth.';
	}
}

export function disconnect() {
	bleDisconnect();
}

/** Save PIN to localStorage and reconnect */
export function submitPin(pin: string) {
	localStorage.setItem('ble_pin', pin);
	bleState.pinRejected = false;
	connect();
}
