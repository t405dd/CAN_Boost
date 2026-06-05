// TypeScript types matching ESP32 firmware data structures.
// These mirror the JSON format used for BLE chunked transfer.

// --- Grid Layout ---

export interface GridCell {
	param_name: string;
	colspan: number;
}

export interface GridRow {
	cells: GridCell[];
}

export interface GridLayout {
	num_columns: number;
	rows: GridRow[];
}

// --- Color Schemes ---

export interface ColorThreshold {
	value: number;
	text_color: number;   // RGB565
	bg_color: number;     // RGB565
	bar_fill_color: number;
	border_color: number;
}

export type WidgetComponent = 'LABEL' | 'BAR' | 'VALUE_UNIT' | 'NONE';

export type BarStyle = 0 | 1 | 2; // SOLID, SEGMENTED, NONE
export type ScaleMode = 0 | 1 | 2 | 3; // OFF, TOP, CENTER, BOTTOM
export type UnitDisplayMode = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface ParameterColorScheme {
	param_name: string;
	default_label_text_color: number;
	default_value_text_color: number;
	default_bg_color: number;
	default_bar_color: number;
	default_bar_track_color: number;
	default_border_color: number;
	bar_show_border: boolean;
	bar_thickness_px: number;
	bar_style: BarStyle;
	show_arrow: boolean;
	scale_display_mode: ScaleMode;
	bar_min_value: number;
	bar_max_value: number;
	value_config_precision: number;
	value_display_char_count: number;
	custom_text_size: number;
	bar_animation_duration_ms: number;
	value_animation_duration_ms: number;
	unit_display_mode: UnitDisplayMode;
	useCustomUnit: boolean;
	customUnit: string;
	layout_components: WidgetComponent[];
	thresholds: [ColorThreshold, ColorThreshold, ColorThreshold];
}

// --- CAN Receive ---

export type CanSignalDataType = 0 | 1 | 2 | 3 | 4 | 5;
// CAN_INT8=0, CAN_UINT8=1, CAN_INT16=2, CAN_UINT16=3, CAN_INT32=4, CAN_UINT32=5

export const CAN_DATA_TYPE_NAMES: Record<CanSignalDataType, string> = {
	0: 'INT8',
	1: 'UINT8',
	2: 'INT16',
	3: 'UINT16',
	4: 'INT32',
	5: 'UINT32'
};

export interface CanSignalConfig {
	signalName: string;
	userLabel: string;
	userUnit: string;
	userPrecision: number;
	isEnabled: boolean;
	startByte: number;
	lengthBytes: number;
	dataType: CanSignalDataType;
	isBigEndian: boolean;
	multiplier: number;
	divider: number;
	offset: number;
	requiresFtoC: boolean;
	requiresVssProcessing: boolean;
}

export interface CanMessageConfig {
	canId: number;
	isExtendedId: boolean;
	expectedDlc: number;
	isEnabled: boolean;
	description: string;
	signals: CanSignalConfig[];
}

// --- CO1 Sender Settings ---

export interface Co1Settings {
	canId: number;             // CAN ID (hex) for CO1 output
	canByteOffset: number;     // Start byte in 8-byte CAN frame (0-6)
	canBigEndian: boolean;     // Byte order: true = Big-endian (MSB first)
	canSendIntervalMs: number; // Send interval in ms
}

// --- CAN Out Tables ---

/** Wire format matching firmware JSON (what BLE sends/receives).
 *  Field names must match can_out_tables_manager.cpp serialization. */
export interface FirmwareCanOutTable {
	tableIdBase: string;
	currentXParamName: string;  // firmware param name, e.g. "CACHE1"
	currentYParamName: string;  // firmware param name, e.g. "CACHE0"
	cols: number;
	rows: number;
	hasYAxis: boolean;
	isEnabled: boolean;
	xAxisValues: number[];
	yAxisValues: number[];
	tableData: number[][];
}

/** PWA internal format for CAN Out tables (converted from firmware format). */
export interface CanOutTable {
	tableIdBase: string;
	xAxisParamType: string;   // PWA param name, e.g. "cache_1"
	yAxisParamType: string;   // PWA param name, e.g. "cache_0"
	numCols: number;
	numRows: number;
	hasYAxis: boolean;
	isEnabled: boolean;
	xAxisValues: number[];
	yAxisValues: number[];
	tableData: number[][];
}

// --- User Parameters ---

export interface UserParameter {
	name: string;
	formula: string;
	description: string;
	unit: string;
	precision: number;
	value_display_char_count: number;
	custom_text_size: number;
	default_label_text_color: number;
	default_value_text_color: number;
	widget_bg_color: number;
	use_custom_widget_bg_color: boolean;
	default_bar_color: number;
	default_bar_track_color: number;
	default_border_color: number;
	bar_show_border: boolean;
	bar_thickness_px: number;
	bar_style: BarStyle;
	show_arrow: boolean;
	bar_scale_display_mode: ScaleMode;
	bar_animation_duration_ms: number;
	value_animation_duration_ms: number;
	unit_display_mode: UnitDisplayMode;
	layout_components: string[];
	thresholds: [ColorThreshold, ColorThreshold, ColorThreshold];
	bar_min_value: number;
	bar_max_value: number;
}

// --- Race Timer ---

export interface RaceTimerConfig {
	isEnabled: boolean;
	name: string;
	startSpeed: number;
	endSpeed: number;
	maxTimeMs: number;
}

export interface RaceDistanceTimerConfig {
	isEnabled: boolean;
	name: string;
	maxTimeMs: number;
	distancesToLogMeters: number[];
}

export interface RaceSettings {
	speed_timers: RaceTimerConfig[];
	distance_timers: RaceDistanceTimerConfig[];
}

// --- Logging ---

export interface LoggingSettings {
	requested_log_duration_min: number;
	preferred_log_format: number; // 0=CSV, 1=MSL
}

export interface DataloggerSettings {
	isEnabled: boolean;
	rpm_threshold: number;
	tps_threshold: number;
	log_stop_delay_seconds: number;
	map_threshold: number;
	pre_trigger_seconds: number;
	log_format: number; // 0=CSV, 1=MSL
}

// --- File Transfer ---

export interface FileEntry {
	name: string;
	size: number;
}

export interface TransferStatus {
	in_progress: boolean;
	progress: number;
}

// --- System ---

export interface DeviceInfo {
	name: string;
	version: string;
	heap: number;
	psram: number;
	uptime: number;
	time?: number;
	bootTime?: number;
	canActive?: boolean;  // драйвер TWAI запущен
	canData?: boolean;    // CAN-данные реально приходят (не таймаут)
	boostEnabled?: boolean; // буст-контроллер включён
	calibrating?: boolean;  // активен режим автокалибровки (g_boostCalibrationActive)
}

// --- Boost Controller ---

export interface BoostControllerSettings {
	enabled: boolean;
	actuatorType: number; // 0=membrane, 1=vacuum, 2=electronic
	canId: number;
	canByteOffset: number;
	canBigEndian: boolean;
	canSendIntervalMs: number;
	kp: number;
	ki: number;
	kd: number;
	iWindupLimit: number;
	dFilterAlpha: number;
	// overboostLimit_kPa — per-map (см. BoostMapMeta), не входит в общие настройки
	knockThreshold_deg: number;
	knockReduction_pct: number;
	canTimeoutMs: number;
	rateLimitPctPerSec: number;
	learnEnabled: boolean;
	learnRate: number;
	learnErrorThreshold: number;
	learnStabilityTimeMs: number;
	mapSignalParam: number;    // DisplayParamType enum integer (e.g. 12 = PARAM_CACHE_SLOT_0)
	rpmSignalParam: number;
	tpsSignalParam: number;
	knockSignalParam: number;
	cltSignalParam: number;    // P7: источник CLT для гейта прогрева (0 = PARAM_NONE = без гейта)
	corr1AxisParam: number;
	corr1YAxisParam: number;
	corr2AxisParam: number;
	corr2YAxisParam: number;
	// Kp/Kd zone learning (controlled by single learnEnabled flag)
	learnKpRate: number;
	learnKdRate: number;
	kpMin: number;   // min Kp (absolute units)
	kpMax: number;   // max Kp (absolute units)
	kdMin: number;   // min Kd (absolute units)
	kdMax: number;   // max Kd (absolute units)
	oscillationThreshold: number;
	oscillationWindowMs: number;
	persistentErrorTimeMs: number;
	persistentErrorMinKpa: number;
	// dRPM/dt transient boost
	transientGain: number;
	dRpmFilterAlpha: number;
	// Phase-based control (SPOOL / PID / OVERBOOST)
	phaseHysteresis: number;   // гистерезис зоны PID, множитель (1.1 = 10%)
	learnBiasRate: number;     // скорость обучения BIAS таблицы (EMA)
	// P7: always-on adaptive
	learnMinClt: number;            // °C: ниже не учим (гейт прогрева; cltSignalParam=NONE → без гейта)
	learnSaveIntervalMin: number;   // мин между авто-сейвами (5..30)
	learnSaveMaxTps: number;        // % TPS: авто-сейв только ниже
}

export interface BoostTable {
	numCols: number;
	numRows: number;
	xAxisValues: number[];
	yAxisValues: number[];
	data: number[][];
}

export interface BoostCorrectionTable {
	numCols: number;
	numRows: number;         // 1 = 1D, >1 = 2D bilinear
	xAxisValues: number[];
	yAxisValues: number[];
	data: number[][];
}

/** Combined PID tables: I-term + Kp/Kd absolute values (from BLE boost_learn) */
export interface BoostPidTables {
	ki: BoostTable;
	kp: BoostTable;
	kd: BoostTable;
}

// --- Boost Maps (4 switchable maps) ---

/** Per-map metadata. The target/corr1/corr2 tables themselves are addressed via
 *  the editMap slot through the existing boost_target / boost_corr characteristics. */
export interface BoostMapMeta {
	name: string;
	overboostLimit_kPa: number;   // per-map hard overboost limit (kPa)
}

/** Wire format of the boost_maps characteristic (mirrors firmware boostMapsToJson). */
export interface BoostMapsState {
	activeMap: number;   // 0..3 — map the controller runs
	editMap: number;     // 0..3 — slot addressed by boost_target / boost_corr chars
	maps: BoostMapMeta[];
	busy?: boolean;      // true while a deferred switch/copy is still running on the device
}

// --- Color Utils ---

/** Convert RGB565 to CSS hex color */
export function rgb565ToHex(rgb565: number): string {
	const r = ((rgb565 >> 11) & 0x1F) << 3;
	const g = ((rgb565 >> 5) & 0x3F) << 2;
	const b = (rgb565 & 0x1F) << 3;
	return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

/** Convert CSS hex color to RGB565 */
export function hexToRgb565(hex: string): number {
	const r = parseInt(hex.slice(1, 3), 16);
	const g = parseInt(hex.slice(3, 5), 16);
	const b = parseInt(hex.slice(5, 7), 16);
	return ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3);
}
