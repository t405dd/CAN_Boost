<script lang="ts">
	import { readJsonConfig, writeJsonConfig } from '$lib/ble/chunked-transfer';
	import { bleState } from '$lib/stores/ble-connection.svelte';
	import { SVC_CAN_CONFIG, CHR_CAN_OUT_TABLES, CHR_CAN_OUT_SETTINGS } from '$lib/ble/uuids';
	import type { CanOutTable, FirmwareCanOutTable, Co1Settings } from '$lib/types/config';
	import { firmwareToCanOutTable, canOutTableToFirmware } from '$lib/utils/can-out-adapter';
	import { t } from '$lib/i18n/index.svelte';
	import HelpTip from '$lib/components/HelpTip.svelte';
	import TableEditor from '$lib/components/TableEditor.svelte';
	import ParamPickerModal from '$lib/components/ParamPickerModal.svelte';
	import ConnectPrompt from '$lib/components/ConnectPrompt.svelte';
	import { allParamEntries, pwaNameToEnum } from '$lib/utils/param-mapping';
	import { PARAM_CACHE_SLOT_START } from '$lib/ble/protocol';
	import { liveData } from '$lib/stores/live-data.svelte';
	import { getParamDisplayName, getParamShortName, signalLabels } from '$lib/stores/signal-labels.svelte';
	import { co1Config, loadCo1Config, defaultCo1Settings } from '$lib/stores/co1-settings.svelte';

	const TABLE_LABELS_KEYS = ['canTx.t1base', 'canTx.t2mult', 'canTx.t3trim', 'canTx.t4trim'] as const;
	const TABLE_IDS = ['T1_Base', 'T2_Multiplier', 'T3_TrimX', 'T4_TrimX2'];
	const MAX_SIZE = 16;

	// Gradient bounds per table type
	const GRADIENT_BOUNDS: [number, number][] = [
		[0, 100],    // T1 Base: duty 0-100%
		[50, 150],   // T2 Multiplier: 50-150%
		[50, 150],   // T3 Trim: 50-150%
		[50, 150],   // T4 Trim: 50-150%
	];

	let tables = $state<CanOutTable[]>(createDefaultTables());
	let activeTab = $state(0);
	let loading = $state(false);
	let saving = $state(false);
	let statusMsg = $state('');

	// --- CO1 Bus Settings (источник истины — общий стор co1Config, грузится в hydrate() на коннекте) ---
	let co1Settings = $state<Co1Settings>(defaultCo1Settings());   // редактируемая копия (синхронит $effect ниже)
	let co1Loading = $state(false);
	// Прочитаны ли настройки CO1 с устройства — пока false, не показываем дефолты (0x269 и т.п.) как реальные.
	let co1Loaded = $derived(co1Config.loaded);
	let co1Saving = $state(false);
	let co1StatusMsg = $state('');
	let co1CanIdHex = $state('269');

	function showCo1Status(msg: string, durationMs = 3000) {
		co1StatusMsg = msg;
		setTimeout(() => { co1StatusMsg = ''; }, durationMs);
	}

	// Перечитать настройки CO1 с устройства в общий стор. Редактируемую копию обновит $effect-синхронизатор.
	async function loadCo1Settings() {
		co1Loading = true;
		try {
			const ok = await loadCo1Config();
			showCo1Status(ok ? t('logging.loaded') : t('canRx.loadFailed'));
		} catch (e) {
			showCo1Status(t('canRx.loadFailed') + ': ' + (e as Error).message);
		} finally {
			co1Loading = false;
		}
	}

	async function saveCo1Settings() {
		co1Saving = true;
		try {
			co1Settings.canId = parseInt(co1CanIdHex, 16) || 0x269;
			const ok = await writeJsonConfig(SVC_CAN_CONFIG, CHR_CAN_OUT_SETTINGS, co1Settings);
			if (ok) co1Config.value = $state.snapshot(co1Settings);   // стор = то, что на устройстве
			showCo1Status(ok ? t('canRx.savedOk') : t('canRx.saveFailed'));
		} catch (e) {
			showCo1Status(t('canRx.saveFailed') + ': ' + (e as Error).message);
		} finally {
			co1Saving = false;
		}
	}

	let isConnected = $derived(bleState.status === 'connected');

	// Param picker state
	let paramPickerOpen = $state(false);
	let paramPickerTarget = $state<'x' | 'y'>('x');
	// Показываем системные параметры + ТОЛЬКО те cache-слоты, в которые реально
	// замаплен сигнал (есть подпись). Иначе пикер забит пустыми cache0…cache39.
	let knownParams = $derived(
		allParamEntries()
			.filter(p => p.enumVal < PARAM_CACHE_SLOT_START || signalLabels[p.enumVal - PARAM_CACHE_SLOT_START] !== undefined)
			.map(p => p.pwaName)
	);

	function openParamPicker(axis: 'x' | 'y') {
		paramPickerTarget = axis;
		paramPickerOpen = true;
	}

	function onParamSelect(param: string) {
		if (paramPickerTarget === 'x') {
			tables[activeTab].xAxisParamType = param;
		} else {
			tables[activeTab].yAxisParamType = param;
		}
		paramPickerOpen = false;
	}

	// Live cursor: get current engine value for a PWA param name
	function getLiveValue(pwaName: string): number | undefined {
		if (!pwaName) return undefined;
		const enumVal = pwaNameToEnum(pwaName);
		if (enumVal === 0) return undefined; // NONE
		const param = liveData.params[enumVal];
		return param?.value;
	}

	let liveCursorX = $derived(getLiveValue(tables[activeTab].xAxisParamType));
	let liveCursorY = $derived(
		tables[activeTab].hasYAxis ? getLiveValue(tables[activeTab].yAxisParamType) : undefined
	);

	function showStatus(msg: string, durationMs = 3000) {
		statusMsg = msg;
		setTimeout(() => { statusMsg = ''; }, durationMs);
	}

	function createDefaultTable(idx: number): CanOutTable {
		return {
			tableIdBase: TABLE_IDS[idx],
			xAxisParamType: '',
			yAxisParamType: '',
			numCols: 1,
			numRows: 1,
			hasYAxis: false,
			isEnabled: false,
			xAxisValues: Array(16).fill(0),
			yAxisValues: Array(16).fill(0),
			tableData: Array.from({ length: 16 }, () => Array(16).fill(0))
		};
	}

	function createDefaultTables(): CanOutTable[] {
		return TABLE_IDS.map((_, i) => createDefaultTable(i));
	}

	async function loadConfig() {
		loading = true;
		statusMsg = '';
		try {
			const rawData = await readJsonConfig<FirmwareCanOutTable[]>(SVC_CAN_CONFIG, CHR_CAN_OUT_TABLES);
			if (rawData && rawData.length > 0) {
				for (let i = 0; i < 4; i++) {
					if (rawData[i]) {
						tables[i] = firmwareToCanOutTable(rawData[i]);
					}
				}
				showStatus(t('canRx.loaded', rawData.length));
			} else {
				showStatus(t('canRx.noConfig'));
			}
		} catch (e) {
			showStatus(t('canRx.loadFailed') + ': ' + (e as Error).message);
		} finally {
			loading = false;
		}
	}

	async function saveConfig() {
		saving = true;
		statusMsg = '';
		try {
			const fwTables = tables.map(canOutTableToFirmware);
			const ok = await writeJsonConfig(SVC_CAN_CONFIG, CHR_CAN_OUT_TABLES, fwTables);
			showStatus(ok ? t('canRx.savedOk') : t('canRx.saveFailed'));
		} catch (e) {
			showStatus(t('canRx.saveFailed') + ': ' + (e as Error).message);
		} finally {
			saving = false;
		}
	}

	function setNumCols(val: number) {
		tables[activeTab].numCols = Math.max(1, Math.min(MAX_SIZE, val));
	}

	function setNumRows(val: number) {
		tables[activeTab].numRows = Math.max(1, Math.min(MAX_SIZE, val));
		if (!tables[activeTab].hasYAxis) {
			tables[activeTab].numRows = 1;
		}
	}

	function toggleYAxis() {
		tables[activeTab].hasYAxis = !tables[activeTab].hasYAxis;
		if (!tables[activeTab].hasYAxis) {
			tables[activeTab].numRows = 1;
		}
	}

	function onDataChange(newData: number[][]) {
		tables[activeTab].tableData = newData;
	}

	function onAxisChange(axis: 'x' | 'y', values: number[]) {
		if (axis === 'x') {
			tables[activeTab].xAxisValues = values;
		} else {
			tables[activeTab].yAxisValues = values;
		}
	}

	// --- Auto-load on connect ---
	let initialLoadDone = $state(false);

	$effect(() => {
		if (isConnected && !initialLoadDone) {
			initialLoadDone = true;
			// Настройки CO1 и подписи грузит централизованный hydrate() (см. +layout). Здесь — только
			// таблицы CAN-выхода (большой конфиг, нужен лишь на этой странице).
			loadConfig();
		}
		if (!isConnected) {
			initialLoadDone = false;
		}
	});

	// Синхронизация редактируемой копии CO1 из общего стора (грузится в hydrate()). Клонируем при
	// каждом успешном чтении (epoch++); также обновляем hex-поле CAN ID.
	let lastCo1Epoch = 0;
	$effect(() => {
		const e = co1Config.epoch;
		if (e !== lastCo1Epoch) {
			lastCo1Epoch = e;
			co1Settings = $state.snapshot(co1Config.value) as Co1Settings;
			co1CanIdHex = co1Config.value.canId.toString(16).toUpperCase();
		}
	});
</script>

<div class="space-y-3">
	<div class="text-xs text-[var(--color-dash-text-dim)] uppercase tracking-wider">{t('canTx.title')}</div>

	{#if bleState.status !== 'connected'}
		<ConnectPrompt />
	{:else}
		<!-- CO1 Bus Address Settings -->
		<div class="rounded-lg bg-[var(--color-dash-card)] border border-[var(--color-dash-border)]/50 p-3 space-y-3">
			<div class="flex items-center gap-2 flex-wrap">
				<span class="text-xs text-[var(--color-dash-text-dim)] uppercase tracking-wider inline-flex items-center gap-1">
					{t('canTx.co1Settings')}<HelpTip key="help.canTx.co1Settings" />
				</span>
				<button onclick={loadCo1Settings} disabled={co1Loading}
					class="ml-auto px-3 py-1.5 text-xs rounded bg-[var(--color-dash-accent)]/15 text-[var(--color-dash-accent)] hover:bg-[var(--color-dash-accent)]/25 transition-colors disabled:opacity-40">
					{co1Loading ? t('common.loading') : t('common.loadFromDevice')}
				</button>
				<button onclick={saveCo1Settings} disabled={co1Saving}
					class="px-3 py-1.5 text-xs rounded bg-[var(--color-dash-success)]/15 text-[var(--color-dash-success)] hover:bg-[var(--color-dash-success)]/25 transition-colors disabled:opacity-40">
					{co1Saving ? t('common.saving') : t('common.saveToDevice')}
				</button>
				{#if co1StatusMsg}
					<span class="text-xs text-[var(--color-dash-text-dim)]">{co1StatusMsg}</span>
				{/if}
			</div>
			{#if !co1Loaded}
				<div class="flex items-center gap-2 text-[11px] text-[var(--color-dash-text-dim)] py-1">
					<span class="w-3 h-3 rounded-full border-2 border-[var(--color-dash-border)] border-t-[var(--color-dash-accent)] animate-spin"></span>
					{t('common.readingDevice')}
				</div>
			{:else}
			<div class="flex items-center gap-4 flex-wrap">
				<!-- CAN ID -->
				<div class="flex items-center gap-1.5">
					<span class="text-[10px] text-[var(--color-dash-text-dim)] uppercase inline-flex items-center gap-0.5">{t('canTx.canId')}<HelpTip key="help.canTx.canId" /></span>
					<button onclick={() => { const v = (parseInt(co1CanIdHex, 16) || 0) - 1; if (v >= 0) co1CanIdHex = v.toString(16).toUpperCase(); }}
						class="w-5 h-5 flex items-center justify-center text-xs rounded bg-[var(--color-dash-bg)] border border-[var(--color-dash-border)] text-[var(--color-dash-text-dim)] hover:text-[var(--color-dash-accent)] hover:border-[var(--color-dash-accent)] transition-colors">&minus;</button>
					<span class="text-xs text-[var(--color-dash-text-dim)]">0x</span>
					<input type="text" bind:value={co1CanIdHex} maxlength="8"
						class="w-20 px-2 py-1 text-xs rounded bg-[var(--color-dash-bg)] border border-[var(--color-dash-border)] text-[var(--color-dash-text)] font-mono uppercase focus:border-[var(--color-dash-accent)] focus:outline-none" />
					<button onclick={() => { const v = (parseInt(co1CanIdHex, 16) || 0) + 1; if (v <= 0x1FFFFFFF) co1CanIdHex = v.toString(16).toUpperCase(); }}
						class="w-5 h-5 flex items-center justify-center text-xs rounded bg-[var(--color-dash-bg)] border border-[var(--color-dash-border)] text-[var(--color-dash-text-dim)] hover:text-[var(--color-dash-accent)] hover:border-[var(--color-dash-accent)] transition-colors">+</button>
					<span class="text-[10px] text-[var(--color-dash-text-dim)] font-mono">= {parseInt(co1CanIdHex, 16) || 0} dec</span>
				</div>
				<!-- Byte offset -->
				<label class="flex items-center gap-1.5">
					<span class="text-[10px] text-[var(--color-dash-text-dim)] uppercase inline-flex items-center gap-0.5">{t('canTx.canByteOffset')}<HelpTip key="help.canTx.canByteOffset" /></span>
					<input type="number" min="0" max="6" bind:value={co1Settings.canByteOffset}
						class="w-14 px-2 py-1 text-xs rounded bg-[var(--color-dash-bg)] border border-[var(--color-dash-border)] text-[var(--color-dash-text)] font-mono text-center focus:border-[var(--color-dash-accent)] focus:outline-none" />
				</label>
				<!-- Big-endian -->
				<label class="flex items-center gap-1.5 cursor-pointer pb-0.5">
					<input type="checkbox" bind:checked={co1Settings.canBigEndian}
						class="accent-[var(--color-dash-accent)]" />
					<span class="text-xs text-[var(--color-dash-text)] inline-flex items-center gap-0.5">{t('canTx.canBigEndian')}<HelpTip key="help.canTx.canBigEndian" /></span>
				</label>
				<!-- Send interval -->
				<label class="flex items-center gap-1.5">
					<span class="text-[10px] text-[var(--color-dash-text-dim)] uppercase inline-flex items-center gap-0.5">{t('canTx.canInterval')}<HelpTip key="help.canTx.canInterval" /></span>
					<input type="number" min="10" max="1000" step="10" bind:value={co1Settings.canSendIntervalMs}
						class="w-20 px-2 py-1 text-xs rounded bg-[var(--color-dash-bg)] border border-[var(--color-dash-border)] text-[var(--color-dash-text)] font-mono text-center focus:border-[var(--color-dash-accent)] focus:outline-none" />
				</label>
			</div>
			{/if}
		</div>
		<!-- Action bar -->
		<div class="flex items-center gap-2 flex-wrap">
			<button onclick={loadConfig} disabled={loading}
				class="px-3 py-1.5 text-xs rounded bg-[var(--color-dash-accent)]/15 text-[var(--color-dash-accent)] hover:bg-[var(--color-dash-accent)]/25 transition-colors disabled:opacity-40">
				{loading ? t('common.loading') : t('common.loadFromDevice')}
			</button>
			<button onclick={saveConfig} disabled={saving}
				class="px-3 py-1.5 text-xs rounded bg-[var(--color-dash-success)]/15 text-[var(--color-dash-success)] hover:bg-[var(--color-dash-success)]/25 transition-colors disabled:opacity-40">
				{saving ? t('common.saving') : t('common.saveToDevice')}
			</button>
			{#if statusMsg}
				<span class="text-xs text-[var(--color-dash-text-dim)] ml-auto">{statusMsg}</span>
			{/if}
		</div>

		<!-- Tabs -->
		<div class="flex gap-0 border-b border-[var(--color-dash-border)]/50">
			{#each TABLE_LABELS_KEYS as key, idx}
				<button onclick={() => activeTab = idx}
					class="px-3 py-2 text-xs transition-colors border-b-2 -mb-px
						{activeTab === idx
							? 'border-[var(--color-dash-accent)] text-[var(--color-dash-accent)]'
							: 'border-transparent text-[var(--color-dash-text-dim)] hover:text-[var(--color-dash-text)]'}">
					{t(key)}
				</button>
			{/each}
		</div>

		<!-- Active table config -->
		<div class="rounded-lg bg-[var(--color-dash-card)] border border-[var(--color-dash-border)]/50 p-3 space-y-3">
			<!-- Table properties row -->
			<div class="flex items-end gap-3 flex-wrap">
				<!-- Enable toggle -->
				<label class="flex items-center gap-1.5 cursor-pointer">
					<input type="checkbox" bind:checked={tables[activeTab].isEnabled}
						class="accent-[var(--color-dash-accent)]" />
					<span class="text-xs text-[var(--color-dash-text)] inline-flex items-center gap-0.5">{t('common.enabled')}<HelpTip key="help.canTx.enable" /></span>
				</label>

				<!-- Has Y-axis toggle -->
				<label class="flex items-center gap-1.5 cursor-pointer">
					<input type="checkbox" checked={tables[activeTab].hasYAxis}
						onchange={toggleYAxis}
						class="accent-[var(--color-dash-accent)]" />
					<span class="text-xs text-[var(--color-dash-text)] inline-flex items-center gap-0.5">{t('canTx.is2d')}<HelpTip key="help.canTx.is2d" /></span>
				</label>

				<!-- X-axis param -->
				<div class="space-y-1">
					<span class="text-[10px] text-[var(--color-dash-text-dim)] uppercase inline-flex items-center gap-0.5">{t('canTx.xParam')}<HelpTip key="help.canTx.xParam" /></span>
					<button onclick={() => openParamPicker('x')}
						class="block max-w-48 px-2 py-1 text-xs rounded bg-[var(--color-dash-bg)] border border-[var(--color-dash-border)] text-[var(--color-dash-accent)] text-left truncate hover:border-[var(--color-dash-accent)] transition-colors">
						{tables[activeTab].xAxisParamType ? getParamDisplayName(tables[activeTab].xAxisParamType) : '—'}
					</button>
				</div>

				<!-- Y-axis param (only if 2D) -->
				{#if tables[activeTab].hasYAxis}
					<div class="space-y-1">
						<span class="text-[10px] text-[var(--color-dash-text-dim)] uppercase inline-flex items-center gap-0.5">{t('canTx.yParam')}<HelpTip key="help.canTx.yParam" /></span>
						<button onclick={() => openParamPicker('y')}
							class="block max-w-48 px-2 py-1 text-xs rounded bg-[var(--color-dash-bg)] border border-[var(--color-dash-border)] text-[var(--color-dash-accent)] text-left truncate hover:border-[var(--color-dash-accent)] transition-colors">
							{tables[activeTab].yAxisParamType ? getParamDisplayName(tables[activeTab].yAxisParamType) : '—'}
						</button>
					</div>
				{/if}

				<!-- Cols -->
				<label class="space-y-1">
					<span class="text-[10px] text-[var(--color-dash-text-dim)] uppercase inline-flex items-center gap-0.5">{t('canTx.cols')}<HelpTip key="help.canTx.cols" /></span>
					<input type="number" min="1" max={MAX_SIZE} value={tables[activeTab].numCols}
						onchange={(e) => setNumCols(parseInt(e.currentTarget.value) || 1)}
						class="w-14 px-2 py-1 text-xs rounded bg-[var(--color-dash-bg)] border border-[var(--color-dash-border)] text-[var(--color-dash-text)] font-mono text-center focus:border-[var(--color-dash-accent)] focus:outline-none" />
				</label>

				<!-- Rows (only if 2D) -->
				{#if tables[activeTab].hasYAxis}
					<label class="space-y-1">
						<span class="text-[10px] text-[var(--color-dash-text-dim)] uppercase inline-flex items-center gap-0.5">{t('canTx.rows')}<HelpTip key="help.canTx.rows" /></span>
						<input type="number" min="1" max={MAX_SIZE} value={tables[activeTab].numRows}
							onchange={(e) => setNumRows(parseInt(e.currentTarget.value) || 1)}
							class="w-14 px-2 py-1 text-xs rounded bg-[var(--color-dash-bg)] border border-[var(--color-dash-border)] text-[var(--color-dash-text)] font-mono text-center focus:border-[var(--color-dash-accent)] focus:outline-none" />
					</label>
				{/if}

				<!-- Size display -->
				<span class="text-[10px] text-[var(--color-dash-text-dim)] pb-1">
					{tables[activeTab].numCols} x {tables[activeTab].hasYAxis ? tables[activeTab].numRows : 1}
				</span>
			</div>

			<!-- Table Editor -->
			{#key activeTab}
				<TableEditor
					data={tables[activeTab].tableData}
					xAxisValues={tables[activeTab].xAxisValues}
					yAxisValues={tables[activeTab].hasYAxis ? tables[activeTab].yAxisValues : undefined}
					numCols={tables[activeTab].numCols}
					numRows={tables[activeTab].hasYAxis ? tables[activeTab].numRows : 1}
					colorGradient={true}
					gradientMin={GRADIENT_BOUNDS[activeTab][0]}
					gradientMax={GRADIENT_BOUNDS[activeTab][1]}
					xAxisLabel={tables[activeTab].xAxisParamType ? getParamShortName(tables[activeTab].xAxisParamType) : undefined}
					yAxisLabel={tables[activeTab].yAxisParamType ? getParamShortName(tables[activeTab].yAxisParamType) : undefined}
					{liveCursorX}
					{liveCursorY}
					{onDataChange}
					{onAxisChange}
				/>
			{/key}
		</div>
	{/if}
</div>

<ParamPickerModal
	open={paramPickerOpen}
	{knownParams}
	currentValue={paramPickerTarget === 'x' ? tables[activeTab].xAxisParamType : tables[activeTab].yAxisParamType}
	onselect={onParamSelect}
	onclose={() => paramPickerOpen = false}
/>
