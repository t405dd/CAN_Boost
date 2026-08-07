// Binary protocol decoder for live data from ESP32.
// Packet format: [seq:u8][count:u8][{param_type:u8, value:f32LE}...]

import { USER_PARAM_BLE_OFFSET } from './uuids';
import type { CanMessageConfig } from '$lib/types/config';

export interface LiveDataEntry {
	paramType: number;
	value: number;
}

export interface LiveDataPacket {
	sequence: number;
	entries: LiveDataEntry[];
}

/** Decode a binary live data notification into structured data */
export function decodeLiveDataPacket(buffer: DataView): LiveDataPacket {
	const sequence = buffer.getUint8(0);
	const count = buffer.getUint8(1);
	const entries: LiveDataEntry[] = [];

	let offset = 2;
	for (let i = 0; i < count && offset + 5 <= buffer.byteLength; i++) {
		const paramType = buffer.getUint8(offset);
		const value = buffer.getFloat32(offset + 1, true); // little-endian
		entries.push({ paramType, value });
		offset += 5;
	}

	return { sequence, entries };
}

/** Check if a param_type represents a user parameter */
export function isUserParam(paramType: number): boolean {
	return paramType >= USER_PARAM_BLE_OFFSET;
}

/** Get user parameter index from param_type */
export function getUserParamIndex(paramType: number): number {
	return paramType - USER_PARAM_BLE_OFFSET;
}

// DisplayParamType enum values — ДОЛЖНЫ совпадать с firmware/can_boost/constants.h.
// Enum (headless CAN_Boost, без LPS/FPS/ACCEL):
//   NONE(0), TIME(1), CO1(2), BST_OUT(3)..BST_dRPM(14), CACHE_SLOT_0(15)..CACHE_SLOT_39(54)
export const PARAM_CACHE_SLOT_START = 15;
// Состояние бустконтроллера — добавлен в firmware ПОСЛЕ cache-слотов (enum 55).
export const PARAM_BOOST_STATE = 55;
// Флаг «цель недостижима» (актуатор на упоре + ошибка вне порога) — enum 56.
export const PARAM_BOOST_UNREACHABLE = 56;
// feedforward (duty из таблицы BIAS) — enum 57. Считает прошивка (единый источник правды).
export const PARAM_BOOST_BIAS = 57;
// Производные сигналов (сглаженные в прошивке) — enum 58/59. RPMdot = BST_dRPM (14).
export const PARAM_MAP_DOT = 58;
export const PARAM_TPS_DOT = 59;
// Промежуточные результаты таблиц редактируемого OUT-канала (телеметрия) — enum 60..63.
export const PARAM_CO_MUL_1 = 60;
export const PARAM_CO_MUL_2 = 61;
export const PARAM_CO_MUL_3 = 62;
export const PARAM_CO_BASE = 63;
// Вычисляемые каналы OUT2..4 — enum 64..66 (OUT1 = исторический enum 2 «CO1»).
export const PARAM_OUT2 = 64;
export const PARAM_OUT3 = 65;
export const PARAM_OUT4 = 66;
// EWG (электронный вестгейт, сервопривод) — телеметрия, enum 67..73.
export const PARAM_EWG_TARGET_POS = 67;
export const PARAM_EWG_ACTUAL_POS = 68;
export const PARAM_EWG_ERROR = 69;
export const PARAM_EWG_DUTY = 70;
export const PARAM_EWG_CURRENT = 71;
export const PARAM_EWG_STATE = 72;
export const PARAM_EWG_AUTOTUNE = 73;
// IgnCorr (карта коррекции УОЗ) — enum 74..76. Значение + результаты обеих таблиц.
export const PARAM_IGN_CORR = 74;
export const PARAM_IGN_CORR_BASE = 75;
export const PARAM_IGN_CORR_MUL = 76;

export const PARAM_NAMES: Record<number, string> = {
	0:  'NONE',
	1:  'TIME',
	2:  'TBL1',   // бывш. CANOUT/CO1/OUT1: выход перемноженных таблиц 1 (wire-enum 2 / wire-имя 'CO1' неизменны)
	3:  'BST_OUT',
	4:  'BST_TGT',
	5:  'BST_ERR',
	6:  'BST_P',
	7:  'BST_I',
	8:  'BST_D',
	9:  'BST_KP',
	10: 'BST_KD',
	11: 'BST_KPZ',
	12: 'BST_KDZ',
	13: 'BST_TRN',
	14: 'BST_dRPM',
};

// PARAM_CACHE_SLOT_0..39 = enum 15..54
for (let i = 0; i < 40; i++) {
	PARAM_NAMES[PARAM_CACHE_SLOT_START + i] = `CACHE${i}`;
}
PARAM_NAMES[PARAM_BOOST_STATE] = 'BST_ST';
PARAM_NAMES[PARAM_BOOST_UNREACHABLE] = 'BST_UNR';
PARAM_NAMES[PARAM_BOOST_BIAS] = 'BST_BIAS';
PARAM_NAMES[PARAM_MAP_DOT] = 'MAPdot';
PARAM_NAMES[PARAM_TPS_DOT] = 'TPSdot';
PARAM_NAMES[PARAM_CO_MUL_1] = 'COmul1';
PARAM_NAMES[PARAM_CO_MUL_2] = 'COmul2';
PARAM_NAMES[PARAM_CO_MUL_3] = 'COmul3';
PARAM_NAMES[PARAM_CO_BASE] = 'COBase';
PARAM_NAMES[PARAM_OUT2] = 'TBL2';   // wire-имя 'OUT2' неизменно (см. param-mapping)
PARAM_NAMES[PARAM_OUT3] = 'TBL3';
PARAM_NAMES[PARAM_OUT4] = 'TBL4';
PARAM_NAMES[PARAM_EWG_TARGET_POS] = 'EWG_TGT';
PARAM_NAMES[PARAM_EWG_ACTUAL_POS] = 'EWG_POS';
PARAM_NAMES[PARAM_EWG_ERROR] = 'EWG_ERR';
PARAM_NAMES[PARAM_EWG_DUTY] = 'EWG_DTY';
PARAM_NAMES[PARAM_EWG_CURRENT] = 'EWG_AMP';
PARAM_NAMES[PARAM_EWG_STATE] = 'EWG_ST';
PARAM_NAMES[PARAM_EWG_AUTOTUNE] = 'EWG_AT';
PARAM_NAMES[PARAM_IGN_CORR] = 'IGN_CORR';
PARAM_NAMES[PARAM_IGN_CORR_BASE] = 'IGN_BASE';
PARAM_NAMES[PARAM_IGN_CORR_MUL] = 'IGN_MUL';

/**
 * Build a cache-slot-index → user label map from CAN receive config.
 * Replicates the firmware slot assignment in init_utils.cpp:
 * iterate enabled messages → enabled signals (non-empty name) → assign slot 0, 1, 2, ...
 * ЗАТЕМ — включённые локальные входы (ADC/импульс) занимают следующие слоты
 * (та же раскладка, что в прошивке: локальные ПОСЛЕ CAN-сигналов).
 */
export function buildCacheSlotLabels(
	messages: CanMessageConfig[],
	localInputs?: { en: boolean; name: string; label?: string }[]
): string[] {
	const labels: string[] = new Array(40).fill('');
	let slot = 0;
	for (const msg of messages) {
		if (!msg.isEnabled) continue;
		for (const sig of msg.signals) {
			if (!sig.isEnabled || !sig.signalName) continue;
			if (slot >= 40) break;
			labels[slot] = sig.userLabel || sig.signalName;
			slot++;
		}
		if (slot >= 40) break;
	}
	if (localInputs) {
		for (const li of localInputs) {
			if (!li.en || !li.name) continue;
			if (slot >= 40) break;
			labels[slot] = li.label || li.name;
			slot++;
		}
	}
	return labels;
}
