<script lang="ts">
	import { readJsonConfig, writeJsonConfig, writeUint8 } from '$lib/ble/chunked-transfer';
	import { bleState } from '$lib/stores/ble-connection.svelte';
	import { SVC_BOOST, CHR_BOOST_SETTINGS, CHR_BOOST_TARGET, CHR_BOOST_CORR, CHR_BOOST_LEARN, CHR_BOOST_BIAS, CHR_BOOST_DELTA_MAP, CHR_BOOST_LEARN_DELTA,
		SVC_SYSTEM, CHR_COMMAND, CMD_BOOST_CAL_START, CMD_BOOST_CAL_SAVE, CMD_BOOST_CAL_DISCARD } from '$lib/ble/uuids';
	import { subscribeCharacteristic } from '$lib/ble/connection';
	import type { BoostControllerSettings, BoostTable, BoostCorrectionTable, BoostPidTables } from '$lib/types/config';
	import { boostMaps, loadBoostMaps, saveBoostMapsMeta, copyBoostMapFrom } from '$lib/stores/boost-maps.svelte';
	import { t } from '$lib/i18n/index.svelte';
	import TableEditor from '$lib/components/TableEditor.svelte';
	import { resizeTable } from '$lib/components/table-editor/resize';
	import ConnectPrompt from '$lib/components/ConnectPrompt.svelte';
	import { allParamEntries, enumToFirmwareName, enumToPwaName } from '$lib/utils/param-mapping';
	import { loadSignalLabels, getCacheSlotDisplayName, getParamShortName, signalLabels } from '$lib/stores/signal-labels.svelte';
	import { liveData } from '$lib/stores/live-data.svelte';
	import { PARAM_CACHE_SLOT_START } from '$lib/ble/protocol';
	import HelpTip from '$lib/components/HelpTip.svelte';

	const ACTUATOR_TYPES = [
		{ value: 0, key: 'boost.membrane' as const },
		{ value: 1, key: 'boost.vacuum' as const },
		{ value: 2, key: 'boost.electronic' as const }
	];

	// --- State ---
	let settings = $state<BoostControllerSettings>(defaultSettings());
	let targetTable = $state<BoostTable>(defaultTargetTable());
	let corr1 = $state<BoostCorrectionTable>(defaultCorrTable());
	let corr2 = $state<BoostCorrectionTable>(defaultCorrTable());
	let learnTables = $state<BoostPidTables>(defaultLearnTables());
	let biasTable = $state<BoostTable>(defaultBiasTable());
	let deltaMapTable = $state<BoostCorrectionTable>(defaultDeltaMapTable());

	// --- Карты буста: состояние в общем сторе $lib/stores/boost-maps (шарится с шапкой PWA). ---
	// Плоская (НЕ $state) переменная: $effect тогда зависит только от boostMaps.reloadEpoch (без самопетли).
	let lastReloadEpoch = 0;   // отслеживаем boostMaps.reloadEpoch → перечитка таблиц после switch/copy

	let loading = $state(false);
	let saving = $state(false);
	let statusMsg = $state('');
	let activeSection = $state<string | null>(null);

	// --- Режим калибровки (обучение на лету). На дисплее это были кнопки на TFT;
	//     здесь — команды по BLE (CHR_COMMAND 0x20/0x21/0x22). ---
	let calibrating = $state(false);
	let calStatus = $state('');

	let isConnected = $derived(bleState.status === 'connected');
	// Get short param name from enum value (for axis labels)
	function enumParamShortName(enumVal: number): string {
		const pwaName = enumToPwaName(enumVal);
		if (pwaName) return getParamShortName(pwaName);
		return enumToFirmwareName(enumVal);
	}
	// Подпись пункта в дропдауне выбора параметра: cache-слот → понятное имя сигнала
	// (RPM/MAP/…), системный параметр → его firmware-имя.
	function paramOptionLabel(enumVal: number): string {
		return enumVal >= PARAM_CACHE_SLOT_START
			? getCacheSlotDisplayName(enumVal - PARAM_CACHE_SLOT_START)
			: enumToFirmwareName(enumVal);
	}
	// Опции дропдаунов: системные + ТОЛЬКО замапленные cache-слоты (с подписью),
	// чтобы не показывать пустые cache0…cache39.
	let paramOptions = $derived(
		allParamEntries().filter(p =>
			p.enumVal < PARAM_CACHE_SLOT_START || signalLabels[p.enumVal - PARAM_CACHE_SLOT_START] !== undefined
		)
	);

	// --- Live cursor: current operating point on the tables ---
	// Returns the current live value of a parameter by its enum id (0 = NONE → none).
	function liveVal(enumVal: number | undefined): number | undefined {
		if (!enumVal) return undefined;
		return liveData.params[enumVal]?.value;
	}
	// Engine axes shared by Target / Learn / Bias / DeltaMap tables.
	let liveRpm = $derived(liveVal(settings.rpmSignalParam));
	let liveTps = $derived(liveVal(settings.tpsSignalParam));
	let liveMap = $derived(liveVal(settings.mapSignalParam));


	// --- 2D array wrappers for TableEditor ---
	let targetData = $derived.by(() => {
		const d: number[][] = [];
		for (let r = 0; r < targetTable.numRows; r++) {
			d.push(targetTable.data[r] ? [...targetTable.data[r]] : Array(targetTable.numCols).fill(100));
		}
		return d;
	});

	let learnKiData = $derived.by(() => {
		const t = learnTables.ki;
		const d: number[][] = [];
		for (let r = 0; r < t.numRows; r++) {
			d.push(t.data[r] ? [...t.data[r]] : Array(t.numCols).fill(50));
		}
		return d;
	});
	let learnKpMultData = $derived.by(() => {
		const t = learnTables.kp;
		const d: number[][] = [];
		for (let r = 0; r < t.numRows; r++) {
			d.push(t.data[r] ? [...t.data[r]] : Array(t.numCols).fill(100));
		}
		return d;
	});
	let learnKdMultData = $derived.by(() => {
		const t = learnTables.kd;
		const d: number[][] = [];
		for (let r = 0; r < t.numRows; r++) {
			d.push(t.data[r] ? [...t.data[r]] : Array(t.numCols).fill(100));
		}
		return d;
	});


	function showStatus(msg: string, durationMs = 3000) {
		statusMsg = msg;
		setTimeout(() => { statusMsg = ''; }, durationMs);
	}

	// --- Defaults ---
	function defaultSettings(): BoostControllerSettings {
		return {
			enabled: false,
			actuatorType: 0,
			canId: 0x26A,
			canByteOffset: 0,
			canBigEndian: true,
			canSendIntervalMs: 50,
			kp: 2.0, ki: 0.5, kd: 0.3,
			iWindupLimit: 50.0,
			dFilterAlpha: 0.2,
			knockThreshold_deg: 2.0,
			knockReduction_pct: 15.0,
			canTimeoutMs: 500.0,
			rateLimitPctPerSec: 200.0,
			learnEnabled: true,
			learnRate: 0.05,
			learnErrorThreshold: 5.0,
			learnStabilityTimeMs: 2000.0,
			mapSignalParam: 15,    // PARAM_CACHE_SLOT_0 = cache slot 0 (map). База cache-слотов = 15!
			rpmSignalParam: 16,    // PARAM_CACHE_SLOT_1 = cache slot 1 (rpm)
			tpsSignalParam: 18,    // PARAM_CACHE_SLOT_3 = cache slot 3 (tps)
			knockSignalParam: 0,   // PARAM_NONE
			corr1AxisParam: 0,
			corr1YAxisParam: 0,
			corr2AxisParam: 0,
			corr2YAxisParam: 0,
			learnKpRate: 0.05,
			learnKdRate: 0.05,
			kpMin: 0.1,
			kpMax: 20.0,
			kdMin: 0.0,
			kdMax: 10.0,
			oscillationThreshold: 3,
			oscillationWindowMs: 1000.0,
			persistentErrorTimeMs: 3000.0,
			persistentErrorMinKpa: 3.0,
			transientGain: 0.5,
			dRpmFilterAlpha: 0.1,
			phaseHysteresis: 1.1,
			learnBiasRate: 0.05
		};
	}

	function defaultBiasTable(): BoostTable {
		const cols = 8, rows = 8;
		const xAxis = [1000, 1500, 2000, 3000, 4000, 5000, 6000, 8000];
		const yAxis = [0, 30, 60, 90, 120, 150, 180, 210];
		const data = Array.from({ length: rows }, () => Array(cols).fill(50));
		return { numCols: cols, numRows: rows, xAxisValues: xAxis, yAxisValues: yAxis, data };
	}

	function defaultDeltaMapTable(): BoostCorrectionTable {
		return {
			numCols: 8,
			numRows: 1,
			xAxisValues: [1000, 1500, 2000, 3000, 4000, 5000, 6000, 8000],
			yAxisValues: [],
			data: [[30, 35, 40, 50, 58, 65, 68, 70]]
		};
	}

	function defaultTargetTable(): BoostTable {
		const cols = 12, rows = 12;
		const xAxis = [500, 1000, 1500, 2000, 2500, 3000, 3500, 4000, 4500, 5000, 5500, 6000];
		const yAxis = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 95, 100];
		const data = Array.from({ length: rows }, () => Array(cols).fill(100));
		return { numCols: cols, numRows: rows, xAxisValues: xAxis, yAxisValues: yAxis, data };
	}

	function defaultCorrTable(): BoostCorrectionTable {
		return {
			numCols: 12,
			numRows: 8,
			xAxisValues: [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 95, 100],
			yAxisValues: [0, 15, 30, 45, 60, 75, 90, 105],
			data: Array.from({ length: 8 }, () => Array(12).fill(100))
		};
	}

	function defaultLearnTable(fillValue: number = 50): BoostTable {
		const cols = 12, rows = 12;
		const xAxis = [500, 1000, 1500, 2000, 2500, 3000, 3500, 4000, 4500, 5000, 5500, 6000];
		const yAxis = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 95, 100];
		const data = Array.from({ length: rows }, () => Array(cols).fill(fillValue));
		return { numCols: cols, numRows: rows, xAxisValues: xAxis, yAxisValues: yAxis, data };
	}

	function defaultLearnTables(): BoostPidTables {
		return {
			ki: defaultLearnTable(50),
			kp: defaultLearnTable(2.0),
			kd: defaultLearnTable(0.3)
		};
	}

	// --- Lazy load by section ---
	// Settings load on connect (small, fast → верхние контролы/чекбоксы появляются
	// сразу). Таблицы грузятся только при раскрытии секции — раньше всё (включая
	// ~49 КБ Ki/Kp/Kd) качалось разом через сериализованную GATT-очередь и держало
	// UI, пока не докачается последняя таблица.
	let loaded = $state({ target: false, corr: false, learn: false, bias: false, delta: false });
	let loadingSection = $state<string | null>(null);

	async function loadSettings() {
		const s = await readJsonConfig<BoostControllerSettings>(SVC_BOOST, CHR_BOOST_SETTINGS);
		if (s) settings = s;
	}
	// Перечитать таблицы открытой секции (после switch/copy карты — в т.ч. инициированного из шапки).
	async function reloadOpenSectionTables() {
		loaded.target = false;   // target/corr теперь адресуют новый/обновлённый слот
		loaded.corr = false;
		if (activeSection) await ensureSectionData(activeSection);
	}
	async function loadTarget() {
		const tgt = await readJsonConfig<BoostTable>(SVC_BOOST, CHR_BOOST_TARGET);
		if (tgt) targetTable = tgt;
		loaded.target = true;
	}
	async function loadCorr() {
		const corrs = await readJsonConfig<BoostCorrectionTable[]>(SVC_BOOST, CHR_BOOST_CORR);
		if (corrs && corrs.length >= 2) { corr1 = corrs[0]; corr2 = corrs[1]; }
		loaded.corr = true;
	}
	async function loadLearn() {
		const learn = await readJsonConfig<BoostPidTables>(SVC_BOOST, CHR_BOOST_LEARN);
		if (learn) {
			if (learn.ki) learnTables = learn;            // новый формат { ki, kp, kd }
			else learnTables = {                          // legacy: одна таблица (I-term)
				ki: learn as unknown as BoostTable,
				kp: defaultLearnTable(2.0),
				kd: defaultLearnTable(0.3)
			};
		}
		loaded.learn = true;
		// Таблица открыта во время калибровки впервые → зафиксировать базлайн (для оценки изменения).
		if (calibrating && !hlBase.ki) { snapBaseline('ki'); snapBaseline('kp'); snapBaseline('kd'); }
	}
	async function loadBias() {
		const bias = await readJsonConfig<BoostTable>(SVC_BOOST, CHR_BOOST_BIAS);
		if (bias) biasTable = bias;
		loaded.bias = true;
		if (calibrating && !hlBase.bias) snapBaseline('bias');
	}
	async function loadDelta() {
		const delta = await readJsonConfig<BoostCorrectionTable>(SVC_BOOST, CHR_BOOST_DELTA_MAP);
		if (delta) deltaMapTable = delta;
		loaded.delta = true;
	}

	// Загрузить данные секции, если ещё не загружены (по первому раскрытию).
	async function ensureSectionData(id: string) {
		const need =
			(id === 'target' && !loaded.target) ? loadTarget :
			((id === 'corr1' || id === 'corr2') && !loaded.corr) ? loadCorr :
			(id === 'learnTable' && !loaded.learn) ? loadLearn :
			(id === 'biasTable' && !loaded.bias) ? loadBias :
			(id === 'deltaMap' && !loaded.delta) ? loadDelta : null;
		if (!need) return;
		loadingSection = id;
		try {
			await need();
		} catch (e) {
			showStatus(t('canRx.loadFailed') + ': ' + (e as Error).message);
		} finally {
			loadingSection = null;
		}
	}


	// После калибровки — освежить настройки и обученные таблицы (если уже открыты).
	async function reloadAfterCalibration() {
		await loadSettings();
		if (loaded.learn) await loadLearn();
		if (loaded.bias) await loadBias();
		if (loaded.delta) await loadDelta();
	}

	// --- «Восстановить из Flash»: перечитать данные секции с устройства, затерев несохранённые правки.
	//     Рядом с каждой кнопкой «Сохранить на устройство». ---
	async function restoreFromFlash(loadFn: () => Promise<unknown>) {
		loading = true;
		statusMsg = '';
		try {
			await loadFn();
			showStatus(t('common.restoredFromFlash'));
		} catch (e) {
			showStatus(t('canRx.loadFailed') + ': ' + (e as Error).message);
		} finally {
			loading = false;
		}
	}
	const restoreSettings = () => restoreFromFlash(loadSettings);
	const restoreTarget   = () => restoreFromFlash(loadTarget);
	const restoreCorr     = () => restoreFromFlash(loadCorr);
	const restoreBias     = () => restoreFromFlash(loadBias);
	const restoreDelta    = () => restoreFromFlash(loadDelta);
	const restoreMaps     = () => restoreFromFlash(loadBoostMaps);

	async function saveSettings() {
		saving = true;
		try {
			const ok = await writeJsonConfig(SVC_BOOST, CHR_BOOST_SETTINGS, settings);
			showStatus(ok ? t('canRx.savedOk') : t('canRx.saveFailed'));
		} catch (e) {
			showStatus(t('canRx.saveFailed') + ': ' + (e as Error).message);
		} finally {
			saving = false;
		}
	}

	// --- Карты буста: всё через общий стор (boostMaps). Тап = одно нажатие: активна + персист + edit.
	//     Перечитку открытой таблицы делает $effect по boostMaps.reloadEpoch (ниже) — работает и при
	//     переключении из шапки PWA. Здесь — лишь тонкие обёртки со статусом/подтверждением. ---
	async function saveMapsMeta() {
		const ok = await saveBoostMapsMeta();
		showStatus(ok ? t('canRx.savedOk') : t('canRx.saveFailed'));
	}
	async function copyMapFrom(src: number) {
		if (!confirm(t('boost.fillFromConfirm'))) return;
		const ok = await copyBoostMapFrom(src);
		showStatus(ok ? t('canRx.savedOk') : t('canRx.saveFailed'));
	}

	async function saveTargetTable() {
		saving = true;
		try {
			const ok = await writeJsonConfig(SVC_BOOST, CHR_BOOST_TARGET, targetTable);
			showStatus(ok ? t('canRx.savedOk') : t('canRx.saveFailed'));
		} catch (e) {
			showStatus(t('canRx.saveFailed') + ': ' + (e as Error).message);
		} finally {
			saving = false;
		}
	}

	async function saveCorrTables() {
		saving = true;
		try {
			const ok = await writeJsonConfig(SVC_BOOST, CHR_BOOST_CORR, [corr1, corr2]);
			showStatus(ok ? t('canRx.savedOk') : t('canRx.saveFailed'));
		} catch (e) {
			showStatus(t('canRx.saveFailed') + ': ' + (e as Error).message);
		} finally {
			saving = false;
		}
	}

	async function resetLearnTable() {
		if (!confirm(t('boost.resetLearnConfirm'))) return;
		saving = true;
		try {
			const ok = await writeJsonConfig(SVC_BOOST, CHR_BOOST_LEARN, 'reset');
			if (ok) {
				learnTables = defaultLearnTables();
				showStatus(t('canRx.savedOk'));
			} else {
				showStatus(t('canRx.saveFailed'));
			}
		} catch (e) {
			showStatus(t('canRx.saveFailed') + ': ' + (e as Error).message);
		} finally {
			saving = false;
		}
	}

	async function saveBiasTable() {
		saving = true;
		try {
			const ok = await writeJsonConfig(SVC_BOOST, CHR_BOOST_BIAS, biasTable);
			showStatus(ok ? t('canRx.savedOk') : t('canRx.saveFailed'));
		} catch (e) {
			showStatus(t('canRx.saveFailed') + ': ' + (e as Error).message);
		} finally {
			saving = false;
		}
	}

	async function saveDeltaMapTable() {
		saving = true;
		try {
			const ok = await writeJsonConfig(SVC_BOOST, CHR_BOOST_DELTA_MAP, deltaMapTable);
			showStatus(ok ? t('canRx.savedOk') : t('canRx.saveFailed'));
		} catch (e) {
			showStatus(t('canRx.saveFailed') + ': ' + (e as Error).message);
		} finally {
			saving = false;
		}
	}

	// --- Подсветка изменённых при обучении ячеек: показывает СУММАРНОЕ изменение коэффициента
	//     относительно значения на старте калибровки (рост → зелёный, падение → красный,
	//     плотность ∝ величине). Цвета держатся всю калибровку и ПРОПАДАЮТ при «Сохранить»/«Отменить»
	//     (сброс базлайна) — чтобы оценить, на сколько изменились коэффициенты перед записью. ---
	const HL_FLOOR = 0.15;   // минимальная видимость любого изменения
	// |суммарное изменение| → полная плотность (свой масштаб на таблицу; легко крутится)
	const HL_SCALE = { ki: 15, kp: 3, kd: 1.5, bias: 25 } as const;
	type HlKey = keyof typeof HL_SCALE;

	// Базлайн = снимок значений на старте калибровки (или при первой загрузке таблицы в калибровке).
	let hlBase = $state<Record<HlKey, number[][] | null>>({ ki: null, kp: null, kd: null, bias: null });

	function snapBaseline(key: HlKey) {
		const data = key === 'bias' ? biasTable.data : learnTables[key].data;
		hlBase[key] = data.map((r) => (r ? r.slice() : []));   // глубокая копия
	}
	function clearBaselines() {
		hlBase = { ki: null, kp: null, kd: null, bias: null };   // base=null → подсветка пропадает
	}
	// Сетка интенсивностей = (текущее − базлайн), нормированная. base=null → пусто (нет цветов).
	function netGrid(data: number[][], base: number[][] | null, scale: number): number[][] {
		if (!base) return [];
		const out: number[][] = [];
		for (let r = 0; r < data.length; r++) {
			const drow = data[r];
			if (!drow) continue;
			const brow = base[r];
			const orow: number[] = [];
			for (let c = 0; c < drow.length; c++) {
				const b = brow?.[c];
				const net = b === undefined ? 0 : drow[c] - b;
				orow[c] = net === 0 ? 0 : Math.sign(net) * Math.max(HL_FLOOR, Math.min(1, Math.abs(net) / scale));
			}
			out[r] = orow;
		}
		return out;
	}
	// Реактивно: при изменении ячеек (дельты обучения) ИЛИ базлайна — пересчёт и перерисовка.
	let hlKi = $derived.by(() => netGrid(learnTables.ki.data, hlBase.ki, HL_SCALE.ki));
	let hlKp = $derived.by(() => netGrid(learnTables.kp.data, hlBase.kp, HL_SCALE.kp));
	let hlKd = $derived.by(() => netGrid(learnTables.kd.data, hlBase.kd, HL_SCALE.kd));
	let hlBias = $derived.by(() => netGrid(biasTable.data, hlBase.bias, HL_SCALE.bias));

	// --- Live-дельты обучения: устройство шлёт notify ТОЛЬКО с изменёнными ячейками
	//     (tableId,row,col,value), без перекачки целых таблиц и без паузы live-данных. ---
	let learnDeltaUnsub: (() => void) | null = null;
	function applyLearnDelta(view: DataView) {
		if (view.byteLength < 1) return;
		const count = view.getUint8(0);
		let off = 1;
		for (let i = 0; i < count && off + 7 <= view.byteLength; i++) {
			const tableId = view.getUint8(off);
			const row = view.getUint8(off + 1);
			const col = view.getUint8(off + 2);
			const value = view.getFloat32(off + 3, true); // LE, мирроринг buildBoostLearnDeltaPacket
			off += 7;
			// 0=Ki, 1=Kp, 2=Kd, 3=BIAS — должно совпадать с BOOST_LEARN_ID_* в прошивке
			const key: HlKey | null = tableId === 0 ? 'ki' : tableId === 1 ? 'kp'
				: tableId === 2 ? 'kd' : tableId === 3 ? 'bias' : null;
			if (!key) continue;
			const tbl = key === 'bias' ? biasTable : learnTables[key];
			if (!tbl?.data || row >= tbl.data.length || col >= (tbl.data[row]?.length ?? 0)) continue;
			tbl.data[row][col] = value;   // мутация $state → перерисует значение И подсветку (derived hl* = текущее−базлайн)
		}
	}

	// --- Калибровка (обучение на лету) через CHR_COMMAND ---
	async function startCalibration() {
		try {
			await writeUint8(SVC_SYSTEM, CHR_COMMAND, CMD_BOOST_CAL_START);
			calibrating = true;
			// Снимаем базлайн ВСЕХ обучаемых таблиц (Ki/Kp/Kd + BIAS) на старте = последнее сохранённое.
			// Грузим их разом (один раз), чтобы потом ходить по таблицам по одной и видеть суммарное
			// изменение КАЖДОЙ от начала калибровки, а не от момента её открытия.
			clearBaselines();
			calStatus = t('boost.calBaselining');
			await loadLearn();   // Ki/Kp/Kd (+ snapBaseline внутри: calibrating && базлайн пуст)
			await loadBias();    // BIAS
			calStatus = t('boost.calStarted');
		} catch (e) {
			calStatus = (e as Error).message;
		}
		setTimeout(() => calStatus = '', 3000);
	}

	async function saveCalibration() {
		try {
			await writeUint8(SVC_SYSTEM, CHR_COMMAND, CMD_BOOST_CAL_SAVE);
			calibrating = false;
			clearBaselines();   // сохранили в контроллер → цвета дельт пропадают
			calStatus = t('boost.calSaved');
			await reloadAfterCalibration();  // перечитать обученные таблицы с устройства
		} catch (e) {
			calStatus = (e as Error).message;
		}
		setTimeout(() => calStatus = '', 3000);
	}

	async function discardCalibration() {
		try {
			await writeUint8(SVC_SYSTEM, CHR_COMMAND, CMD_BOOST_CAL_DISCARD);
			calibrating = false;
			clearBaselines();   // отменили → цвета дельт пропадают
			calStatus = t('boost.calDiscarded');
			await reloadAfterCalibration();
		} catch (e) {
			calStatus = (e as Error).message;
		}
		setTimeout(() => calStatus = '', 3000);
	}

	// --- Data change callbacks ---
	function onTargetDataChange(data: number[][]) {
		targetTable.data = data;
	}

	function onTargetAxisChange(axis: 'x' | 'y', values: number[]) {
		if (axis === 'x') targetTable.xAxisValues = values;
		else targetTable.yAxisValues = values;
	}

	function onCorr1DataChange(data: number[][]) {
		corr1.data = data;
	}

	function onCorr1AxisChange(axis: 'x' | 'y', values: number[]) {
		if (axis === 'x') corr1.xAxisValues = values;
		else corr1.yAxisValues = values;
	}

	function onCorr2DataChange(data: number[][]) {
		corr2.data = data;
	}

	function onCorr2AxisChange(axis: 'x' | 'y', values: number[]) {
		if (axis === 'x') corr2.xAxisValues = values;
		else corr2.yAxisValues = values;
	}

	function onBiasDataChange(data: number[][]) {
		biasTable.data = data;
	}

	function onBiasAxisChange(axis: 'x' | 'y', values: number[]) {
		if (axis === 'x') biasTable.xAxisValues = values;
		else biasTable.yAxisValues = values;
	}

	function onDeltaMapDataChange(data: number[][]) {
		deltaMapTable.data = data;
	}

	function onDeltaMapAxisChange(_axis: 'x' | 'y', values: number[]) {
		deltaMapTable.xAxisValues = values;
	}

	// --- Table resize (rows × cols). 1 row = 1D, >=2 = 2D. fill = value for new cells. ---
	function onTargetResize(rows: number, cols: number) {
		targetTable = resizeTable(targetTable, rows, cols, 100);
	}
	function onCorr1Resize(rows: number, cols: number) {
		corr1 = resizeTable(corr1, rows, cols, 100);
	}
	function onCorr2Resize(rows: number, cols: number) {
		corr2 = resizeTable(corr2, rows, cols, 100);
	}
	function onBiasResize(rows: number, cols: number) {
		biasTable = resizeTable(biasTable, rows, cols, 50);
	}
	function onDeltaMapResize(_rows: number, cols: number) {
		deltaMapTable = resizeTable(deltaMapTable, 1, cols, 40); // DeltaMAP всегда 1D
	}

	function toggleSection(id: string) {
		activeSection = activeSection === id ? null : id;
		if (activeSection === id && isConnected) ensureSectionData(id);
	}

	// --- CAN ID formatting ---
	function formatCanId(id: number): string {
		return '0x' + id.toString(16).toUpperCase();
	}

	function parseCanId(str: string): number {
		const hex = str.replace(/^0x/i, '');
		const val = parseInt(hex, 16);
		return isNaN(val) ? 0x26A : val;
	}

	// --- Auto-load on connect ---
	let initialLoadDone = $state(false);

	$effect(() => {
		if (isConnected && !initialLoadDone) {
			// Только настройки сразу (быстро) — таблицы лениво по раскрытию секций.
			loaded = { target: false, corr: false, learn: false, bias: false, delta: false };
			loadSettings();
			if (!boostMaps.loaded) loadBoostMaps();   // обычно карты уже загрузила шапка (+layout) при connect
			loadSignalLabels(); // Load CAN Receive config for human-readable names
			if (activeSection) ensureSectionData(activeSection);
			// Подписка на live-дельты обучения (приходят только во время калибровки).
			if (!learnDeltaUnsub) {
				subscribeCharacteristic(SVC_BOOST, CHR_BOOST_LEARN_DELTA, applyLearnDelta)
					.then((u) => { learnDeltaUnsub = u; });
			}
			initialLoadDone = true;
		}
		if (!isConnected) {
			initialLoadDone = false;
			if (learnDeltaUnsub) { learnDeltaUnsub(); learnDeltaUnsub = null; }
			clearBaselines();   // подсветка дельт не переживает разрыв связи
		}
	});

	// Карта переключена/скопирована где угодно (в т.ч. из шапки PWA) → стор бампает reloadEpoch.
	// Перечитываем открытую таблицу edit-слота. Гард по lastReloadEpoch → без лишних перезагрузок.
	$effect(() => {
		const e = boostMaps.reloadEpoch;
		if (e !== lastReloadEpoch) {
			lastReloadEpoch = e;
			reloadOpenSectionTables();
		}
	});
</script>

<div class="space-y-3">
	<div class="text-xs text-[var(--color-dash-text-dim)] uppercase tracking-wider">{t('boost.title')}</div>

	{#if bleState.status !== 'connected'}
		<ConnectPrompt />
	{:else}
		<!-- Сниппет «Восстановить из Flash»: ставится рядом с каждой кнопкой «Сохранить на устройство»
		     (кнопки inline-block → встают в ряд). Перечитывает секцию с устройства, затирая правки. -->
		{#snippet restoreBtn(onRestore: () => void)}
			<button onclick={onRestore} disabled={saving || loading}
				class="px-2 py-1 text-[10px] rounded bg-[var(--color-dash-border)]/40 text-[var(--color-dash-text-dim)] hover:text-[var(--color-dash-text)] hover:bg-[var(--color-dash-border)]/60 transition-colors disabled:opacity-40">
				{loading ? t('common.loading') : t('common.restoreFromFlash')}
			</button>
		{/snippet}

		<!-- Action bar (статус + индикатор загрузки секции) -->
		<div class="flex items-center gap-2 flex-wrap empty:hidden">
			{#if loadingSection}
				<span class="text-xs text-[var(--color-dash-accent)] inline-flex items-center gap-1.5">
					<span class="w-3 h-3 rounded-full border-2 border-[var(--color-dash-border)] border-t-[var(--color-dash-accent)] animate-spin"></span>
					{t('common.loading')}
				</span>
			{/if}
			{#if statusMsg}
				<span class="text-xs text-[var(--color-dash-text-dim)] ml-auto">{statusMsg}</span>
			{/if}
		</div>

		<!-- Калибровка (обучение Ki/Kp/Kd + BIAS на лету) -->
		<section class="rounded-lg border p-3 space-y-2 {calibrating ? 'bg-[var(--color-dash-warn)]/10 border-[var(--color-dash-warn)]/40' : 'bg-[var(--color-dash-card)] border-[var(--color-dash-border)]/50'}">
			<div class="flex items-center justify-between">
				<span class="text-xs uppercase tracking-wider inline-flex items-center gap-1 {calibrating ? 'text-[var(--color-dash-warn)] font-bold' : 'text-[var(--color-dash-text-dim)]'}">
					{t('boost.calibration')}
					{#if calibrating}<span class="w-2 h-2 rounded-full bg-[var(--color-dash-warn)] animate-pulse"></span>{/if}
				</span>
				{#if calStatus}<span class="text-[10px] text-[var(--color-dash-text-dim)]">{calStatus}</span>{/if}
			</div>
			<p class="text-[10px] text-[var(--color-dash-text-dim)]">{t('boost.calibrationHint')}</p>
				<p class="text-[10px] text-[var(--color-dash-text-dim)] italic">{t('boost.calibrationShared')}</p>
				{#if calibrating}<p class="text-[10px] text-[var(--color-dash-accent)]">{t('boost.calLiveUpdate')}</p>{/if}
			<div class="flex items-center gap-2 flex-wrap">
				{#if !calibrating}
					<button onclick={startCalibration}
						class="px-3 py-1.5 text-xs rounded font-bold bg-[var(--color-dash-warn)]/15 text-[var(--color-dash-warn)] border border-[var(--color-dash-warn)]/30 hover:bg-[var(--color-dash-warn)]/25 transition-colors">
						{t('boost.calStart')}
					</button>
				{:else}
					<button onclick={saveCalibration}
						class="px-3 py-1.5 text-xs rounded font-bold bg-[var(--color-dash-success)]/15 text-[var(--color-dash-success)] border border-[var(--color-dash-success)]/30 hover:bg-[var(--color-dash-success)]/25 transition-colors">
						{t('boost.calSave')}
					</button>
					<button onclick={discardCalibration}
						class="px-3 py-1.5 text-xs rounded bg-[var(--color-dash-border)]/50 text-[var(--color-dash-text-dim)] hover:bg-[var(--color-dash-border)] transition-colors">
						{t('boost.calDiscard')}
					</button>
				{/if}
				<button onclick={resetLearnTable} disabled={saving}
					class="px-3 py-1.5 text-xs rounded bg-[var(--color-dash-danger)]/10 text-[var(--color-dash-danger)] border border-[var(--color-dash-danger)]/20 hover:bg-[var(--color-dash-danger)]/20 transition-colors disabled:opacity-40 ml-auto">
					{t('boost.calResetLearn')}
				</button>
			</div>
		</section>

		<!-- 1. Включить бустконтроллер + актуатор + CAN-выход (аккордеон) -->
		<section class="rounded-lg bg-[var(--color-dash-card)] border border-[var(--color-dash-border)]/50">
			<button class="w-full flex items-center justify-between p-3" onclick={() => toggleSection('enable')}>
				<span class="text-xs font-bold text-[var(--color-dash-text)] inline-flex items-center gap-1.5">
					{t('boost.enable')}<HelpTip key="help.boost.enable" />
					{#if settings.enabled}<span class="w-2 h-2 rounded-full bg-[var(--color-dash-success)]"></span>{/if}
				</span>
				<span class="text-xs text-[var(--color-dash-text-dim)]">{activeSection === 'enable' ? '−' : '+'}</span>
			</button>
			{#if activeSection === 'enable'}
				<div class="px-3 pb-3 space-y-3">
					<div class="flex items-center justify-between">
						<label class="flex items-center gap-2 cursor-pointer">
							<input type="checkbox" bind:checked={settings.enabled} class="accent-[var(--color-dash-accent)]" />
							<span class="text-xs font-bold text-[var(--color-dash-text)] inline-flex items-center gap-0.5">{t('boost.enable')}<HelpTip key="help.boost.enable" /></span>
						</label>
						<button onclick={saveSettings} disabled={saving}
							class="px-2 py-1 text-[10px] rounded bg-[var(--color-dash-success)]/15 text-[var(--color-dash-success)] hover:bg-[var(--color-dash-success)]/25 transition-colors disabled:opacity-40">
							{saving ? t('common.saving') : t('common.saveToDevice')}
						</button>
						{@render restoreBtn(restoreSettings)}
					</div>

			<div class="flex items-center gap-3 flex-wrap">
				<!-- Actuator type -->
				<label class="flex items-center gap-1.5">
					<span class="text-[10px] text-[var(--color-dash-text-dim)] uppercase inline-flex items-center gap-0.5">{t('boost.actuator')}<HelpTip key="help.boost.actuator" /></span>
					<select bind:value={settings.actuatorType}
						class="px-2 py-1 text-xs rounded bg-[var(--color-dash-bg)] border border-[var(--color-dash-border)] text-[var(--color-dash-text)] focus:outline-none">
						{#each ACTUATOR_TYPES as at}
							<option value={at.value}>{t(at.key)}</option>
						{/each}
					</select>
				</label>

				<!-- CAN ID -->
				<div class="flex items-center gap-1.5">
					<span class="text-[10px] text-[var(--color-dash-text-dim)] uppercase inline-flex items-center gap-0.5">{t('boost.canId')}<HelpTip key="help.boost.canId" /></span>
					<button onclick={() => { if (settings.canId > 0) settings.canId--; }}
						class="w-5 h-5 flex items-center justify-center text-xs rounded bg-[var(--color-dash-bg)] border border-[var(--color-dash-border)] text-[var(--color-dash-text-dim)] hover:text-[var(--color-dash-accent)] hover:border-[var(--color-dash-accent)] transition-colors">&minus;</button>
					<span class="text-xs text-[var(--color-dash-text-dim)]">0x</span>
					<input type="text" value={settings.canId.toString(16).toUpperCase()} maxlength="8"
						onchange={(e) => { const v = parseInt(e.currentTarget.value, 16); if (!isNaN(v)) settings.canId = v; }}
						class="w-20 px-2 py-1 text-xs rounded bg-[var(--color-dash-bg)] border border-[var(--color-dash-border)] text-[var(--color-dash-text)] font-mono uppercase focus:border-[var(--color-dash-accent)] focus:outline-none" />
					<button onclick={() => { if (settings.canId < 0x1FFFFFFF) settings.canId++; }}
						class="w-5 h-5 flex items-center justify-center text-xs rounded bg-[var(--color-dash-bg)] border border-[var(--color-dash-border)] text-[var(--color-dash-text-dim)] hover:text-[var(--color-dash-accent)] hover:border-[var(--color-dash-accent)] transition-colors">+</button>
					<span class="text-[10px] text-[var(--color-dash-text-dim)] font-mono">= {settings.canId} dec</span>
				</div>

				<!-- Byte offset -->
				<label class="flex items-center gap-1.5">
					<span class="text-[10px] text-[var(--color-dash-text-dim)] uppercase inline-flex items-center gap-0.5">{t('boost.canByteOffset')}<HelpTip key="help.boost.canByteOffset" /></span>
					<input type="number" min="0" max="6" bind:value={settings.canByteOffset}
						class="w-14 px-2 py-1 text-xs rounded bg-[var(--color-dash-bg)] border border-[var(--color-dash-border)] text-[var(--color-dash-text)] font-mono text-center focus:border-[var(--color-dash-accent)] focus:outline-none" />
				</label>

				<!-- Big-endian -->
				<label class="flex items-center gap-1.5 cursor-pointer pb-0.5">
					<input type="checkbox" bind:checked={settings.canBigEndian} class="accent-[var(--color-dash-accent)]" />
					<span class="text-xs text-[var(--color-dash-text)] inline-flex items-center gap-0.5">{t('boost.canBigEndian')}<HelpTip key="help.boost.canBigEndian" /></span>
				</label>

				<!-- Send interval -->
				<label class="flex items-center gap-1.5">
					<span class="text-[10px] text-[var(--color-dash-text-dim)] uppercase inline-flex items-center gap-0.5">{t('boost.canInterval')}<HelpTip key="help.boost.canInterval" /></span>
					<input type="number" min="10" max="1000" bind:value={settings.canSendIntervalMs}
						class="w-16 px-2 py-1 text-xs rounded bg-[var(--color-dash-bg)] border border-[var(--color-dash-border)] text-[var(--color-dash-text)] font-mono text-center focus:border-[var(--color-dash-accent)] focus:outline-none" />
				</label>
			</div>
				</div>
			{/if}
		</section>

		<!-- Карты буста (аккордеон). Переключение — в шапке PWA (сквозное); здесь редактор активной карты. -->
		<section class="rounded-lg bg-[var(--color-dash-card)] border border-[var(--color-dash-border)]/50">
			<button class="w-full flex items-center justify-between p-3" onclick={() => toggleSection('maps')}>
				<span class="text-xs font-bold text-[var(--color-dash-text)] inline-flex items-center gap-1">
					{t('boost.maps')}<HelpTip key="help.boost.maps" />
					{#if boostMaps.switching}<span class="w-3 h-3 ml-1 rounded-full border-2 border-[var(--color-dash-border)] border-t-[var(--color-dash-accent)] animate-spin"></span>{/if}
				</span>
				<span class="text-xs text-[var(--color-dash-text-dim)]">{activeSection === 'maps' ? '−' : '+'}</span>
			</button>
			{#if activeSection === 'maps'}
				<div class="px-3 pb-3 space-y-2">
					<p class="text-[10px] text-[var(--color-dash-text-dim)]">
						{t('boost.mapEditHint')}
						<span class="text-[var(--color-dash-accent)] font-bold">{boostMaps.mapsMeta[boostMaps.activeMap]?.name || `Map ${boostMaps.activeMap + 1}`}</span>
					</p>
					{#if boostMaps.mapsMeta[boostMaps.editMap]}
						<div class="flex items-end gap-2 flex-wrap pt-1">
					<label class="space-y-1">
						<span class="text-[10px] text-[var(--color-dash-text-dim)] uppercase block">{t('boost.mapName')}</span>
						<input type="text" maxlength="15" bind:value={boostMaps.mapsMeta[boostMaps.editMap].name}
							class="w-28 px-2 py-1 text-xs rounded bg-[var(--color-dash-bg)] border border-[var(--color-dash-border)] text-[var(--color-dash-text)] focus:border-[var(--color-dash-accent)] focus:outline-none" />
					</label>
					<label class="space-y-1">
						<span class="text-[10px] text-[var(--color-dash-text-dim)] uppercase inline-flex items-center gap-0.5">{t('boost.overboostLimit')}<HelpTip key="help.boost.overboostLimit" /></span>
						<input type="number" step="5" bind:value={boostMaps.mapsMeta[boostMaps.editMap].overboostLimit_kPa}
							class="w-20 px-2 py-1 text-xs rounded bg-[var(--color-dash-bg)] border border-[var(--color-dash-border)] text-[var(--color-dash-text)] font-mono focus:border-[var(--color-dash-accent)] focus:outline-none" />
					</label>
					<label class="space-y-1">
						<span class="text-[10px] text-[var(--color-dash-text-dim)] uppercase inline-flex items-center gap-0.5">{t('boost.fillFrom')}<HelpTip key="help.boost.fillFrom" /></span>
						<select value="" onchange={(e) => { const v = e.currentTarget.value; e.currentTarget.value = ''; if (v !== '') copyMapFrom(parseInt(v)); }}
							class="block w-32 px-2 py-1 text-xs rounded bg-[var(--color-dash-bg)] border border-[var(--color-dash-border)] text-[var(--color-dash-text)] focus:border-[var(--color-dash-accent)] focus:outline-none">
							<option value="">{t('boost.fillFromSelect')}</option>
							{#each boostMaps.mapsMeta as m, i}
								{#if i !== boostMaps.editMap}
									<option value={i}>{m.name || `Map ${i + 1}`}</option>
								{/if}
							{/each}
						</select>
					</label>
					<button onclick={saveMapsMeta} disabled={boostMaps.switching}
						class="px-2 py-1 text-[10px] rounded bg-[var(--color-dash-success)]/15 text-[var(--color-dash-success)] hover:bg-[var(--color-dash-success)]/25 transition-colors disabled:opacity-40">
						{boostMaps.switching ? t('common.saving') : t('common.saveToDevice')}
					</button>
					{@render restoreBtn(restoreMaps)}
				</div>
				<p class="text-[10px] text-[var(--color-dash-text-dim)]">{t('boost.mapsHint')}</p>
			{/if}
			</div>
		{/if}
		</section>

		<!-- 2. Signal Sources -->
		<section class="rounded-lg bg-[var(--color-dash-card)] border border-[var(--color-dash-border)]/50">
			<button class="w-full flex items-center justify-between p-3" onclick={() => toggleSection('signals')}>
				<span class="text-xs font-bold text-[var(--color-dash-text)] inline-flex items-center gap-0.5">{t('boost.signals')}<HelpTip key="help.boost.signalsSection" /></span>
				<span class="text-xs text-[var(--color-dash-text-dim)]">{activeSection === 'signals' ? '−' : '+'}</span>
			</button>
			{#if activeSection === 'signals'}
				<div class="px-3 pb-3 space-y-2">
					<div class="grid grid-cols-2 gap-2">
						<label class="space-y-1">
							<span class="text-[10px] text-[var(--color-dash-text-dim)] uppercase inline-flex items-center gap-0.5">{t('boost.mapSignal')}<HelpTip key="help.boost.mapSignal" /></span>
							<select bind:value={settings.mapSignalParam}
								class="w-full px-2 py-1 text-xs rounded bg-[var(--color-dash-bg)] border border-[var(--color-dash-border)] text-[var(--color-dash-text)] font-mono focus:border-[var(--color-dash-accent)] focus:outline-none" >

								{#each paramOptions as p}

									<option value={p.enumVal}>{paramOptionLabel(p.enumVal)}</option>

								{/each}

							</select>
						</label>
						<label class="space-y-1">
							<span class="text-[10px] text-[var(--color-dash-text-dim)] uppercase inline-flex items-center gap-0.5">{t('boost.rpmSignal')}<HelpTip key="help.boost.rpmSignal" /></span>
							<select bind:value={settings.rpmSignalParam}
								class="w-full px-2 py-1 text-xs rounded bg-[var(--color-dash-bg)] border border-[var(--color-dash-border)] text-[var(--color-dash-text)] font-mono focus:border-[var(--color-dash-accent)] focus:outline-none" >

								{#each paramOptions as p}

									<option value={p.enumVal}>{paramOptionLabel(p.enumVal)}</option>

								{/each}

							</select>
						</label>
						<label class="space-y-1">
							<span class="text-[10px] text-[var(--color-dash-text-dim)] uppercase inline-flex items-center gap-0.5">{t('boost.tpsSignal')}<HelpTip key="help.boost.tpsSignal" /></span>
							<select bind:value={settings.tpsSignalParam}
								class="w-full px-2 py-1 text-xs rounded bg-[var(--color-dash-bg)] border border-[var(--color-dash-border)] text-[var(--color-dash-text)] font-mono focus:border-[var(--color-dash-accent)] focus:outline-none" >

								{#each paramOptions as p}

									<option value={p.enumVal}>{paramOptionLabel(p.enumVal)}</option>

								{/each}

							</select>
						</label>
						<label class="space-y-1">
							<span class="text-[10px] text-[var(--color-dash-text-dim)] uppercase inline-flex items-center gap-0.5">{t('boost.knockSignal')}<HelpTip key="help.boost.knockSignal" /></span>
							<select bind:value={settings.knockSignalParam}
								class="w-full px-2 py-1 text-xs rounded bg-[var(--color-dash-bg)] border border-[var(--color-dash-border)] text-[var(--color-dash-text)] font-mono focus:border-[var(--color-dash-accent)] focus:outline-none" >

								{#each paramOptions as p}

									<option value={p.enumVal}>{paramOptionLabel(p.enumVal)}</option>

								{/each}

							</select>
						</label>
					</div>
					<button onclick={saveSettings} disabled={saving}
						class="px-2 py-1 text-[10px] rounded bg-[var(--color-dash-success)]/15 text-[var(--color-dash-success)] hover:bg-[var(--color-dash-success)]/25 transition-colors disabled:opacity-40">
						{saving ? t('common.saving') : t('common.saveToDevice')}
					</button>
					{@render restoreBtn(restoreSettings)}
				</div>
			{/if}
		</section>

		<!-- 3. Target MAP Table -->
		<section class="rounded-lg bg-[var(--color-dash-card)] border border-[var(--color-dash-border)]/50">
			<button class="w-full flex items-center justify-between p-3" onclick={() => toggleSection('target')}>
				<span class="text-xs font-bold text-[var(--color-dash-text)] inline-flex items-center gap-0.5">{t('boost.targetTable')}<HelpTip key="help.boost.targetTableSection" /></span>
				<span class="text-xs text-[var(--color-dash-text-dim)]">{activeSection === 'target' ? '−' : '+'}</span>
			</button>
			{#if activeSection === 'target'}
				<div class="px-3 pb-3 space-y-2">
					<TableEditor
						data={targetTable.data}
						xAxisValues={targetTable.xAxisValues}
						yAxisValues={targetTable.yAxisValues}
						numCols={targetTable.numCols}
						numRows={targetTable.numRows}
						decimals={0}
						colorGradient={true}
						gradientMin={50}
						gradientMax={300}
						xAxisLabel="RPM"
						yAxisLabel="TPS"
						liveCursorX={liveRpm}
						liveCursorY={liveTps}
						resizable={true}
						onResize={onTargetResize}
						onDataChange={onTargetDataChange}
						onAxisChange={onTargetAxisChange}
					/>
					<button onclick={saveTargetTable} disabled={saving}
						class="px-3 py-1.5 text-xs rounded bg-[var(--color-dash-success)]/15 text-[var(--color-dash-success)] hover:bg-[var(--color-dash-success)]/25 transition-colors disabled:opacity-40">
						{saving ? t('common.saving') : t('common.saveToDevice')}
					</button>
					{@render restoreBtn(restoreTarget)}
				</div>
			{/if}
		</section>

		<!-- 4. Correction Table 1 -->
		<section class="rounded-lg bg-[var(--color-dash-card)] border border-[var(--color-dash-border)]/50">
			<button class="w-full flex items-center justify-between p-3" onclick={() => toggleSection('corr1')}>
				<span class="text-xs font-bold text-[var(--color-dash-text)] inline-flex items-center gap-0.5">{t('boost.corr1')}<HelpTip key="help.boost.corrTableSection" /></span>
				<span class="text-xs text-[var(--color-dash-text-dim)]">{activeSection === 'corr1' ? '−' : '+'}</span>
			</button>
			{#if activeSection === 'corr1'}
				<div class="px-3 pb-3 space-y-2">
					<div class="flex gap-3 flex-wrap">
						<label class="space-y-1">
							<span class="text-[10px] text-[var(--color-dash-text-dim)] uppercase inline-flex items-center gap-0.5">{t('boost.corrAxis')} X<HelpTip key="help.boost.corrAxis" /></span>
							<select bind:value={settings.corr1AxisParam}
								class="w-40 px-2 py-1 text-xs rounded bg-[var(--color-dash-bg)] border border-[var(--color-dash-border)] text-[var(--color-dash-text)] font-mono focus:border-[var(--color-dash-accent)] focus:outline-none" >
								{#each paramOptions as p}
									<option value={p.enumVal}>{paramOptionLabel(p.enumVal)}</option>
								{/each}
							</select>
						</label>
						<label class="space-y-1">
							<span class="text-[10px] text-[var(--color-dash-text-dim)] uppercase inline-flex items-center gap-0.5">{t('boost.corrAxis')} Y</span>
							<select bind:value={settings.corr1YAxisParam}
								class="w-40 px-2 py-1 text-xs rounded bg-[var(--color-dash-bg)] border border-[var(--color-dash-border)] text-[var(--color-dash-text)] font-mono focus:border-[var(--color-dash-accent)] focus:outline-none" >
								{#each paramOptions as p}
									<option value={p.enumVal}>{paramOptionLabel(p.enumVal)}</option>
								{/each}
							</select>
						</label>
					</div>
					<TableEditor
						data={corr1.data}
						xAxisValues={corr1.xAxisValues}
						yAxisValues={corr1.yAxisValues}
						numCols={corr1.numCols}
						numRows={corr1.numRows}
						decimals={1}
						colorGradient={true}
						gradientMin={50}
						gradientMax={150}
						xAxisLabel={enumParamShortName(settings.corr1AxisParam)}
						yAxisLabel={enumParamShortName(settings.corr1YAxisParam)}
						liveCursorX={liveVal(settings.corr1AxisParam)}
						liveCursorY={liveVal(settings.corr1YAxisParam)}
						resizable={true}
						onResize={onCorr1Resize}
						onDataChange={onCorr1DataChange}
						onAxisChange={onCorr1AxisChange}
					/>
					<button onclick={saveCorrTables} disabled={saving}
						class="px-3 py-1.5 text-xs rounded bg-[var(--color-dash-success)]/15 text-[var(--color-dash-success)] hover:bg-[var(--color-dash-success)]/25 transition-colors disabled:opacity-40">
						{saving ? t('common.saving') : t('common.saveToDevice')}
					</button>
					{@render restoreBtn(restoreCorr)}
				</div>
			{/if}
		</section>

		<!-- 5. Correction Table 2 -->
		<section class="rounded-lg bg-[var(--color-dash-card)] border border-[var(--color-dash-border)]/50">
			<button class="w-full flex items-center justify-between p-3" onclick={() => toggleSection('corr2')}>
				<span class="text-xs font-bold text-[var(--color-dash-text)] inline-flex items-center gap-0.5">{t('boost.corr2')}<HelpTip key="help.boost.corrTableSection" /></span>
				<span class="text-xs text-[var(--color-dash-text-dim)]">{activeSection === 'corr2' ? '−' : '+'}</span>
			</button>
			{#if activeSection === 'corr2'}
				<div class="px-3 pb-3 space-y-2">
					<div class="flex gap-3 flex-wrap">
						<label class="space-y-1">
							<span class="text-[10px] text-[var(--color-dash-text-dim)] uppercase inline-flex items-center gap-0.5">{t('boost.corrAxis')} X<HelpTip key="help.boost.corrAxis" /></span>
							<select bind:value={settings.corr2AxisParam}
								class="w-40 px-2 py-1 text-xs rounded bg-[var(--color-dash-bg)] border border-[var(--color-dash-border)] text-[var(--color-dash-text)] font-mono focus:border-[var(--color-dash-accent)] focus:outline-none" >
								{#each paramOptions as p}
									<option value={p.enumVal}>{paramOptionLabel(p.enumVal)}</option>
								{/each}
							</select>
						</label>
						<label class="space-y-1">
							<span class="text-[10px] text-[var(--color-dash-text-dim)] uppercase inline-flex items-center gap-0.5">{t('boost.corrAxis')} Y</span>
							<select bind:value={settings.corr2YAxisParam}
								class="w-40 px-2 py-1 text-xs rounded bg-[var(--color-dash-bg)] border border-[var(--color-dash-border)] text-[var(--color-dash-text)] font-mono focus:border-[var(--color-dash-accent)] focus:outline-none" >
								{#each paramOptions as p}
									<option value={p.enumVal}>{paramOptionLabel(p.enumVal)}</option>
								{/each}
							</select>
						</label>
					</div>
					<TableEditor
						data={corr2.data}
						xAxisValues={corr2.xAxisValues}
						yAxisValues={corr2.yAxisValues}
						numCols={corr2.numCols}
						numRows={corr2.numRows}
						decimals={1}
						colorGradient={true}
						gradientMin={50}
						gradientMax={150}
						xAxisLabel={enumParamShortName(settings.corr2AxisParam)}
						yAxisLabel={enumParamShortName(settings.corr2YAxisParam)}
						liveCursorX={liveVal(settings.corr2AxisParam)}
						liveCursorY={liveVal(settings.corr2YAxisParam)}
						resizable={true}
						onResize={onCorr2Resize}
						onDataChange={onCorr2DataChange}
						onAxisChange={onCorr2AxisChange}
					/>
					<button onclick={saveCorrTables} disabled={saving}
						class="px-3 py-1.5 text-xs rounded bg-[var(--color-dash-success)]/15 text-[var(--color-dash-success)] hover:bg-[var(--color-dash-success)]/25 transition-colors disabled:opacity-40">
						{saving ? t('common.saving') : t('common.saveToDevice')}
					</button>
					{@render restoreBtn(restoreCorr)}
				</div>
			{/if}
		</section>

		<!-- 6. PID Settings -->
		<section class="rounded-lg bg-[var(--color-dash-card)] border border-[var(--color-dash-border)]/50">
			<button class="w-full flex items-center justify-between p-3" onclick={() => toggleSection('pid')}>
				<span class="text-xs font-bold text-[var(--color-dash-text)] inline-flex items-center gap-0.5">{t('boost.pid')}<HelpTip key="help.boost.pidSection" /></span>
				<span class="text-xs text-[var(--color-dash-text-dim)]">{activeSection === 'pid' ? '−' : '+'}</span>
			</button>
			{#if activeSection === 'pid'}
				<div class="px-3 pb-3 space-y-2">
					<div class="grid grid-cols-2 sm:grid-cols-3 gap-2">
						<label class="space-y-1">
							<span class="text-[10px] text-[var(--color-dash-text-dim)] uppercase inline-flex items-center gap-0.5">{t('boost.kp')}<HelpTip key="help.boost.kp" /></span>
							<input type="number" step="0.1" bind:value={settings.kp}
								class="w-full px-2 py-1 text-xs rounded bg-[var(--color-dash-bg)] border border-[var(--color-dash-border)] text-[var(--color-dash-text)] font-mono focus:border-[var(--color-dash-accent)] focus:outline-none" />
						</label>
						<label class="space-y-1">
							<span class="text-[10px] text-[var(--color-dash-text-dim)] uppercase inline-flex items-center gap-0.5">{t('boost.ki')}<HelpTip key="help.boost.ki" /></span>
							<input type="number" step="0.1" bind:value={settings.ki}
								class="w-full px-2 py-1 text-xs rounded bg-[var(--color-dash-bg)] border border-[var(--color-dash-border)] text-[var(--color-dash-text)] font-mono focus:border-[var(--color-dash-accent)] focus:outline-none" />
						</label>
						<label class="space-y-1">
							<span class="text-[10px] text-[var(--color-dash-text-dim)] uppercase inline-flex items-center gap-0.5">{t('boost.kd')}<HelpTip key="help.boost.kd" /></span>
							<input type="number" step="0.1" bind:value={settings.kd}
								class="w-full px-2 py-1 text-xs rounded bg-[var(--color-dash-bg)] border border-[var(--color-dash-border)] text-[var(--color-dash-text)] font-mono focus:border-[var(--color-dash-accent)] focus:outline-none" />
						</label>
						<label class="space-y-1">
							<span class="text-[10px] text-[var(--color-dash-text-dim)] uppercase inline-flex items-center gap-0.5">{t('boost.iWindup')}<HelpTip key="help.boost.iWindup" /></span>
							<input type="number" step="1" bind:value={settings.iWindupLimit}
								class="w-full px-2 py-1 text-xs rounded bg-[var(--color-dash-bg)] border border-[var(--color-dash-border)] text-[var(--color-dash-text)] font-mono focus:border-[var(--color-dash-accent)] focus:outline-none" />
						</label>
						<label class="space-y-1">
							<span class="text-[10px] text-[var(--color-dash-text-dim)] uppercase inline-flex items-center gap-0.5">{t('boost.dFilter')}<HelpTip key="help.boost.dFilter" /></span>
							<input type="number" step="0.05" min="0" max="1" bind:value={settings.dFilterAlpha}
								class="w-full px-2 py-1 text-xs rounded bg-[var(--color-dash-bg)] border border-[var(--color-dash-border)] text-[var(--color-dash-text)] font-mono focus:border-[var(--color-dash-accent)] focus:outline-none" />
						</label>
					</div>
					<button onclick={saveSettings} disabled={saving}
						class="px-2 py-1 text-[10px] rounded bg-[var(--color-dash-success)]/15 text-[var(--color-dash-success)] hover:bg-[var(--color-dash-success)]/25 transition-colors disabled:opacity-40">
						{saving ? t('common.saving') : t('common.saveToDevice')}
					</button>
					{@render restoreBtn(restoreSettings)}
				</div>
			{/if}
		</section>

		<!-- 7. Safety -->
		<section class="rounded-lg bg-[var(--color-dash-card)] border border-[var(--color-dash-border)]/50">
			<button class="w-full flex items-center justify-between p-3" onclick={() => toggleSection('safety')}>
				<span class="text-xs font-bold text-[var(--color-dash-text)] inline-flex items-center gap-0.5">{t('boost.safety')}<HelpTip key="help.boost.safetySection" /></span>
				<span class="text-xs text-[var(--color-dash-text-dim)]">{activeSection === 'safety' ? '−' : '+'}</span>
			</button>
			{#if activeSection === 'safety'}
				<div class="px-3 pb-3 space-y-2">
					<p class="text-[10px] text-[var(--color-dash-text-dim)]">{t('boost.overboostPerMapHint')}</p>
					<div class="grid grid-cols-2 sm:grid-cols-3 gap-2">
						<label class="space-y-1">
							<span class="text-[10px] text-[var(--color-dash-text-dim)] uppercase inline-flex items-center gap-0.5">{t('boost.knockThreshold')}<HelpTip key="help.boost.knockThreshold" /></span>
							<input type="number" step="0.5" bind:value={settings.knockThreshold_deg}
								class="w-full px-2 py-1 text-xs rounded bg-[var(--color-dash-bg)] border border-[var(--color-dash-border)] text-[var(--color-dash-text)] font-mono focus:border-[var(--color-dash-accent)] focus:outline-none" />
						</label>
						<label class="space-y-1">
							<span class="text-[10px] text-[var(--color-dash-text-dim)] uppercase inline-flex items-center gap-0.5">{t('boost.knockReduction')}<HelpTip key="help.boost.knockReduction" /></span>
							<input type="number" step="1" bind:value={settings.knockReduction_pct}
								class="w-full px-2 py-1 text-xs rounded bg-[var(--color-dash-bg)] border border-[var(--color-dash-border)] text-[var(--color-dash-text)] font-mono focus:border-[var(--color-dash-accent)] focus:outline-none" />
						</label>
						<label class="space-y-1">
							<span class="text-[10px] text-[var(--color-dash-text-dim)] uppercase inline-flex items-center gap-0.5">{t('boost.canTimeout')}<HelpTip key="help.boost.canTimeout" /></span>
							<input type="number" step="50" bind:value={settings.canTimeoutMs}
								class="w-full px-2 py-1 text-xs rounded bg-[var(--color-dash-bg)] border border-[var(--color-dash-border)] text-[var(--color-dash-text)] font-mono focus:border-[var(--color-dash-accent)] focus:outline-none" />
						</label>
						<label class="space-y-1">
							<span class="text-[10px] text-[var(--color-dash-text-dim)] uppercase inline-flex items-center gap-0.5">{t('boost.rateLimit')}<HelpTip key="help.boost.rateLimit" /></span>
							<input type="number" step="10" bind:value={settings.rateLimitPctPerSec}
								class="w-full px-2 py-1 text-xs rounded bg-[var(--color-dash-bg)] border border-[var(--color-dash-border)] text-[var(--color-dash-text)] font-mono focus:border-[var(--color-dash-accent)] focus:outline-none" />
						</label>
					</div>
					<button onclick={saveSettings} disabled={saving}
						class="px-2 py-1 text-[10px] rounded bg-[var(--color-dash-success)]/15 text-[var(--color-dash-success)] hover:bg-[var(--color-dash-success)]/25 transition-colors disabled:opacity-40">
						{saving ? t('common.saving') : t('common.saveToDevice')}
					</button>
					{@render restoreBtn(restoreSettings)}
				</div>
			{/if}
		</section>

		<!-- 8. Learning -->
		<section class="rounded-lg bg-[var(--color-dash-card)] border border-[var(--color-dash-border)]/50">
			<button class="w-full flex items-center justify-between p-3" onclick={() => toggleSection('learning')}>
				<span class="text-xs font-bold text-[var(--color-dash-text)] inline-flex items-center gap-0.5">{t('boost.learning')}<HelpTip key="help.boost.learningSection" /></span>
				<span class="text-xs text-[var(--color-dash-text-dim)]">{activeSection === 'learning' ? '−' : '+'}</span>
			</button>
			{#if activeSection === 'learning'}
				<div class="px-3 pb-3 space-y-2">
					<label class="flex items-center gap-2 cursor-pointer">
						<input type="checkbox" bind:checked={settings.learnEnabled} class="accent-[var(--color-dash-accent)]" />
						<span class="text-xs text-[var(--color-dash-text)] inline-flex items-center gap-0.5">{t('boost.learnEnable')}<HelpTip key="help.boost.learnEnable" /></span>
					</label>
					<div class="grid grid-cols-2 sm:grid-cols-3 gap-2">
						<label class="space-y-1">
							<span class="text-[10px] text-[var(--color-dash-text-dim)] uppercase inline-flex items-center gap-0.5">{t('boost.learnRate')}<HelpTip key="help.boost.learnRate" /></span>
							<input type="number" step="0.01" min="0" max="1" bind:value={settings.learnRate}
								class="w-full px-2 py-1 text-xs rounded bg-[var(--color-dash-bg)] border border-[var(--color-dash-border)] text-[var(--color-dash-text)] font-mono focus:border-[var(--color-dash-accent)] focus:outline-none" />
						</label>
						<label class="space-y-1">
							<span class="text-[10px] text-[var(--color-dash-text-dim)] uppercase inline-flex items-center gap-0.5">{t('boost.learnErrorThreshold')}<HelpTip key="help.boost.learnErrorThreshold" /></span>
							<input type="number" step="0.5" bind:value={settings.learnErrorThreshold}
								class="w-full px-2 py-1 text-xs rounded bg-[var(--color-dash-bg)] border border-[var(--color-dash-border)] text-[var(--color-dash-text)] font-mono focus:border-[var(--color-dash-accent)] focus:outline-none" />
						</label>
						<label class="space-y-1">
							<span class="text-[10px] text-[var(--color-dash-text-dim)] uppercase inline-flex items-center gap-0.5">{t('boost.learnStabilityTime')}<HelpTip key="help.boost.learnStabilityTime" /></span>
							<input type="number" step="100" bind:value={settings.learnStabilityTimeMs}
								class="w-full px-2 py-1 text-xs rounded bg-[var(--color-dash-bg)] border border-[var(--color-dash-border)] text-[var(--color-dash-text)] font-mono focus:border-[var(--color-dash-accent)] focus:outline-none" />
						</label>
					</div>

					<!-- Kp/Kd Zone Learning -->
					<div class="pt-2 border-t border-[var(--color-dash-border)]/30 space-y-2">
						<span class="text-[10px] text-[var(--color-dash-text-dim)] uppercase font-bold inline-flex items-center gap-0.5">{t('boost.kpKdLearning')}<HelpTip key="help.boost.kpKdSection" /></span>
						<div class="grid grid-cols-2 sm:grid-cols-3 gap-2">
							<label class="space-y-1">
								<span class="text-[10px] text-[var(--color-dash-text-dim)] uppercase inline-flex items-center gap-0.5">{t('boost.learnKpRate')}<HelpTip key="help.boost.learnKpRate" /></span>
								<input type="number" step="0.01" min="0" max="1" bind:value={settings.learnKpRate}
									class="w-full px-2 py-1 text-xs rounded bg-[var(--color-dash-bg)] border border-[var(--color-dash-border)] text-[var(--color-dash-text)] font-mono focus:border-[var(--color-dash-accent)] focus:outline-none" />
							</label>
							<label class="space-y-1">
								<span class="text-[10px] text-[var(--color-dash-text-dim)] uppercase inline-flex items-center gap-0.5">{t('boost.learnKdRate')}<HelpTip key="help.boost.learnKdRate" /></span>
								<input type="number" step="0.01" min="0" max="1" bind:value={settings.learnKdRate}
									class="w-full px-2 py-1 text-xs rounded bg-[var(--color-dash-bg)] border border-[var(--color-dash-border)] text-[var(--color-dash-text)] font-mono focus:border-[var(--color-dash-accent)] focus:outline-none" />
							</label>
							<label class="space-y-1">
								<span class="text-[10px] text-[var(--color-dash-text-dim)] uppercase inline-flex items-center gap-0.5">{t('boost.kpRange')}<HelpTip key="help.boost.kpRange" /></span>
								<div class="flex gap-1 items-center">
									<input type="number" step="0.1" min="0.01" bind:value={settings.kpMin}
										class="w-16 px-1 py-1 text-xs rounded bg-[var(--color-dash-bg)] border border-[var(--color-dash-border)] text-[var(--color-dash-text)] font-mono text-center focus:border-[var(--color-dash-accent)] focus:outline-none" />
									<span class="text-[10px] text-[var(--color-dash-text-dim)]">–</span>
									<input type="number" step="0.5" min="0.1" bind:value={settings.kpMax}
										class="w-16 px-1 py-1 text-xs rounded bg-[var(--color-dash-bg)] border border-[var(--color-dash-border)] text-[var(--color-dash-text)] font-mono text-center focus:border-[var(--color-dash-accent)] focus:outline-none" />
								</div>
							</label>
							<label class="space-y-1">
								<span class="text-[10px] text-[var(--color-dash-text-dim)] uppercase inline-flex items-center gap-0.5">{t('boost.kdRange')}<HelpTip key="help.boost.kdRange" /></span>
								<div class="flex gap-1 items-center">
									<input type="number" step="0.01" min="0" bind:value={settings.kdMin}
										class="w-16 px-1 py-1 text-xs rounded bg-[var(--color-dash-bg)] border border-[var(--color-dash-border)] text-[var(--color-dash-text)] font-mono text-center focus:border-[var(--color-dash-accent)] focus:outline-none" />
									<span class="text-[10px] text-[var(--color-dash-text-dim)]">–</span>
									<input type="number" step="0.1" min="0" bind:value={settings.kdMax}
										class="w-16 px-1 py-1 text-xs rounded bg-[var(--color-dash-bg)] border border-[var(--color-dash-border)] text-[var(--color-dash-text)] font-mono text-center focus:border-[var(--color-dash-accent)] focus:outline-none" />
								</div>
							</label>
							<label class="space-y-1">
								<span class="text-[10px] text-[var(--color-dash-text-dim)] uppercase inline-flex items-center gap-0.5">{t('boost.oscillationThreshold')}<HelpTip key="help.boost.oscillationThreshold" /></span>
								<input type="number" step="1" min="1" max="10" bind:value={settings.oscillationThreshold}
									class="w-full px-2 py-1 text-xs rounded bg-[var(--color-dash-bg)] border border-[var(--color-dash-border)] text-[var(--color-dash-text)] font-mono focus:border-[var(--color-dash-accent)] focus:outline-none" />
							</label>
							<label class="space-y-1">
								<span class="text-[10px] text-[var(--color-dash-text-dim)] uppercase inline-flex items-center gap-0.5">{t('boost.oscillationWindow')}<HelpTip key="help.boost.oscillationWindow" /></span>
								<input type="number" step="100" bind:value={settings.oscillationWindowMs}
									class="w-full px-2 py-1 text-xs rounded bg-[var(--color-dash-bg)] border border-[var(--color-dash-border)] text-[var(--color-dash-text)] font-mono focus:border-[var(--color-dash-accent)] focus:outline-none" />
							</label>
							<label class="space-y-1">
								<span class="text-[10px] text-[var(--color-dash-text-dim)] uppercase inline-flex items-center gap-0.5">{t('boost.persistentErrorTime')}<HelpTip key="help.boost.persistentErrorTime" /></span>
								<input type="number" step="500" bind:value={settings.persistentErrorTimeMs}
									class="w-full px-2 py-1 text-xs rounded bg-[var(--color-dash-bg)] border border-[var(--color-dash-border)] text-[var(--color-dash-text)] font-mono focus:border-[var(--color-dash-accent)] focus:outline-none" />
							</label>
							<label class="space-y-1">
								<span class="text-[10px] text-[var(--color-dash-text-dim)] uppercase inline-flex items-center gap-0.5">{t('boost.persistentErrorKpa')}<HelpTip key="help.boost.persistentErrorKpa" /></span>
								<input type="number" step="0.5" bind:value={settings.persistentErrorMinKpa}
									class="w-full px-2 py-1 text-xs rounded bg-[var(--color-dash-bg)] border border-[var(--color-dash-border)] text-[var(--color-dash-text)] font-mono focus:border-[var(--color-dash-accent)] focus:outline-none" />
							</label>
						</div>
					</div>

					<!-- dRPM/dt Transient Boost -->
					<div class="pt-2 border-t border-[var(--color-dash-border)]/30 space-y-2">
						<span class="text-[10px] text-[var(--color-dash-text-dim)] uppercase font-bold inline-flex items-center gap-0.5">{t('boost.transientBoost')}<HelpTip key="help.boost.transientSection" /></span>
						<div class="grid grid-cols-2 gap-2">
							<label class="space-y-1">
								<span class="text-[10px] text-[var(--color-dash-text-dim)] uppercase inline-flex items-center gap-0.5">{t('boost.transientGain')}<HelpTip key="help.boost.transientGain" /></span>
								<input type="number" step="0.1" min="0" max="2" bind:value={settings.transientGain}
									class="w-full px-2 py-1 text-xs rounded bg-[var(--color-dash-bg)] border border-[var(--color-dash-border)] text-[var(--color-dash-text)] font-mono focus:border-[var(--color-dash-accent)] focus:outline-none" />
							</label>
							<label class="space-y-1">
								<span class="text-[10px] text-[var(--color-dash-text-dim)] uppercase inline-flex items-center gap-0.5">{t('boost.dRpmFilterAlpha')}<HelpTip key="help.boost.dRpmFilterAlpha" /></span>
								<input type="number" step="0.05" min="0.01" max="1" bind:value={settings.dRpmFilterAlpha}
									class="w-full px-2 py-1 text-xs rounded bg-[var(--color-dash-bg)] border border-[var(--color-dash-border)] text-[var(--color-dash-text)] font-mono focus:border-[var(--color-dash-accent)] focus:outline-none" />
							</label>
						</div>
					</div>

					<button onclick={saveSettings} disabled={saving}
						class="px-2 py-1 text-[10px] rounded bg-[var(--color-dash-success)]/15 text-[var(--color-dash-success)] hover:bg-[var(--color-dash-success)]/25 transition-colors disabled:opacity-40">
						{saving ? t('common.saving') : t('common.saveToDevice')}
					</button>
					{@render restoreBtn(restoreSettings)}
				</div>
			{/if}
		</section>

		<!-- 9. Learn Tables Viewer -->
		<section class="rounded-lg bg-[var(--color-dash-card)] border border-[var(--color-dash-border)]/50">
			<button class="w-full flex items-center justify-between p-3" onclick={() => toggleSection('learnTable')}>
				<span class="text-xs font-bold text-[var(--color-dash-text)] inline-flex items-center gap-0.5">{t('boost.pidTables')}<HelpTip key="help.boost.pidTablesViewer" /></span>
				<span class="text-xs text-[var(--color-dash-text-dim)]">{activeSection === 'learnTable' ? '−' : '+'}</span>
			</button>
			{#if activeSection === 'learnTable'}
				<div class="px-3 pb-3 space-y-4">
					<!-- I-term Learn Table -->
					<div class="space-y-1">
						<span class="text-[10px] text-[var(--color-dash-text-dim)] uppercase font-bold inline-flex items-center gap-0.5">{t('boost.learnTableKi')}<HelpTip key="help.boost.learnTableKi" /></span>
						<TableEditor
							data={learnKiData}
							xAxisValues={learnTables.ki.xAxisValues}
							yAxisValues={learnTables.ki.yAxisValues}
							numCols={learnTables.ki.numCols}
							numRows={learnTables.ki.numRows}
							decimals={1}
							readOnly={true}
							colorGradient={true}
							gradientMin={0}
							gradientMax={100}
							highlight={hlKi}
							xAxisLabel="RPM"
							yAxisLabel="TPS"
							liveCursorX={liveRpm}
							liveCursorY={liveTps}
						/>
					</div>
					<!-- Kp Multiplier Learn Table -->
					<div class="space-y-1">
						<span class="text-[10px] text-[var(--color-dash-text-dim)] uppercase font-bold inline-flex items-center gap-0.5">{t('boost.learnTableKp')}<HelpTip key="help.boost.learnTableKp" /></span>
						<TableEditor
							data={learnKpMultData}
							xAxisValues={learnTables.kp.xAxisValues}
							yAxisValues={learnTables.kp.yAxisValues}
							numCols={learnTables.kp.numCols}
							numRows={learnTables.kp.numRows}
							decimals={1}
							readOnly={true}
							colorGradient={true}
							gradientMin={20}
							gradientMax={300}
							highlight={hlKp}
							xAxisLabel="RPM"
							yAxisLabel="TPS"
							liveCursorX={liveRpm}
							liveCursorY={liveTps}
						/>
					</div>
					<!-- Kd Multiplier Learn Table -->
					<div class="space-y-1">
						<span class="text-[10px] text-[var(--color-dash-text-dim)] uppercase font-bold inline-flex items-center gap-0.5">{t('boost.learnTableKd')}<HelpTip key="help.boost.learnTableKd" /></span>
						<TableEditor
							data={learnKdMultData}
							xAxisValues={learnTables.kd.xAxisValues}
							yAxisValues={learnTables.kd.yAxisValues}
							numCols={learnTables.kd.numCols}
							numRows={learnTables.kd.numRows}
							decimals={1}
							readOnly={true}
							colorGradient={true}
							gradientMin={20}
							gradientMax={500}
							highlight={hlKd}
							xAxisLabel="RPM"
							yAxisLabel="TPS"
							liveCursorX={liveRpm}
							liveCursorY={liveTps}
						/>
					</div>
					<button onclick={resetLearnTable} disabled={saving}
						class="px-3 py-1.5 text-xs rounded bg-[var(--color-dash-danger)]/15 text-[var(--color-dash-danger)] hover:bg-[var(--color-dash-danger)]/25 transition-colors disabled:opacity-40">
						{t('boost.resetLearn')}
					</button>
				</div>
			{/if}
		</section>

		<!-- 10. BIAS Table (feedforward, auto-learned) -->
		<section class="rounded-lg bg-[var(--color-dash-card)] border border-[var(--color-dash-border)]/50">
			<button class="w-full flex items-center justify-between p-3" onclick={() => toggleSection('biasTable')}>
				<span class="text-xs font-bold text-[var(--color-dash-text)] inline-flex items-center gap-0.5">{t('boost.biasTable')}<HelpTip key="help.boost.biasTable" /></span>
				<span class="text-xs text-[var(--color-dash-text-dim)]">{activeSection === 'biasTable' ? '−' : '+'}</span>
			</button>
			{#if activeSection === 'biasTable'}
				<div class="px-3 pb-3 space-y-3">
					<p class="text-[10px] text-[var(--color-dash-text-dim)]">{t('boost.biasTableDesc')}</p>
					<div class="overflow-x-auto">
						<TableEditor
							data={biasTable.data}
							xAxisValues={biasTable.xAxisValues}
							yAxisValues={biasTable.yAxisValues}
							numCols={biasTable.numCols}
							numRows={biasTable.numRows}
							xAxisLabel="RPM"
							yAxisLabel="Target kPa"
							liveCursorX={liveRpm}
							liveCursorY={liveMap}
							highlight={hlBias}
							resizable={true}
							onResize={onBiasResize}
							onDataChange={onBiasDataChange}
							onAxisChange={onBiasAxisChange}
						/>
					</div>
					<button onclick={saveBiasTable} disabled={saving}
						class="px-2 py-1 text-[10px] rounded bg-[var(--color-dash-success)]/15 text-[var(--color-dash-success)] hover:bg-[var(--color-dash-success)]/25 transition-colors disabled:opacity-40">
						{saving ? t('common.saving') : t('common.saveToDevice')}
					</button>
					{@render restoreBtn(restoreBias)}
				</div>
			{/if}
		</section>

		<!-- 11. DeltaMAP Table (PID activation zone) -->
		<section class="rounded-lg bg-[var(--color-dash-card)] border border-[var(--color-dash-border)]/50">
			<button class="w-full flex items-center justify-between p-3" onclick={() => toggleSection('deltaMap')}>
				<span class="text-xs font-bold text-[var(--color-dash-text)] inline-flex items-center gap-0.5">{t('boost.deltaMap')}<HelpTip key="help.boost.deltaMap" /></span>
				<span class="text-xs text-[var(--color-dash-text-dim)]">{activeSection === 'deltaMap' ? '−' : '+'}</span>
			</button>
			{#if activeSection === 'deltaMap'}
				<div class="px-3 pb-3 space-y-3">
					<p class="text-[10px] text-[var(--color-dash-text-dim)]">{t('boost.deltaMapDesc')}</p>
					<div class="overflow-x-auto">
						<TableEditor
							data={deltaMapTable.data}
							xAxisValues={deltaMapTable.xAxisValues}
							yAxisValues={[]}
							numCols={deltaMapTable.numCols}
							numRows={1}
							xAxisLabel="RPM"
							yAxisLabel=""
							liveCursorX={liveRpm}
							resizable={true}
							maxRows={1}
							onResize={onDeltaMapResize}
							onDataChange={onDeltaMapDataChange}
							onAxisChange={onDeltaMapAxisChange}
						/>
					</div>
					<!-- Phase control params -->
					<div class="grid grid-cols-2 gap-2 pt-2 border-t border-[var(--color-dash-border)]/30">
						<label class="space-y-1">
							<span class="text-[10px] text-[var(--color-dash-text-dim)] uppercase inline-flex items-center gap-0.5">{t('boost.phaseHysteresis')}<HelpTip key="help.boost.phaseHysteresis" /></span>
							<input type="number" step="0.01" min="1.0" max="2.0" bind:value={settings.phaseHysteresis}
								class="w-full px-2 py-1 text-xs rounded bg-[var(--color-dash-bg)] border border-[var(--color-dash-border)] text-[var(--color-dash-text)] font-mono focus:border-[var(--color-dash-accent)] focus:outline-none" />
						</label>
						<label class="space-y-1">
							<span class="text-[10px] text-[var(--color-dash-text-dim)] uppercase inline-flex items-center gap-0.5">{t('boost.learnBiasRate')}<HelpTip key="help.boost.learnBiasRate" /></span>
							<input type="number" step="0.01" min="0" max="1" bind:value={settings.learnBiasRate}
								class="w-full px-2 py-1 text-xs rounded bg-[var(--color-dash-bg)] border border-[var(--color-dash-border)] text-[var(--color-dash-text)] font-mono focus:border-[var(--color-dash-accent)] focus:outline-none" />
						</label>
					</div>
					<div class="flex gap-2">
						<button onclick={saveDeltaMapTable} disabled={saving}
							class="px-2 py-1 text-[10px] rounded bg-[var(--color-dash-success)]/15 text-[var(--color-dash-success)] hover:bg-[var(--color-dash-success)]/25 transition-colors disabled:opacity-40">
							{saving ? t('common.saving') : t('common.saveToDevice')}
						</button>
						{@render restoreBtn(restoreDelta)}
						<button onclick={saveSettings} disabled={saving}
							class="px-2 py-1 text-[10px] rounded bg-[var(--color-dash-success)]/15 text-[var(--color-dash-success)] hover:bg-[var(--color-dash-success)]/25 transition-colors disabled:opacity-40">
							{t('boost.savePhaseSettings')}
						</button>
						{@render restoreBtn(restoreSettings)}
					</div>
				</div>
			{/if}
		</section>
	{/if}
</div>
