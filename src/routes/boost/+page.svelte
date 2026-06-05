<script lang="ts">
	import { readJsonConfig, writeJsonConfig, writeUint8 } from '$lib/ble/chunked-transfer';
	import { bleState } from '$lib/stores/ble-connection.svelte';
	import { SVC_BOOST, CHR_BOOST_SETTINGS, CHR_BOOST_TARGET, CHR_BOOST_CORR, CHR_BOOST_LEARN, CHR_BOOST_BIAS, CHR_BOOST_DELTA_MAP,
		SVC_SYSTEM, CHR_COMMAND, CMD_BOOST_SAVE_NOW, CMD_BOOST_COMMIT_BASELINE, CMD_BOOST_REVERT_BASELINE } from '$lib/ble/uuids';
	import { onLearnDelta, type LearnDelta } from '$lib/stores/boost-learn-stream.svelte';
	import type { BoostControllerSettings, BoostTable, BoostCorrectionTable, BoostPidTables } from '$lib/types/config';
	import { boostMaps, loadBoostMaps, saveBoostMapsMeta, copyBoostMapFrom } from '$lib/stores/boost-maps.svelte';
	import { boostSettings, loadBoostSettings, defaultBoostSettings } from '$lib/stores/boost-settings.svelte';
	import { calBaseline, snapCalBaseline, clearCalBaselines } from '$lib/stores/boost-calibration.svelte';
	import { t } from '$lib/i18n/index.svelte';
	import TableEditor from '$lib/components/TableEditor.svelte';
	import { resizeTable } from '$lib/components/table-editor/resize';
	import { loadCachedTable, saveCachedTable } from '$lib/stores/boost-table-cache';
	import ConnectPrompt from '$lib/components/ConnectPrompt.svelte';
	import { allParamEntries, enumToFirmwareName, enumToPwaName, firmwareNameToEnum } from '$lib/utils/param-mapping';
	import { getCacheSlotDisplayName, getParamShortName, signalLabels } from '$lib/stores/signal-labels.svelte';
	import { liveData } from '$lib/stores/live-data.svelte';
	import { PARAM_CACHE_SLOT_START } from '$lib/ble/protocol';
	import HelpTip from '$lib/components/HelpTip.svelte';

	const ACTUATOR_TYPES = [
		{ value: 0, key: 'boost.membrane' as const },
		{ value: 1, key: 'boost.vacuum' as const },
		{ value: 2, key: 'boost.electronic' as const }
	];

	// --- State ---
	// Редактируемая копия настроек. Источник истины — стор boostSettings (грузится централизованно
	// в hydrate() на коннекте). Копию пересинхронит $effect по boostSettings.epoch (ниже). Пока стор
	// не загружен — settingsLoaded=false и UI показывает «читаю с устройства», а НЕ дефолты.
	let settings = $state<BoostControllerSettings>(defaultBoostSettings());
	let settingsLoaded = $derived(boostSettings.loaded);
	// Инициализация из кэша (последняя карта с устройства) → показываем её затемнённой до прихода
	// свежих данных по BLE; нет кэша (первый запуск) → дефолт. См. boost-table-cache + флаги loaded.*.
	let targetTable = $state<BoostTable>(loadCachedTable<BoostTable>('target') ?? defaultTargetTable());
	let corr1 = $state<BoostCorrectionTable>(loadCachedTable<BoostCorrectionTable>('corr1') ?? defaultCorrTable());
	let corr2 = $state<BoostCorrectionTable>(loadCachedTable<BoostCorrectionTable>('corr2') ?? defaultCorrTable());
	let learnTables = $state<BoostPidTables>(loadCachedTable<BoostPidTables>('learn') ?? defaultLearnTables());
	let biasTable = $state<BoostTable>(loadCachedTable<BoostTable>('bias') ?? defaultBiasTable());
	let deltaMapTable = $state<BoostCorrectionTable>(loadCachedTable<BoostCorrectionTable>('delta') ?? defaultDeltaMapTable());

	// --- Карты буста: состояние в общем сторе $lib/stores/boost-maps (шарится с шапкой PWA). ---
	// Плоская (НЕ $state) переменная: $effect тогда зависит только от boostMaps.reloadEpoch (без самопетли).
	let lastReloadEpoch = 0;   // отслеживаем boostMaps.reloadEpoch → перечитка таблиц после switch/copy

	let loading = $state(false);
	let saving = $state(false);
	let statusMsg = $state('');
	let activeSection = $state<string | null>(null);

	let isConnected = $derived(bleState.status === 'connected');

	// --- Пресет «Скорость калибровки»: один контрол вместо россыпи rate-настроек обучения. ---
	// Пишет существующие поля настроек: темпы обучения BIAS/Ki, доля сдвига к авто-Kp/Kd (P6) и окно.
	// Детекция волн (раскачки) — автоматическая в прошивке (P6), порогов на UI нет.
	const CAL_PRESETS = [
		{ key: 'boost.calGentle' as const, biasRate: 0.02, rate: 0.02, kpRate: 0.2, kdRate: 0.2, stability: 500 },
		{ key: 'boost.calNormal' as const, biasRate: 0.03, rate: 0.03, kpRate: 0.3, kdRate: 0.3, stability: 300 },
		{ key: 'boost.calFast' as const,   biasRate: 0.05, rate: 0.05, kpRate: 0.5, kdRate: 0.5, stability: 200 }
	];
	function applyCalPreset(p: (typeof CAL_PRESETS)[number]) {
		settings.learnBiasRate = p.biasRate;
		settings.learnRate = p.rate;
		settings.learnKpRate = p.kpRate;
		settings.learnKdRate = p.kdRate;
		settings.learnStabilityTimeMs = p.stability;
	}
	let activeCalPreset = $derived(CAL_PRESETS.findIndex(p =>
		p.biasRate === settings.learnBiasRate && p.rate === settings.learnRate &&
		p.kpRate === settings.learnKpRate && p.kdRate === settings.learnKdRate &&
		p.stability === settings.learnStabilityTimeMs));
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
	// BIAS-таблица индексируется прошивкой по ЦЕЛЕВОМУ бусту (targetMAP), не по факт. MAP —
	// см. boost_controller.cpp (boostBilinearInterpolate/Write по targetMAP). Живой буст-таргет
	// стримится как системный параметр BST_TGT.
	let liveTargetMap = $derived(liveVal(firmwareNameToEnum('BST_TGT')));


	// --- 2D array wrappers for TableEditor ---
	let targetData = $derived.by(() => {
		const d: number[][] = [];
		for (let r = 0; r < targetTable.numRows; r++) {
			d.push(targetTable.data[r] ? [...targetTable.data[r]] : Array(targetTable.numCols).fill(100));
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
		const cols = 8, rows = 8;
		const xAxis = [1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000];
		const yAxis = [0, 15, 30, 45, 60, 75, 90, 100];
		const data = Array.from({ length: rows }, () => Array(cols).fill(100));
		return { numCols: cols, numRows: rows, xAxisValues: xAxis, yAxisValues: yAxis, data };
	}

	function defaultCorrTable(): BoostCorrectionTable {
		return {
			numCols: 8,
			numRows: 8,
			xAxisValues: [0, 15, 30, 45, 60, 75, 90, 100],
			yAxisValues: [0, 15, 30, 45, 60, 75, 90, 105],
			data: Array.from({ length: 8 }, () => Array(8).fill(100))
		};
	}

	function defaultLearnTable(fillValue: number = 50): BoostTable {
		const cols = 8, rows = 8;
		const xAxis = [1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000];
		const yAxis = [0, 15, 30, 45, 60, 75, 90, 100];
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

	// Перечитать настройки с устройства в общий стор. Редактируемую копию `settings` обновит
	// $effect-синхронизатор по boostSettings.epoch (ниже). Используется и кнопкой «Восстановить из Flash».
	async function loadSettings(): Promise<boolean> {
		return await loadBoostSettings();
	}
	// Перечитать таблицы открытой секции (после switch/copy карты — в т.ч. инициированного из шапки).
	// Сбрасываем ВСЕ флаги: target/corr адресуют новый слот, а learn/bias/delta тоже могли
	// измениться (обучение на лету) — иначе открытая learn/bias-таблица осталась бы устаревшей.
	async function reloadOpenSectionTables() {
		loaded = { target: false, corr: false, learn: false, bias: false, delta: false };
		if (activeSection) await ensureSectionData(activeSection);
	}
	// Пометить секцию как требующую перечитки (сбросить флаг loaded) — для refresh по фокусу/кнопке.
	function markSectionStale(id: string) {
		if (id === 'target') loaded.target = false;
		else if (id === 'corr1' || id === 'corr2') loaded.corr = false;
		else if (id === 'learnTable') loaded.learn = false;
		else if (id === 'biasTable') loaded.bias = false;
		else if (id === 'deltaMap') loaded.delta = false;
	}
	async function loadTarget() {
		const tgt = await readJsonConfig<BoostTable>(SVC_BOOST, CHR_BOOST_TARGET);
		if (tgt) { targetTable = tgt; saveCachedTable('target', tgt); }
		loaded.target = true;
	}
	async function loadCorr() {
		const corrs = await readJsonConfig<BoostCorrectionTable[]>(SVC_BOOST, CHR_BOOST_CORR);
		if (corrs && corrs.length >= 2) {
			corr1 = corrs[0]; corr2 = corrs[1];
			saveCachedTable('corr1', corr1); saveCachedTable('corr2', corr2);
		}
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
		saveCachedTable('learn', $state.snapshot(learnTables));
		// Always-on: фиксируем базлайн при первом открытии → подсветка покажет, что обучение
		// меняет, пока смотришь (стрим live-дельт мутирует таблицы). Сброс — по «Сохранить сейчас».
		if (!calBaseline.ki) { snapBaseline('ki'); snapBaseline('kp'); snapBaseline('kd'); }
	}
	async function loadBias() {
		const bias = await readJsonConfig<BoostTable>(SVC_BOOST, CHR_BOOST_BIAS);
		if (bias) { biasTable = bias; saveCachedTable('bias', bias); }
		loaded.bias = true;
		if (!calBaseline.bias) snapBaseline('bias');
	}
	async function loadDelta() {
		const delta = await readJsonConfig<BoostCorrectionTable>(SVC_BOOST, CHR_BOOST_DELTA_MAP);
		// firmware не шлёт yAxisValues для 1D deltaMap → нормализуем, иначе ресайз падал на .slice().
		if (delta) { deltaMapTable = { ...delta, yAxisValues: delta.yAxisValues ?? [] }; saveCachedTable('delta', deltaMapTable); }
		loaded.delta = true;
	}

	// Загрузить данные секции, если ещё не загружены (по первому раскрытию).
	async function ensureSectionData(id: string) {
		const need =
			(id === 'target' && !loaded.target) ? loadTarget :
			((id === 'corr1' || id === 'corr2') && !loaded.corr) ? loadCorr :
			(id === 'pid' && !loaded.learn) ? loadLearn :
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


	// После калибровки обученные таблицы на устройстве изменились. Освежаем настройки, помечаем
	// ВСЕ табличные секции устаревшими (любое последующее раскрытие перечитает свежее с устройства),
	// и сразу перечитываем открытую секцию, чтобы пользователь увидел результат без ручного действия.
	async function reloadAfterCalibration() {
		await loadSettings();
		markAllTablesStale();
		if (activeSection) await ensureSectionData(activeSection);
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
	const restoreLearn    = () => restoreFromFlash(loadLearn);
	const restoreBias     = () => restoreFromFlash(loadBias);
	// Восстанавливает оба источника секции DeltaMAP: таблицу + параметры фазы (boost_settings).
	const restoreDelta    = () => restoreFromFlash(async () => { await loadDelta(); await loadSettings(); });
	const restoreMaps     = () => restoreFromFlash(loadBoostMaps);

	async function saveSettings() {
		saving = true;
		try {
			const ok = await writeJsonConfig(SVC_BOOST, CHR_BOOST_SETTINGS, settings);
			if (ok) boostSettings.value = $state.snapshot(settings);  // стор = то, что на устройстве (без бампа epoch → без переклона)
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

	// Ручное сохранение отредактированных Ki/Kp/Kd. Прошивка применяет {ki,kp,kd} и сразу
	// пишет в LittleFS (applyBoostLearnTablesFromJson → saveBoostCalibrationToFS).
	async function saveLearnTables() {
		saving = true;
		try {
			const ok = await writeJsonConfig(SVC_BOOST, CHR_BOOST_LEARN, learnTables);
			showStatus(ok ? t('canRx.savedOk') : t('canRx.saveFailed'));
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

	// DeltaMAP-секция хранит И таблицу (CHR_BOOST_DELTA_MAP), И параметры фазы
	// (phaseHysteresis/learnBiasRate — часть boost_settings, разные характеристики). Одна кнопка
	// «Сохранить» пишет оба, чтобы не путать пользователя двумя кнопками сохранения.
	async function saveDeltaSection() {
		saving = true;
		try {
			const okTbl = await writeJsonConfig(SVC_BOOST, CHR_BOOST_DELTA_MAP, deltaMapTable);
			const okSet = await writeJsonConfig(SVC_BOOST, CHR_BOOST_SETTINGS, settings);
			if (okSet) boostSettings.value = $state.snapshot(settings);  // стор = то, что на устройстве
			showStatus(okTbl && okSet ? t('canRx.savedOk') : t('canRx.saveFailed'));
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

	// Базлайн = снимок значений на старте калибровки. Хранится в ГЛОБАЛЬНОМ сторе
	// (boost-calibration.svelte), поэтому переживает уход/возврат на страницу: вернувшись во время
	// калибровки, видим суммарное изменение от её старта, а не от момента возврата. Сброс — на
	// старте новой калибровки, Save/Discard и централизованно на разрыве связи (resetHydration).
	function snapBaseline(key: HlKey) {
		const data = key === 'bias' ? biasTable.data : learnTables[key].data;
		snapCalBaseline(key, data);
	}
	function clearBaselines() {
		clearCalBaselines();   // base=null → подсветка пропадает
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
	let hlKp = $derived.by(() => netGrid(learnTables.kp.data, calBaseline.kp, HL_SCALE.kp));
	let hlKd = $derived.by(() => netGrid(learnTables.kd.data, calBaseline.kd, HL_SCALE.kd));
	let hlBias = $derived.by(() => netGrid(biasTable.data, calBaseline.bias, HL_SCALE.bias));

	// --- Live-дельты обучения: устройство шлёт notify ТОЛЬКО с изменёнными ячейками
	//     (tableId,row,col,value), без перекачки целых таблиц и без паузы live-данных.
	//     Подписка — через общий стор boost-learn-stream (ref-counted), чтобы логгер мог
	//     ловить те же корректировки на любой странице, не глуша notify друг другу. ---
	let learnDeltaUnsub: (() => void) | null = null;
	function applyLearnDeltas(deltas: LearnDelta[]) {
		for (const d of deltas) {
			// 0=Ki, 1=Kp, 2=Kd, 3=BIAS — должно совпадать с BOOST_LEARN_ID_* в прошивке
			const key: HlKey | null = d.tableId === 0 ? 'ki' : d.tableId === 1 ? 'kp'
				: d.tableId === 2 ? 'kd' : d.tableId === 3 ? 'bias' : null;
			if (!key) continue;
			const tbl = key === 'bias' ? biasTable : learnTables[key];
			if (!tbl?.data || d.row >= tbl.data.length || d.col >= (tbl.data[d.row]?.length ?? 0)) continue;
			tbl.data[d.row][d.col] = d.value;   // мутация $state → перерисует значение И подсветку (derived hl* = текущее−базлайн)
		}
	}

	// --- P7: always-on adaptive. Обучение идёт всегда (флаг «Включить» в настройках); ритуала
	//     старт/стоп нет. Здесь — только ручные действия через CHR_COMMAND. ---
	async function saveLearnNow() {
		try {
			await writeUint8(SVC_SYSTEM, CHR_COMMAND, CMD_BOOST_SAVE_NOW);
			clearBaselines();   // сохранили → отсчёт подсветки дельт с этого момента
			showStatus(t('boost.learnSavedNow'));
		} catch (e) {
			showStatus(t('canRx.saveFailed') + ': ' + (e as Error).message);
		}
	}
	async function commitBaseline() {
		if (!confirm(t('boost.commitBaselineConfirm'))) return;
		try {
			await writeUint8(SVC_SYSTEM, CHR_COMMAND, CMD_BOOST_COMMIT_BASELINE);
			showStatus(t('boost.baselineCommitted'));
		} catch (e) {
			showStatus(t('canRx.saveFailed') + ': ' + (e as Error).message);
		}
	}
	async function revertBaseline() {
		if (!confirm(t('boost.revertBaselineConfirm'))) return;
		try {
			await writeUint8(SVC_SYSTEM, CHR_COMMAND, CMD_BOOST_REVERT_BASELINE);
			clearBaselines();
			await new Promise((r) => setTimeout(r, 900));  // дать устройству применить эталон (файловый I/O в controlTask)
			await reloadAfterCalibration();                 // перечитать таблицы с устройства
			showStatus(t('boost.baselineReverted'));
		} catch (e) {
			showStatus(t('canRx.saveFailed') + ': ' + (e as Error).message);
		}
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

	// --- Ручное редактирование таблиц обучения Ki/Kp/Kd (key = ключ в learnTables) ---
	const LEARN_FILL: Record<'ki' | 'kp' | 'kd', number> = { ki: 0, kp: 2.0, kd: 0.3 };
	function onLearnDataChange(key: 'ki' | 'kp' | 'kd', data: number[][]) {
		learnTables[key].data = data;
	}
	function onLearnAxisChange(key: 'ki' | 'kp' | 'kd', axis: 'x' | 'y', values: number[]) {
		if (axis === 'x') learnTables[key].xAxisValues = values;
		else learnTables[key].yAxisValues = values;
	}
	function onLearnResize(key: 'ki' | 'kp' | 'kd', rows: number, cols: number) {
		learnTables[key] = resizeTable(learnTables[key], rows, cols, LEARN_FILL[key]);
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
		// ensureSectionData грузит секцию, если она помечена устаревшей (loaded.X=false): при
		// первом раскрытии, после switch/copy карты и после сохранения/отмены автокалибровки
		// (markAllTablesStale ниже). Несохранённые ручные правки при обычном сворачивании НЕ
		// теряются — секция остаётся loaded, повторное раскрытие её не перечитывает.
		if (activeSection === id && isConnected) ensureSectionData(id);
	}

	// Вложенные под-аккордеоны коррекций внутри секции Target (одна открыта за раз).
	let openCorr = $state<string | null>(null);
	function toggleCorr(id: string) {
		openCorr = openCorr === id ? null : id;
		if (openCorr === id && isConnected) ensureSectionData(id);
	}

	// Пометить ВСЕ табличные секции устаревшими → их следующее раскрытие перечитает с устройства.
	// Вызывается после автокалибровки: обученные таблицы на устройстве изменились, кэш в UI устарел.
	function markAllTablesStale() {
		loaded = { target: false, corr: false, learn: false, bias: false, delta: false };
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
			initialLoadDone = true;
			// Карты/настройки/подписи обычно грузит централизованный hydrate() (см. +layout). Здесь —
			// фолбэк (если стор ещё не загружен — грузим сами; in-flight дедуп не даст двойного чтения),
			// плюс ленивые таблицы текущей секции и подписка на live-дельты.
			loaded = { target: false, corr: false, learn: false, bias: false, delta: false };
			if (!boostSettings.loaded) loadBoostSettings();
			if (!boostMaps.loaded) loadBoostMaps();
			if (activeSection) ensureSectionData(activeSection);
		}
		if (!isConnected) {
			initialLoadDone = false;
			clearBaselines();   // подсветка дельт не переживает разрыв связи
		}
	});

	// Подписка на live-дельты обучения через общий стор (ref-counted, сам пере-подписывается
	// на реконнекте). Регистрируем на маунте, снимаем на анмаунте страницы.
	$effect(() => {
		learnDeltaUnsub = onLearnDelta(applyLearnDeltas);
		return () => { if (learnDeltaUnsub) { learnDeltaUnsub(); learnDeltaUnsub = null; } };
	});

	// Свежесть данных: при возврате на вкладку/фокусе перечитываем открытую секцию с устройства
	// (за время отсутствия её могли изменить обучение на лету или другое устройство).
	$effect(() => {
		if (typeof document === 'undefined') return;
		const refresh = () => {
			if (document.visibilityState !== 'visible' || !isConnected) return;
			if (!activeSection) return;
			markSectionStale(activeSection);
			void ensureSectionData(activeSection);
		};
		document.addEventListener('visibilitychange', refresh);
		window.addEventListener('focus', refresh);
		return () => {
			document.removeEventListener('visibilitychange', refresh);
			window.removeEventListener('focus', refresh);
		};
	});

	// Синхронизация редактируемой копии настроек из общего стора (грузится в hydrate()). Клонируем
	// при каждом успешном чтении (epoch++). Несохранённые правки при перезагрузке/реконнекте затираются — ОК.
	let lastSettingsEpoch = 0;
	$effect(() => {
		const e = boostSettings.epoch;
		if (e !== lastSettingsEpoch) {
			lastSettingsEpoch = e;
			settings = $state.snapshot(boostSettings.value) as BoostControllerSettings;
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

		<!-- 1. Включить бустконтроллер + актуатор + CAN-выход (аккордеон) -->
		<section class="rounded-lg bg-[var(--color-dash-card)] border border-[var(--color-dash-border)]/50">
			<button class="w-full flex items-center justify-between p-3" onclick={() => toggleSection('enable')}>
				<span class="text-xs font-bold text-[var(--color-dash-text)] inline-flex items-center gap-1.5">
					{t('boost.enable')}<HelpTip key="help.boost.enable" />
					{#if !settingsLoaded}
						<span class="w-3 h-3 rounded-full border-2 border-[var(--color-dash-border)] border-t-[var(--color-dash-accent)] animate-spin" title={t('common.readingDevice')}></span>
					{:else if settings.enabled}
						<span class="w-2 h-2 rounded-full bg-[var(--color-dash-success)]"></span>
					{/if}
				</span>
				<span class="text-xs text-[var(--color-dash-text-dim)]">{activeSection === 'enable' ? '−' : '+'}</span>
			</button>
			{#if activeSection === 'enable'}
				<div class="px-3 pb-3 space-y-3">
					{#if !settingsLoaded}
						<div class="flex items-center gap-2 text-[11px] text-[var(--color-dash-text-dim)] py-2">
							<span class="w-3 h-3 rounded-full border-2 border-[var(--color-dash-border)] border-t-[var(--color-dash-accent)] animate-spin"></span>
							{t('common.readingDevice')}
						</div>
					{:else}
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
				{/if}
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
						<label class="space-y-1">
							<span class="text-[10px] text-[var(--color-dash-text-dim)] uppercase inline-flex items-center gap-0.5">{t('boost.cltSignal')}<HelpTip key="help.boost.cltSignal" /></span>
							<select bind:value={settings.cltSignalParam}
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
						dimmed={!loaded.target}
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

					<!-- Коррекции цели — вложенные под-аккордеоны (продвинутое) -->
					<div class="pt-3 border-t border-[var(--color-dash-border)]/30 space-y-2">
						<span class="text-[10px] text-[var(--color-dash-text-dim)] uppercase font-bold inline-flex items-center gap-0.5">{t('boost.corrections')}<HelpTip key="help.boost.corrTableSection" /></span>

						<!-- Корр.1 (вложенный) -->
						<div class="rounded bg-[var(--color-dash-bg)]/40 border border-[var(--color-dash-border)]/40">
							<button class="w-full flex items-center justify-between px-2 py-1.5" onclick={() => toggleCorr('corr1')}>
								<span class="text-[11px] text-[var(--color-dash-text)] inline-flex items-center gap-0.5">{t('boost.corr1')}</span>
								<span class="text-[11px] text-[var(--color-dash-text-dim)]">{openCorr === 'corr1' ? '−' : '+'}</span>
							</button>
							{#if openCorr === 'corr1'}
								<div class="px-2 pb-2 space-y-2">
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
										dimmed={!loaded.corr}
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
						</div>

						<!-- Корр.2 (вложенный) -->
						<div class="rounded bg-[var(--color-dash-bg)]/40 border border-[var(--color-dash-border)]/40">
							<button class="w-full flex items-center justify-between px-2 py-1.5" onclick={() => toggleCorr('corr2')}>
								<span class="text-[11px] text-[var(--color-dash-text)] inline-flex items-center gap-0.5">{t('boost.corr2')}</span>
								<span class="text-[11px] text-[var(--color-dash-text-dim)]">{openCorr === 'corr2' ? '−' : '+'}</span>
							</button>
							{#if openCorr === 'corr2'}
								<div class="px-2 pb-2 space-y-2">
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
										dimmed={!loaded.corr}
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
						</div>
					</div>
				</div>
			{/if}
		</section>

		<!-- 4. BIAS (feedforward) — основная карта (особенно для электронного актуатора) -->
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
							dimmed={!loaded.bias}
							xAxisValues={biasTable.xAxisValues}
							yAxisValues={biasTable.yAxisValues}
							numCols={biasTable.numCols}
							numRows={biasTable.numRows}
							xAxisLabel="RPM"
							yAxisLabel="Target kPa"
							liveCursorX={liveRpm}
							liveCursorY={liveTargetMap}
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

		<!-- 5. PID регулятор (Ki, windup, D-фильтр + таблицы Kp/Kd) -->
		<section class="rounded-lg bg-[var(--color-dash-card)] border border-[var(--color-dash-border)]/50">
			<button class="w-full flex items-center justify-between p-3" onclick={() => toggleSection('pid')}>
				<span class="text-xs font-bold text-[var(--color-dash-text)] inline-flex items-center gap-0.5">{t('boost.pid')}<HelpTip key="help.boost.pidSection" /></span>
				<span class="text-xs text-[var(--color-dash-text-dim)]">{activeSection === 'pid' ? '−' : '+'}</span>
			</button>
			{#if activeSection === 'pid'}
				<div class="px-3 pb-3 space-y-2">
					<p class="text-[10px] text-[var(--color-dash-text-dim)]">{t('boost.pidScalarsHint')}</p>
					<div class="grid grid-cols-2 sm:grid-cols-3 gap-2">
						<label class="space-y-1">
							<span class="text-[10px] text-[var(--color-dash-text-dim)] uppercase inline-flex items-center gap-0.5">{t('boost.ki')}<HelpTip key="help.boost.ki" /></span>
							<input type="number" step="0.1" bind:value={settings.ki}
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

					<!-- Kp/Kd по зонам (динамика регулятора) — часть регулятора, но таблицы -->
					<div class="pt-3 border-t border-[var(--color-dash-border)]/30 space-y-4">
						<span class="text-[10px] text-[var(--color-dash-text-dim)] uppercase font-bold inline-flex items-center gap-0.5">{t('boost.pidTables')}<HelpTip key="help.boost.pidTablesViewer" /></span>
						<!-- Kp Zone Table (absolute per-zone value, NOT a multiplier) -->
						<div class="space-y-1">
							<span class="text-[10px] text-[var(--color-dash-text-dim)] uppercase font-bold inline-flex items-center gap-0.5">{t('boost.learnTableKp')}<HelpTip key="help.boost.learnTableKp" /></span>
							<TableEditor
								data={learnKpMultData}
								dimmed={!loaded.learn}
								xAxisValues={learnTables.kp.xAxisValues}
								yAxisValues={learnTables.kp.yAxisValues}
								numCols={learnTables.kp.numCols}
								numRows={learnTables.kp.numRows}
								decimals={1}
								colorGradient={true}
								gradientMin={20}
								gradientMax={300}
								highlight={hlKp}
								xAxisLabel="RPM"
								yAxisLabel="TPS"
								liveCursorX={liveRpm}
								liveCursorY={liveTps}
								resizable={true}
								onResize={(r, c) => onLearnResize('kp', r, c)}
								onDataChange={(d) => onLearnDataChange('kp', d)}
								onAxisChange={(a, v) => onLearnAxisChange('kp', a, v)}
							/>
						</div>
						<!-- Kd Zone Table (absolute per-zone value, NOT a multiplier) -->
						<div class="space-y-1">
							<span class="text-[10px] text-[var(--color-dash-text-dim)] uppercase font-bold inline-flex items-center gap-0.5">{t('boost.learnTableKd')}<HelpTip key="help.boost.learnTableKd" /></span>
							<TableEditor
								data={learnKdMultData}
								dimmed={!loaded.learn}
								xAxisValues={learnTables.kd.xAxisValues}
								yAxisValues={learnTables.kd.yAxisValues}
								numCols={learnTables.kd.numCols}
								numRows={learnTables.kd.numRows}
								decimals={1}
								colorGradient={true}
								gradientMin={20}
								gradientMax={500}
								highlight={hlKd}
								xAxisLabel="RPM"
								yAxisLabel="TPS"
								liveCursorX={liveRpm}
								liveCursorY={liveTps}
								resizable={true}
								onResize={(r, c) => onLearnResize('kd', r, c)}
								onDataChange={(d) => onLearnDataChange('kd', d)}
								onAxisChange={(a, v) => onLearnAxisChange('kd', a, v)}
							/>
						</div>
						<div class="flex gap-2 flex-wrap">
							<button onclick={saveLearnTables} disabled={saving}
								class="px-2 py-1 text-[10px] rounded bg-[var(--color-dash-success)]/15 text-[var(--color-dash-success)] hover:bg-[var(--color-dash-success)]/25 transition-colors disabled:opacity-40">
								{saving ? t('common.saving') : t('common.saveToDevice')}
							</button>
							{@render restoreBtn(restoreLearn)}
							<button onclick={resetLearnTable} disabled={saving}
								class="px-3 py-1.5 text-xs rounded bg-[var(--color-dash-danger)]/15 text-[var(--color-dash-danger)] hover:bg-[var(--color-dash-danger)]/25 transition-colors disabled:opacity-40">
								{t('boost.resetLearn')}
							</button>
						</div>
					</div>
				</div>
			{/if}
		</section>

		<!-- 6. Safety -->
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

		<!-- 7. Спул / переход в PID (deltaMAP + гистерезис + упреждение K + транзиент) -->
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
							dimmed={!loaded.delta}
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
							<span class="text-[10px] text-[var(--color-dash-text-dim)] uppercase inline-flex items-center gap-0.5">{t('boost.phaseRateLead')}<HelpTip key="help.boost.phaseRateLead" /></span>
							<input type="number" step="0.02" min="0" max="1" bind:value={settings.phaseRateLead}
								class="w-full px-2 py-1 text-xs rounded bg-[var(--color-dash-bg)] border border-[var(--color-dash-border)] text-[var(--color-dash-text)] font-mono focus:border-[var(--color-dash-accent)] focus:outline-none" />
						</label>
					</div>
					<!-- dRPM/dt Transient Boost (на резком наборе временно усиливает Kp; для электронного 0) -->
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
					<div class="flex gap-2">
						<button onclick={saveDeltaSection} disabled={saving}
							class="px-2 py-1 text-[10px] rounded bg-[var(--color-dash-success)]/15 text-[var(--color-dash-success)] hover:bg-[var(--color-dash-success)]/25 transition-colors disabled:opacity-40">
							{saving ? t('common.saving') : t('common.saveToDevice')}
						</button>
						{@render restoreBtn(restoreDelta)}
					</div>
				</div>
			{/if}
		</section>

		<!-- 8. Обучение -->
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
					<!-- P7: что именно обучаем (под общим «Включить»). Каждая галочка гейтит свой блок в прошивке. -->
					<div class="pl-6 space-y-1.5 {settings.learnEnabled ? '' : 'opacity-40 pointer-events-none'}">
						<span class="text-[10px] text-[var(--color-dash-text-dim)] uppercase inline-flex items-center gap-0.5">{t('boost.learnWhat')}<HelpTip key="help.boost.learnWhat" /></span>
						<label class="flex items-center gap-2 cursor-pointer">
							<input type="checkbox" bind:checked={settings.learnBias} disabled={!settings.learnEnabled} class="accent-[var(--color-dash-accent)]" />
							<span class="text-xs text-[var(--color-dash-text)] inline-flex items-center gap-0.5">{t('boost.learnBias')}<HelpTip key="help.boost.learnBias" /></span>
						</label>
						<label class="flex items-center gap-2 cursor-pointer">
							<input type="checkbox" bind:checked={settings.learnGains} disabled={!settings.learnEnabled} class="accent-[var(--color-dash-accent)]" />
							<span class="text-xs text-[var(--color-dash-text)] inline-flex items-center gap-0.5">{t('boost.learnGains')}<HelpTip key="help.boost.learnGains" /></span>
						</label>
					</div>
					<!-- Один регулятор скорости калибровки (3 пресета). Остальное — авто (P6). -->
					<div class="space-y-1">
						<span class="text-[10px] text-[var(--color-dash-text-dim)] uppercase inline-flex items-center gap-0.5">{t('boost.calSpeed')}<HelpTip key="help.boost.calSpeed" /></span>
						<div class="flex gap-2">
							{#each CAL_PRESETS as p, i}
								<button onclick={() => applyCalPreset(p)}
									class="flex-1 px-2 py-1.5 text-[11px] rounded transition-colors
										{activeCalPreset === i
											? 'bg-[var(--color-dash-accent)] text-black font-bold'
											: 'bg-[var(--color-dash-border)]/50 text-[var(--color-dash-text-dim)] hover:text-[var(--color-dash-text)]'}">
									{t(p.key)}
								</button>
							{/each}
						</div>
						<p class="text-[10px] text-[var(--color-dash-text-dim)]">{t('boost.calSpeedHint')}</p>
					</div>

					<!-- Ручная скорость обучения BIAS (тонкая настройка поверх пресета скорости) -->
					<label class="space-y-1 block">
						<span class="text-[10px] text-[var(--color-dash-text-dim)] uppercase inline-flex items-center gap-0.5">{t('boost.learnBiasRate')}<HelpTip key="help.boost.learnBiasRate" /></span>
						<input type="number" step="0.01" min="0" max="1" bind:value={settings.learnBiasRate}
							class="w-32 px-2 py-1 text-xs rounded bg-[var(--color-dash-bg)] border border-[var(--color-dash-border)] text-[var(--color-dash-text)] font-mono focus:border-[var(--color-dash-accent)] focus:outline-none" />
					</label>

					<!-- P7: автообучение всегда активно (при «Включить»); авто-сейв с гейтами + эталон -->
					<div class="pt-2 border-t border-[var(--color-dash-border)]/30 space-y-2">
						<span class="text-[10px] text-[var(--color-dash-text-dim)] uppercase font-bold inline-flex items-center gap-0.5">{t('boost.autoLearn')}<HelpTip key="help.boost.autoLearn" /></span>
						<div class="grid grid-cols-2 sm:grid-cols-3 gap-2">
							<label class="space-y-1">
								<span class="text-[10px] text-[var(--color-dash-text-dim)] uppercase">{t('boost.learnMinClt')}</span>
								<input type="number" step="1" bind:value={settings.learnMinClt}
									class="w-full px-2 py-1 text-xs rounded bg-[var(--color-dash-bg)] border border-[var(--color-dash-border)] text-[var(--color-dash-text)] font-mono focus:border-[var(--color-dash-accent)] focus:outline-none" />
							</label>
							<label class="space-y-1">
								<span class="text-[10px] text-[var(--color-dash-text-dim)] uppercase">{t('boost.learnSaveInterval')}</span>
								<input type="number" step="1" min="5" max="30" bind:value={settings.learnSaveIntervalMin}
									class="w-full px-2 py-1 text-xs rounded bg-[var(--color-dash-bg)] border border-[var(--color-dash-border)] text-[var(--color-dash-text)] font-mono focus:border-[var(--color-dash-accent)] focus:outline-none" />
							</label>
							<label class="space-y-1">
								<span class="text-[10px] text-[var(--color-dash-text-dim)] uppercase">{t('boost.learnSaveMaxTps')}</span>
								<input type="number" step="1" min="0" bind:value={settings.learnSaveMaxTps}
									class="w-full px-2 py-1 text-xs rounded bg-[var(--color-dash-bg)] border border-[var(--color-dash-border)] text-[var(--color-dash-text)] font-mono focus:border-[var(--color-dash-accent)] focus:outline-none" />
							</label>
						</div>
						<p class="text-[10px] text-[var(--color-dash-text-dim)]">{t('boost.autoLearnHint')}</p>
						<div class="flex gap-2 flex-wrap">
							<button onclick={saveLearnNow} disabled={!isConnected}
								class="px-2 py-1 text-[10px] rounded bg-[var(--color-dash-accent)]/15 text-[var(--color-dash-accent)] hover:bg-[var(--color-dash-accent)]/25 transition-colors disabled:opacity-40">
								{t('boost.learnSaveNow')}
							</button>
							<button onclick={commitBaseline} disabled={!isConnected}
								class="px-2 py-1 text-[10px] rounded bg-[var(--color-dash-border)]/50 text-[var(--color-dash-text-dim)] hover:text-[var(--color-dash-text)] hover:bg-[var(--color-dash-border)]/60 transition-colors disabled:opacity-40">
								{t('boost.commitBaseline')}
							</button>
							<button onclick={revertBaseline} disabled={!isConnected}
								class="px-2 py-1 text-[10px] rounded bg-[var(--color-dash-danger)]/10 text-[var(--color-dash-danger)] border border-[var(--color-dash-danger)]/20 hover:bg-[var(--color-dash-danger)]/20 transition-colors disabled:opacity-40">
								{t('boost.revertBaseline')}
							</button>
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

	{/if}
</div>
