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
	role: number;   // SignalRole: 0=нет, 1=MAP, 2=RPM, 3=TPS, 4=Knock, 5=CLT, 6=APP(педаль). Источник сигналов буста/производных.
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
	enabled: boolean;          // CO1 master switch: false = nothing sent to CAN, hidden in header
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
	canEnabled?: boolean; // переключатель CAN (NVS): false = standalone, PWA прячет CAN-вкладки
	canActive?: boolean;  // драйвер TWAI запущен
	canData?: boolean;    // CAN-данные реально приходят (не таймаут)
	boostEnabled?: boolean; // буст-контроллер включён
	calibrating?: boolean;  // активен режим автокалибровки (g_boostCalibrationActive)
	built?: string;         // дата/время компиляции прошивки (__DATE__ __TIME__)
	// OTA: есть ли второй app-раздел. false = устройство залито старой однораздельной
	// таблицей, обновление по воздуху физически невозможно до однократной прошивки по USB.
	otaSupported?: boolean;
	otaMaxSize?: number;    // размер целевого раздела, байт (предел размера образа)
	partition?: string;     // метка активного раздела (app0/app1) — видно, куда шьёмся
	licensed?: boolean;     // устройство активировано (ключ в NVS совпал с MAC)
	trialLeft?: number;     // секунд триала осталось (0 = активировано или триал истёк)
}

// --- Активация устройства (характеристика CHR_LICENSE) ---
export interface LicenseStatus {
	mac: string;           // MAC чипа "AA:BB:CC:DD:EE:FF" — по нему выдаётся ключ
	licensed: boolean;
	trialLeft: number;     // секунд полного функционала осталось
	boostAllowed: boolean; // управление наддувом разрешено прямо сейчас (активно или триал)
	trialSec: number;      // длительность триала в прошивке, с
	key?: string;          // 64-hex ключ; прошивка отдаёт только активированному устройству
}

// --- Локальные входы (ADC/импульсные) — wire-формат local_inputs.cpp ---
export interface LocalInputConfig {
	en: boolean;
	type: number;      // 0 = ANALOG, 1 = PULSE
	pin: number;       // GPIO (-1 = не задан); ANALOG: только ADC1 (GPIO1..10)
	name: string;      // имя сигнала (lowercase, уникально) — имя в кэше
	label: string;
	unit: string;
	prec: number;
	role: number;      // SignalRole (0 = нет)
	// ANALOG: калибровка в вольтах ДАТЧИКА (до делителя)
	div: number;       // Vpin/Vsensor (0.667 для делителя 5В→3.3В)
	v1: number; val1: number;
	v2: number; val2: number;
	vmin: number; vmax: number;
	// PULSE: value = частота(Гц) × mult
	mult: number;
	minUs: number;
	toMs: number;
	// live-поля (только чтение, прошивка добавляет при read)
	liveVolts?: number;
	liveValue?: number;
	slot?: number;     // -1 = не разложен
}

// --- Физические ШИМ-выходы — wire-формат outputs.cpp ---
export interface PhysOutputConfig {
	en: boolean;
	pin: number;
	src: string;       // имя параметра-источника ("BST_OUT", "CO1", имя сигнала, "CACHEn")
	freq: number;      // Гц
	inMin: number; inMax: number;   // диапазон источника → 0..100% duty
	invert: boolean;
	dutyMin: number; dutyMax: number;
	safe: number;      // duty при невалидном источнике и на старте
	staleMs: number;
	liveDuty?: number;
	liveSource?: number;
}

// --- EWG: электронный вестгейт (сервопривод BTS7960). Ключи 1:1 с ewg_servo.cpp. ---
export interface EwgConfig {
	en: boolean;
	rpwm: number; lpwm: number; enpin: number;   // GPIO драйвера (-1 = не задан)
	freq: number; invDir: boolean;
	src: string; inMin: number; inMax: number; invSp: boolean; staleMs: number;
	// датчик положения (потенциометр на ADC1, 2-точечная калибровка вольты→%)
	posPin: number; posDiv: number;
	pv1: number; pp1: number; pv2: number; pp2: number;
	pvmin: number; pvmax: number; posEma: number;
	// токовый сенс
	curPin: number; curDiv: number; curV0: number; curApV: number; curLim: number; curEma: number;
	// позиционный PID
	kp: number; ki: number; kd: number; iwind: number; dalpha: number;
	// поведение серво
	deadband: number; minOpen: number; minClose: number; maxDuty: number; slew: number;
	ff: number[];   // spring-feedforward по ходу (MAX_EWG_FF_POINTS точек)
	// клин / безопасность
	stallA: number; stallMs: number; stallMin: number;
	safePos: number; faultRel: number; home: boolean;
	// тепловая перекалибровка
	adClosed: boolean; adOpen: boolean; recalMap: number; recalTps: number; recalRate: number;
	// кэш модели (справочно, пишет автотюн)
	idKv: number; idTheta: number; idSigma: number;
	// live-поля (read добавляет прошивка)
	livePos?: number; liveTgt?: number; liveCur?: number; liveVolts?: number;
	liveDuty?: number; liveState?: number; liveAt?: number;
}

// --- Сводка вычисляемых каналов OUT1..4 (out_channels) ---
export interface OutChannelInfo {
	enabled: boolean;
	canId: number;
	canByteOffset: number;
	canBigEndian: boolean;
	canSendIntervalMs: number;
	value?: number;    // live-значение канала
}
export interface OutChannelsConfig {
	edit: number;
	numChannels: number;
	channels: OutChannelInfo[];
}

// --- CAN-трансляция параметра в шину (tx_signals) ---
// Маршрут «значение параметра → CAN-кадр»: источник задаётся firmware-именем
// (CACHEn/BST_OUT/OUT1..4/имя сигнала). Главная цель — вывести локальные GPIO-входы
// устройства в шину. Кодировка: uint16 = round(value × scale), кламп 0..65535.
export interface SignalTxConfig {
	en: boolean;
	src: string;               // firmware-имя источника ('' = нет)
	canId: number;
	canByteOffset: number;
	canBigEndian: boolean;
	scale: number;             // множитель value → uint16
	canSendIntervalMs: number;
	value?: number;            // live: сырое значение источника (read добавляет прошивка)
}

// --- IgnCorr: карта коррекции УОЗ (ign_corr) ---
// Знак — как у приёмника (MS3 datax1.SpkAdj): ПЛЮС = опережение, МИНУС = откат.
// Таблицы карты живут в отдельной характеристике (ign_tables) и используют тот же
// wire-формат, что can_out_tables → общий адаптер firmwareToCanOutTable.
//   mode 1 (MS3 SpkAdj, дефолт) — штатная команда MegaSquirt: int16 (град×10) пишется
//     в datax1.SpkAdj кадром MSG_CMD с расширенным ID. canId/canByteOffset/canBigEndian/
//     scale/zeroOffset НЕ участвуют — адресация из ms3To/ms3From/ms3Table/ms3Offset.
//   mode 0 (generic) — произвольный кадр: raw = round(град × scale + zeroOffset),
//     кодировка по canSigned (int16 / uint16). Для MS3 1.5.2+ это штатный путь: в
//     «CAN Receiving» есть приёмник SpkAdj, слот настраивается типом B2S.
export const IGN_CORR_MODE_GENERIC = 0;
export const IGN_CORR_MODE_MS3_SPKADJ = 1;

export interface IgnCorrSettings {
	en: boolean;               // мастер-выключатель карты (выкл → поправка 0 + догашивание нулями)
	canEn: boolean;            // слать значение в CAN
	mode: number;              // IGN_CORR_MODE_*
	canId: number;             // generic
	canByteOffset: number;     // generic: 0..6
	canBigEndian: boolean;     // generic
	canSigned: boolean;        // generic: true = int16 (знаковое, штатно для MS3 1.5.2+), false = uint16
	canSendIntervalMs: number;
	scale: number;             // generic: градусы → raw
	zeroOffset: number;        // generic: смещение нуля в raw (uint16 без знака)
	maxDeg: number;            // верхняя граница поправки (> 0 = разрешить опережение)
	minDeg: number;            // нижняя граница поправки (< 0 = разрешить откат)
	ms3To: number;             // CAN ID ЭБУ (настройка mycan_id в MS3, дефолт 0)
	ms3From: number;           // наш ID на шине MS (1..14)
	ms3Table: number;          // таблица (7 = datax1)
	ms3Offset: number;         // смещение SpkAdj в таблице (632)
	// live-поля (read добавляет прошивка) — единый источник правды для UI
	value?: number;            // итоговая поправка, град (+ опережение / − откат)
	base?: number;             // результат базовой таблицы, град
	mul?: number;              // результат таблицы-множителя, %
	ms3Id?: number;            // готовый 29-битный ID команды (для сверки снифером)
}

// --- Сводка ролей сигналов (signal_roles) ---
export interface SignalRoleInfo {
	role: number;          // SignalRole 1..6
	canParam: number;      // enum-слот CAN-источника (0 = нет)
	localParam: number;    // enum-слот локального источника (0 = нет)
	preferLocal: number;   // 0 = CAN primary, 1 = локальный primary
	active: number;        // 0 = нет, 1 = CAN, 2 = локальный
	canName?: string;
	localName?: string;
	value?: number;        // live-значение разрешённого источника
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
	biasOnly: boolean;     // режим «только BIAS» (open-loop): P/I/D отключены
	// overboostLimit_kPa — per-map (см. BoostMapMeta), не входит в общие настройки
	knockThreshold_deg: number;
	knockReduction_pct: number;
	canTimeoutMs: number;
	rateLimitPctPerSec: number;
	learnEnabled: boolean;
	learnBias: boolean;    // P7: обучать BIAS (feedforward: P5 + P0)
	learnGains: boolean;   // P7: обучать Kp/Kd (динамика регулятора)
	learnDeltaMap: boolean; // P8: автотюн ΔMAP (порог SPOOL→PID) по перелёту
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
	phaseRateLead: number;     // с: упреждение SPOOL→PID по скорости роста MAP (delta += k·dMAP/dt)
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
	auth: BoostTable;   // PID authority limit по зонам (%duty), кламп |P+I+D|. Не масштабируется ×100.
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
