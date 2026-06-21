// Central parameter mapping utility.
// Converts between firmware param names, DisplayParamType enum integers, and PWA display names.
// Must match firmware constants.h DisplayParamType enum and global_vars.cpp allParameters[].

// --- System parameters (enum 0-14) ---
// ДОЛЖНЫ совпадать с firmware/can_boost/constants.h (enum DisplayParamType)
// и global_vars.cpp (allParameters[].name). Без LPS/FPS/ACCEL (headless CAN_Boost).
// ПОРЯДОК массива = порядок пунктов в дропдаунах (enum хранится в значениях, поэтому
// перестановка безопасна). Семейство OUT1..4 держим вместе: OUT1 = исторический 'CO1'
// (enum 2), OUT2..4 — поздние добавки (enum 64..66).
const SYSTEM_PARAMS: [string, string, number][] = [
	// [firmwareName, pwaName, enumValue]
	['NONE', 'none', 0],
	['TIME', 'time', 1],
	['CO1', 'co1', 2],
	['OUT2', 'out2', 64],
	['OUT3', 'out3', 65],
	['OUT4', 'out4', 66],
	['BST_OUT', 'boost_output', 3],
	['BST_TGT', 'boost_target', 4],
	['BST_ERR', 'boost_error', 5],
	['BST_P', 'boost_p', 6],
	['BST_I', 'boost_i', 7],
	['BST_D', 'boost_d', 8],
	['BST_KP', 'boost_eff_kp', 9],
	['BST_KD', 'boost_eff_kd', 10],
	['BST_KPZ', 'boost_kp_mult', 11],
	['BST_KDZ', 'boost_kd_mult', 12],
	['BST_TRN', 'boost_transient', 13],
	['BST_dRPM', 'boost_drpm', 14],   // RPMdot
	// Производные сигналов (enum 58/59 — после cache-слотов и STATE/UNREACHABLE/BIAS).
	// Доступны как оси таблиц коррекции. ДОЛЖНЫ совпадать с constants.h.
	['MAPdot', 'map_dot', 58],
	['TPSdot', 'tps_dot', 59],
	// Промежуточные результаты таблиц редактируемого OUT-канала (enum 60..63) — телеметрия.
	['COmul1', 'co_mul_1', 60],
	['COmul2', 'co_mul_2', 61],
	['COmul3', 'co_mul_3', 62],
	['COBase', 'co_base', 63],
	// EWG (электронный вестгейт, сервопривод) — телеметрия, enum 67..73.
	['EWG_TGT', 'ewg_target_pos', 67],
	['EWG_POS', 'ewg_actual_pos', 68],
	['EWG_ERR', 'ewg_error', 69],
	['EWG_DTY', 'ewg_duty', 70],
	['EWG_AMP', 'ewg_current', 71],
	['EWG_ST', 'ewg_state', 72],
	['EWG_AT', 'ewg_autotune', 73],
];

// --- Cache slots (enum 15-54) ---
const CACHE_SLOT_BASE = 15; // PARAM_CACHE_SLOT_0 = 15
const NUM_CACHE_SLOTS = 40;

// Firmware name → enum value
export const FIRMWARE_PARAM_ENUM: Record<string, number> = {};
// Enum value → firmware name
export const ENUM_TO_FIRMWARE_NAME: Record<number, string> = {};
// PWA name → firmware name
export const PWA_TO_FIRMWARE: Record<string, string> = {};
// Firmware name → PWA name
export const FIRMWARE_TO_PWA: Record<string, string> = {};

// Populate system params
for (const [fw, pwa, val] of SYSTEM_PARAMS) {
	FIRMWARE_PARAM_ENUM[fw] = val;
	ENUM_TO_FIRMWARE_NAME[val] = fw;
	PWA_TO_FIRMWARE[pwa] = fw;
	FIRMWARE_TO_PWA[fw] = pwa;
}

// Populate cache slots: firmware="CACHE0", pwa="cache_0", enum=12+i
for (let i = 0; i < NUM_CACHE_SLOTS; i++) {
	const fw = `CACHE${i}`;
	const pwa = `cache_${i}`;
	const val = CACHE_SLOT_BASE + i;
	FIRMWARE_PARAM_ENUM[fw] = val;
	ENUM_TO_FIRMWARE_NAME[val] = fw;
	PWA_TO_FIRMWARE[pwa] = fw;
	FIRMWARE_TO_PWA[fw] = pwa;
}

// --- Conversion functions ---

/** Enum integer → firmware name (e.g., 12 → "CACHE0") */
export function enumToFirmwareName(enumVal: number): string {
	return ENUM_TO_FIRMWARE_NAME[enumVal] ?? 'NONE';
}

/** Firmware name → enum integer (e.g., "CACHE0" → 12) */
export function firmwareNameToEnum(name: string): number {
	return FIRMWARE_PARAM_ENUM[name] ?? 0;
}

/** PWA name → firmware name (e.g., "cache_0" → "CACHE0") */
export function pwaNameToFirmwareName(pwaName: string): string {
	return PWA_TO_FIRMWARE[pwaName] ?? 'NONE';
}

/** Firmware name → PWA name (e.g., "CACHE0" → "cache_0") */
export function firmwareNameToPwaName(firmwareName: string): string {
	return FIRMWARE_TO_PWA[firmwareName] ?? 'none';
}

/** Enum integer → PWA name (e.g., 12 → "cache_0") */
export function enumToPwaName(enumVal: number): string {
	return firmwareNameToPwaName(enumToFirmwareName(enumVal));
}

/** PWA name → enum integer (e.g., "cache_0" → 12) */
export function pwaNameToEnum(pwaName: string): number {
	return firmwareNameToEnum(pwaNameToFirmwareName(pwaName));
}

/** A signal with F→C conversion enabled is decoded to Celsius by the firmware
 *  (can_handler.cpp), so its unit must never read °F. Normalizes a possibly-stale
 *  °F unit (from a config saved before the catalog was corrected) to °C. */
export function normalizeTempUnit(unit: string, requiresFtoC: boolean): string {
	return requiresFtoC && unit.includes('°F') ? unit.replace('°F', '°C') : unit;
}

/** Get all param entries as array for dropdowns: [{enumVal, firmwareName, pwaName}] */
export function allParamEntries(): { enumVal: number; firmwareName: string; pwaName: string }[] {
	const result: { enumVal: number; firmwareName: string; pwaName: string }[] = [];
	for (const [fw, pwa, val] of SYSTEM_PARAMS) {
		result.push({ enumVal: val, firmwareName: fw, pwaName: pwa });
	}
	for (let i = 0; i < NUM_CACHE_SLOTS; i++) {
		result.push({
			enumVal: CACHE_SLOT_BASE + i,
			firmwareName: `CACHE${i}`,
			pwaName: `cache_${i}`
		});
	}
	return result;
}
