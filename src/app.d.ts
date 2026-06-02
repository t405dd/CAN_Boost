// Подключаем глобальные типы Web Bluetooth API (BluetoothDevice, navigator.bluetooth и т.д.).
// Директива /// <reference> работает в обход ограничивающего "types"-массива из сгенерированного tsconfig.
/// <reference types="web-bluetooth" />

declare global {
	namespace App {
		// interface Error {}
		// interface Locals {}
		// interface PageData {}
		// interface Platform {}
	}
}

export {};
