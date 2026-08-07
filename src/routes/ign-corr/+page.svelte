<script lang="ts">
	import { readJsonConfig, writeJsonConfig } from '$lib/ble/chunked-transfer';
	import { bleState } from '$lib/stores/ble-connection.svelte';
	import { SVC_CAN_CONFIG, CHR_IGN_CORR, CHR_IGN_TABLES } from '$lib/ble/uuids';
	import type { CanOutTable, FirmwareCanOutTable, IgnCorrSettings } from '$lib/types/config';
	import { IGN_CORR_MODE_GENERIC, IGN_CORR_MODE_MS3_SPKADJ } from '$lib/types/config';
	import { firmwareToCanOutTable, canOutTableToFirmware } from '$lib/utils/can-out-adapter';
	import { t } from '$lib/i18n/index.svelte';
	import HelpTip from '$lib/components/HelpTip.svelte';
	import TableEditor from '$lib/components/TableEditor.svelte';
	import ConnectPrompt from '$lib/components/ConnectPrompt.svelte';
	import { allParamEntries, pwaNameToEnum } from '$lib/utils/param-mapping';
	import { PARAM_CACHE_SLOT_START, PARAM_IGN_CORR_BASE, PARAM_IGN_CORR_MUL } from '$lib/ble/protocol';
	import { liveData } from '$lib/stores/live-data.svelte';
	import { getParamDisplayName, getParamShortName, signalLabels } from '$lib/stores/signal-labels.svelte';
	import { deviceState } from '$lib/stores/device-state.svelte';

	// Карта коррекции УОЗ: устройство считает поправку к углу (база × множитель) и
	// командует её ЭБУ. Знак как у приёмника: + = опережение, − = откат. Разделение
	// «расчёт ↔ доставка» здесь НЕ делаем (в отличие от TBL1..4): у карты ровно один
	// адресат, держать её CAN-адрес на другой странице было бы лишним прыжком.

	const NUM_TABLES = 2;
	const TABLE_LABEL_KEYS = ['ign.t1base', 'ign.t2mul'] as const;
	const TABLE_IDS = ['T1_Base', 'T2_Multiplier1'];
	const MAX_SIZE = 16;

	// Градиент базы расходится от нуля (откат ↔ опережение), множитель — проценты.
	const GRADIENT_BOUNDS: [number, number][] = [[-12, 12], [50, 150]];
	// Результат таблицы приходит ИЗ ПРОШИВКИ (единый источник правды), а не считается в браузере.
	const TABLE_RESULT_PARAM = [PARAM_IGN_CORR_BASE, PARAM_IGN_CORR_MUL];
	const TABLE_RESULT_LABEL = ['IgnBase', 'IgnMul'];

	function defaultSettings(): IgnCorrSettings {
		return {
			en: false, canEn: true, mode: IGN_CORR_MODE_MS3_SPKADJ,
			canId: 0x26b, canByteOffset: 0, canBigEndian: true, canSigned: true,
			canSendIntervalMs: 50, scale: 10, zeroOffset: 0, maxDeg: 0, minDeg: -10,
			ms3To: 0, ms3From: 1, ms3Table: 7, ms3Offset: 632
		};
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

	let isConnected = $derived(bleState.status === 'connected');
	let canAvailable = $derived(deviceState.canEnabled !== false);

	let settings = $state<IgnCorrSettings>(defaultSettings());
	let live = $state<IgnCorrSettings | null>(null);
	let canIdHex = $state('26B');
	let settingsLoaded = $state(false);
	let tables = $state<CanOutTable[]>(TABLE_IDS.map((_, i) => createDefaultTable(i)));
	let tablesLoaded = $state(false);
	let loading = $state(false);
	let saving = $state(false);
	let statusMsg = $state('');
	let activeSection = $state<string | null>('t0');
	let refreshTimer: ReturnType<typeof setInterval> | null = null;

	function showStatus(msg: string, durationMs = 3000) {
		statusMsg = msg;
		setTimeout(() => { statusMsg = ''; }, durationMs);
	}

	// Опции осей — те же, что у таблиц выходов: системные параметры + ТОЛЬКО замапленные
	// cache-слоты (иначе список забит пустыми cache0…cache39).
	const isCacheSlot = (enumVal: number) =>
		enumVal >= PARAM_CACHE_SLOT_START && enumVal < PARAM_CACHE_SLOT_START + 40;
	let paramOptions = $derived(
		allParamEntries().filter(p =>
			p.enumVal > 1 &&
			(!isCacheSlot(p.enumVal) || signalLabels[p.enumVal - PARAM_CACHE_SLOT_START] !== undefined)
		)
	);
	const AXIS_FRIENDLY_PWA: Record<string, string> = {
		boost_drpm: 'RPMdot', map_dot: 'MAPdot', tps_dot: 'TPSdot',
		co1: 'TBL1', out2: 'TBL2', out3: 'TBL3', out4: 'TBL4'
	};
	const axisOptionLabel = (pwaName: string) => AXIS_FRIENDLY_PWA[pwaName] ?? getParamDisplayName(pwaName);
	const axisShortLabel = (pwaName: string) => AXIS_FRIENDLY_PWA[pwaName] ?? getParamShortName(pwaName);

	function getLiveValue(pwaName: string): number | undefined {
		if (!pwaName) return undefined;
		const enumVal = pwaNameToEnum(pwaName);
		if (enumVal === 0) return undefined;
		return liveData.params[enumVal]?.value;
	}
	function getFirmwareTableResult(idx: number): number | undefined {
		return liveData.params[TABLE_RESULT_PARAM[idx]]?.value;
	}

	let isMs3 = $derived(settings.mode === IGN_CORR_MODE_MS3_SPKADJ);

	// Что реально уйдёт в кадр при текущем значении — считаем ровно как прошивка,
	// чтобы адрес/масштаб можно было сверить с приёмником не «вслепую».
	// В режиме MS3 это знаковый int16 град×10, в generic — uint16 со scale/offset.
	let rawPreview = $derived.by(() => {
		const deg = live?.value ?? 0;
		if (isMs3) return Math.max(-450, Math.min(450, Math.round(deg * 10)));
		const raw = Math.round(deg * settings.scale + settings.zeroOffset);
		return settings.canSigned
			? Math.max(-32768, Math.min(32767, raw))
			: Math.max(0, Math.min(65535, raw));
	});
	// 29-битный ID команды считает прошивка (единый источник правды); пока не пришёл — прочерк.
	let ms3IdHex = $derived(live?.ms3Id !== undefined ? '0x' + live.ms3Id.toString(16).toUpperCase().padStart(8, '0') : '—');
	const fmtDeg = (v: number) => (v >= 0 ? '+' : '') + v.toFixed(1) + '°';

	async function loadSettings(silent = false) {
		const data = await readJsonConfig<IgnCorrSettings>(SVC_CAN_CONFIG, CHR_IGN_CORR);
		if (data) {
			live = data;
			if (!silent || !settingsLoaded) {
				settings = { ...defaultSettings(), ...data };
				canIdHex = settings.canId.toString(16).toUpperCase();
			}
			settingsLoaded = true;
		}
	}

	async function fetchTables() {
		const raw = await readJsonConfig<FirmwareCanOutTable[]>(SVC_CAN_CONFIG, CHR_IGN_TABLES);
		if (raw && raw.length > 0) {
			for (let i = 0; i < NUM_TABLES; i++) {
				if (raw[i]) tables[i] = firmwareToCanOutTable(raw[i]);
			}
		}
		tablesLoaded = true;
	}

	async function saveSettings() {
		saving = true;
		try {
			settings.canId = parseInt(canIdHex, 16) || 0x26b;
			// live-поля (value/base/mul) — только для чтения, обратно не отправляем
			const { value, base, mul, ms3Id, ...clean } = $state.snapshot(settings);
			const ok = await writeJsonConfig(SVC_CAN_CONFIG, CHR_IGN_CORR, clean);
			showStatus(ok ? t('canRx.savedOk') : t('canRx.saveFailed'));
			if (ok) await loadSettings(true);
		} catch (e) {
			showStatus(t('canRx.saveFailed') + ': ' + (e as Error).message);
		} finally {
			saving = false;
		}
	}

	async function saveTables() {
		saving = true;
		try {
			const fw = tables.slice(0, NUM_TABLES).map(canOutTableToFirmware);
			const ok = await writeJsonConfig(SVC_CAN_CONFIG, CHR_IGN_TABLES, fw);
			showStatus(ok ? t('canRx.savedOk') : t('canRx.saveFailed'));
		} catch (e) {
			showStatus(t('canRx.saveFailed') + ': ' + (e as Error).message);
		} finally {
			saving = false;
		}
	}

	async function restore(loadFn: () => Promise<unknown>) {
		loading = true;
		try {
			await loadFn();
			showStatus(t('common.restoredFromFlash'));
		} catch (e) {
			showStatus(t('canRx.loadFailed') + ': ' + (e as Error).message);
		} finally {
			loading = false;
		}
	}

	function onResize(idx: number, rows: number, cols: number) {
		const tbl = tables[idx];
		tbl.numCols = Math.max(1, Math.min(MAX_SIZE, cols));
		tbl.numRows = Math.max(1, Math.min(MAX_SIZE, rows));
		tbl.hasYAxis = tbl.numRows > 1;
	}
	function onDataChange(idx: number, newData: number[][]) { tables[idx].tableData = newData; }
	function onAxisChange(idx: number, axis: 'x' | 'y', values: number[]) {
		if (axis === 'x') tables[idx].xAxisValues = values;
		else tables[idx].yAxisValues = values;
	}
	function toggleSection(id: string) { activeSection = activeSection === id ? null : id; }

	let initialLoadDone = $state(false);
	$effect(() => {
		if (isConnected && !initialLoadDone) {
			initialLoadDone = true;
			loading = true;
			loadSettings().catch(() => {});
			fetchTables()
				.catch((e) => showStatus(t('canRx.loadFailed') + ': ' + (e as Error).message))
				.finally(() => { loading = false; });
			refreshTimer = setInterval(() => { loadSettings(true).catch(() => {}); }, 3000);
		}
		if (!isConnected) {
			initialLoadDone = false;
			settingsLoaded = false;
			tablesLoaded = false;
			live = null;
			if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
		}
		return () => {
			if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
		};
	});

	const inputClass = 'px-2 py-1 text-xs rounded bg-[var(--color-dash-bg)] border border-[var(--color-dash-border)] text-[var(--color-dash-text)] font-mono focus:border-[var(--color-dash-accent)] focus:outline-none';
	const labelClass = 'text-[10px] text-[var(--color-dash-text-dim)] uppercase';
</script>

<div class="space-y-3">
	<div class="text-xs text-[var(--color-dash-text-dim)] uppercase tracking-wider inline-flex items-center gap-1">
		{t('ign.title')}<HelpTip key="help.ign.title" />
	</div>

	{#if !isConnected}
		<ConnectPrompt />
	{:else}
		<!-- Action bar -->
		<div class="flex items-center gap-2 flex-wrap empty:hidden">
			{#if loading}
				<span class="text-xs text-[var(--color-dash-accent)] inline-flex items-center gap-1.5">
					<span class="w-3 h-3 rounded-full border-2 border-[var(--color-dash-border)] border-t-[var(--color-dash-accent)] animate-spin"></span>
					{t('common.loading')}
				</span>
			{/if}
			{#if statusMsg}<span class="text-xs text-[var(--color-dash-text-dim)] ml-auto">{statusMsg}</span>{/if}
		</div>

		<p class="text-[10px] text-[var(--color-dash-text-dim)]">{t('ign.hint')}</p>

		<!-- ===================== Карта: включение + live-значение ===================== -->
		<section class="rounded-lg bg-[var(--color-dash-card)] border border-[var(--color-dash-border)]/50 p-3 space-y-2 {settingsLoaded ? '' : 'opacity-50 pointer-events-none'}">
			<div class="flex items-center justify-between">
				<span class="text-sm font-bold text-[var(--color-dash-text)] inline-flex items-center gap-1.5">
					IGN_CORR
					{#if settings.en}<span class="w-2 h-2 rounded-full bg-[var(--color-dash-success)]"></span>{/if}
				</span>
				{#if live?.value !== undefined}
					<span class="text-lg font-mono tabular-nums {live.value < 0 ? 'text-[var(--color-dash-warn)]' : live.value > 0 ? 'text-[var(--color-dash-success)]' : 'text-[var(--color-dash-text-dim)]'}">{fmtDeg(live.value)}</span>
				{/if}
			</div>
			<!-- Двусторонняя полоса: ноль в середине, откат влево, опережение вправо. -->
			{#if live?.value !== undefined && (settings.maxDeg > 0 || settings.minDeg < 0)}
				{@const span = Math.max(Math.abs(settings.minDeg), Math.abs(settings.maxDeg)) || 1}
				{@const pct = Math.max(-100, Math.min(100, (live.value / span) * 100))}
				<div class="relative h-1.5 rounded bg-[var(--color-dash-bg)] overflow-hidden">
					<div class="absolute top-0 bottom-0 w-px bg-[var(--color-dash-border)] left-1/2"></div>
					<div class="absolute top-0 bottom-0 {live.value < 0 ? 'bg-[var(--color-dash-warn)]' : 'bg-[var(--color-dash-success)]'}"
						style="left: {live.value < 0 ? 50 + pct / 2 : 50}%; width: {Math.abs(pct) / 2}%"></div>
				</div>
			{/if}
			<div class="flex items-end gap-3 flex-wrap">
				<label class="flex items-center gap-1.5 cursor-pointer pb-1">
					<input type="checkbox" bind:checked={settings.en} class="accent-[var(--color-dash-accent)]" />
					<span class="text-xs text-[var(--color-dash-text)] inline-flex items-center gap-0.5">{t('common.enabled')}<HelpTip key="help.ign.enable" /></span>
				</label>
				<label class="space-y-1">
					<span class="{labelClass} inline-flex items-center gap-0.5">{t('ign.maxDeg')}<HelpTip key="help.ign.maxDeg" /></span>
					<input type="number" step="0.5" min="0" max="60" bind:value={settings.maxDeg} class="{inputClass} block w-20 text-center" />
				</label>
				<label class="space-y-1">
					<span class="{labelClass} inline-flex items-center gap-0.5">{t('ign.minDeg')}<HelpTip key="help.ign.minDeg" /></span>
					<input type="number" step="0.5" min="-60" max="60" bind:value={settings.minDeg} class="{inputClass} block w-20 text-center" />
				</label>
				<button onclick={saveSettings} disabled={saving || !settingsLoaded}
					class="px-2 py-1 text-[10px] rounded bg-[var(--color-dash-success)]/15 text-[var(--color-dash-success)] hover:bg-[var(--color-dash-success)]/25 transition-colors disabled:opacity-40">
					{saving ? t('common.saving') : t('common.saveToDevice')}
				</button>
				<button onclick={() => restore(() => loadSettings())} disabled={saving || loading}
					class="px-2 py-1 text-[10px] rounded bg-[var(--color-dash-border)]/40 text-[var(--color-dash-text-dim)] hover:text-[var(--color-dash-text)] transition-colors disabled:opacity-40">
					{t('common.restoreFromFlash')}
				</button>
			</div>
		</section>

		<!-- ===================== Таблицы карты ===================== -->
		{#each tables.slice(0, NUM_TABLES) as table, idx}
			<section class="rounded-lg bg-[var(--color-dash-card)] border border-[var(--color-dash-border)]/50">
				<button class="w-full flex items-center justify-between p-3" onclick={() => toggleSection('t' + idx)}>
					<span class="text-xs font-bold text-[var(--color-dash-text)] inline-flex items-center gap-1.5">
						{t(TABLE_LABEL_KEYS[idx])}
						{#if table.isEnabled}<span class="w-2 h-2 rounded-full bg-[var(--color-dash-success)]"></span>{/if}
					</span>
					<span class="text-xs text-[var(--color-dash-text-dim)]">{activeSection === 't' + idx ? '−' : '+'}</span>
				</button>
				{#if activeSection === 't' + idx}
					<div class="px-3 pb-3 space-y-2">
						<div class="flex items-end gap-3 flex-wrap">
							<label class="flex items-center gap-1.5 cursor-pointer pb-1">
								<input type="checkbox" bind:checked={table.isEnabled} class="accent-[var(--color-dash-accent)]" />
								<span class="text-xs text-[var(--color-dash-text)] inline-flex items-center gap-0.5">{t('common.enabled')}<HelpTip key={idx === 0 ? 'help.ign.t1base' : 'help.ign.t2mul'} /></span>
							</label>
							<label class="space-y-1">
								<span class="{labelClass} inline-flex items-center gap-0.5">{t('canTx.xParam')}<HelpTip key="help.canTx.xParam" /></span>
								<select bind:value={table.xAxisParamType} class="{inputClass} block w-40">
									<option value="">—</option>
									{#each paramOptions as p}
										<option value={p.pwaName}>{axisOptionLabel(p.pwaName)}</option>
									{/each}
								</select>
							</label>
							{#if table.hasYAxis}
								<label class="space-y-1">
									<span class="{labelClass} inline-flex items-center gap-0.5">{t('canTx.yParam')}<HelpTip key="help.canTx.yParam" /></span>
									<select bind:value={table.yAxisParamType} class="{inputClass} block w-40">
										<option value="">—</option>
										{#each paramOptions as p}
											<option value={p.pwaName}>{axisOptionLabel(p.pwaName)}</option>
										{/each}
									</select>
								</label>
							{/if}
						</div>

						<TableEditor
							data={table.tableData}
							dimmed={!tablesLoaded}
							xAxisValues={table.xAxisValues}
							yAxisValues={table.yAxisValues}
							numCols={table.numCols}
							numRows={table.numRows}
							colorGradient={true}
							gradientMin={GRADIENT_BOUNDS[idx][0]}
							gradientMax={GRADIENT_BOUNDS[idx][1]}
							xAxisLabel={table.xAxisParamType ? axisShortLabel(table.xAxisParamType) : undefined}
							yAxisLabel={table.yAxisParamType ? axisShortLabel(table.yAxisParamType) : undefined}
							liveCursorX={getLiveValue(table.xAxisParamType)}
							liveCursorY={table.hasYAxis ? getLiveValue(table.yAxisParamType) : undefined}
							liveResult={getFirmwareTableResult(idx)}
							liveResultLabel={TABLE_RESULT_LABEL[idx]}
							resizable={true}
							minCols={1}
							onResize={(r, c) => onResize(idx, r, c)}
							onDataChange={(d) => onDataChange(idx, d)}
							onAxisChange={(a, v) => onAxisChange(idx, a, v)}
						/>

						<button onclick={saveTables} disabled={saving}
							class="px-2 py-1 text-[10px] rounded bg-[var(--color-dash-success)]/15 text-[var(--color-dash-success)] hover:bg-[var(--color-dash-success)]/25 transition-colors disabled:opacity-40">
							{saving ? t('common.saving') : t('common.saveToDevice')}
						</button>
						<button onclick={() => restore(fetchTables)} disabled={saving || loading}
							class="px-2 py-1 text-[10px] rounded bg-[var(--color-dash-border)]/40 text-[var(--color-dash-text-dim)] hover:text-[var(--color-dash-text)] transition-colors disabled:opacity-40">
							{t('common.restoreFromFlash')}
						</button>
					</div>
				{/if}
			</section>
		{/each}

		<!-- ===================== Доставка в ЭБУ (CAN) ===================== -->
		{#if canAvailable}
			<div class="text-[10px] font-bold text-[var(--color-dash-text)] uppercase tracking-wider pt-2 inline-flex items-center gap-1">
				{t('ign.canSection')}<HelpTip key="help.ign.canSection" />
			</div>
			<section class="rounded-lg bg-[var(--color-dash-card)] border border-[var(--color-dash-border)]/50 p-3 space-y-2 {settingsLoaded ? '' : 'opacity-50 pointer-events-none'}">
				<div class="flex items-end gap-3 flex-wrap">
					<label class="flex items-center gap-1.5 cursor-pointer pb-1">
						<input type="checkbox" bind:checked={settings.canEn} class="accent-[var(--color-dash-accent)]" />
						<span class="text-xs text-[var(--color-dash-text)]">{t('outputs.sendToCan')}</span>
					</label>
					<label class="space-y-1">
						<span class="{labelClass} inline-flex items-center gap-0.5">{t('ign.mode')}<HelpTip key="help.ign.mode" /></span>
						<select bind:value={settings.mode} class="{inputClass} block w-56">
							<option value={IGN_CORR_MODE_MS3_SPKADJ}>{t('ign.modeMs3')}</option>
							<option value={IGN_CORR_MODE_GENERIC}>{t('ign.modeGeneric')}</option>
						</select>
					</label>
					<label class="flex items-center gap-1.5 pb-1">
						<span class={labelClass}>{t('canTx.canInterval')}</span>
						<input type="number" min="10" max="1000" step="10" bind:value={settings.canSendIntervalMs} class="{inputClass} w-20 text-center" />
					</label>
				</div>

				<!-- Режим MS3: адресация штатной команды протокола MegaSquirt -->
				{#if isMs3}
					<div class="flex items-center gap-3 flex-wrap {settings.canEn ? '' : 'opacity-40 pointer-events-none'}">
						<label class="flex items-center gap-1.5">
							<span class="{labelClass} inline-flex items-center gap-0.5">{t('ign.ms3To')}<HelpTip key="help.ign.ms3To" /></span>
							<input type="number" min="0" max="14" bind:value={settings.ms3To} class="{inputClass} w-14 text-center" />
						</label>
						<label class="flex items-center gap-1.5">
							<span class="{labelClass} inline-flex items-center gap-0.5">{t('ign.ms3From')}<HelpTip key="help.ign.ms3From" /></span>
							<input type="number" min="0" max="14" bind:value={settings.ms3From} class="{inputClass} w-14 text-center" />
						</label>
						<label class="flex items-center gap-1.5">
							<span class="{labelClass} inline-flex items-center gap-0.5">{t('ign.ms3Addr')}<HelpTip key="help.ign.ms3Addr" /></span>
							<input type="number" min="0" max="31" bind:value={settings.ms3Table} class="{inputClass} w-14 text-center" />
							<span class="text-[10px] text-[var(--color-dash-text-dim)]">/</span>
							<input type="number" min="0" max="2047" bind:value={settings.ms3Offset} class="{inputClass} w-20 text-center" />
						</label>
					</div>
					<div class="text-[10px] text-[var(--color-dash-text-dim)] font-mono">
						{t('ign.frame')}: ID {ms3IdHex} · DLC 2 · int16 BE = {rawPreview} ({t('ign.rawDeg')})
					</div>
				{:else}
				<div class="flex items-center gap-3 flex-wrap">
					<div class="flex items-center gap-3 flex-wrap {settings.canEn ? '' : 'opacity-40 pointer-events-none'}">
						<div class="flex items-center gap-1.5">
							<span class={labelClass}>{t('canTx.canId')}</span>
							<button onclick={() => { const v = (parseInt(canIdHex, 16) || 0) - 1; if (v >= 0) canIdHex = v.toString(16).toUpperCase(); }}
								class="w-5 h-5 flex items-center justify-center text-xs rounded bg-[var(--color-dash-bg)] border border-[var(--color-dash-border)] text-[var(--color-dash-text-dim)] hover:text-[var(--color-dash-accent)] hover:border-[var(--color-dash-accent)] transition-colors">&minus;</button>
							<span class="text-xs text-[var(--color-dash-text-dim)]">0x</span>
							<input type="text" bind:value={canIdHex} maxlength="8" class="{inputClass} w-20 uppercase" />
							<button onclick={() => { const v = (parseInt(canIdHex, 16) || 0) + 1; if (v <= 0x1FFFFFFF) canIdHex = v.toString(16).toUpperCase(); }}
								class="w-5 h-5 flex items-center justify-center text-xs rounded bg-[var(--color-dash-bg)] border border-[var(--color-dash-border)] text-[var(--color-dash-text-dim)] hover:text-[var(--color-dash-accent)] hover:border-[var(--color-dash-accent)] transition-colors">+</button>
							<span class="text-[10px] text-[var(--color-dash-text-dim)] font-mono">= {parseInt(canIdHex, 16) || 0} dec</span>
						</div>
						<label class="flex items-center gap-1.5">
							<span class={labelClass}>{t('canTx.canByteOffset')}</span>
							<input type="number" min="0" max="6" bind:value={settings.canByteOffset} class="{inputClass} w-14 text-center" />
						</label>
						<label class="flex items-center gap-1.5 cursor-pointer">
							<input type="checkbox" bind:checked={settings.canBigEndian} class="accent-[var(--color-dash-accent)]" />
							<span class="text-xs text-[var(--color-dash-text)]">{t('canTx.canBigEndian')}</span>
						</label>
						<label class="flex items-center gap-1.5 cursor-pointer">
							<input type="checkbox" bind:checked={settings.canSigned} class="accent-[var(--color-dash-accent)]" />
							<span class="text-xs text-[var(--color-dash-text)] inline-flex items-center gap-0.5">{t('ign.signed')}<HelpTip key="help.ign.signed" /></span>
						</label>
					</div>
				</div>
				<div class="flex items-center gap-3 flex-wrap {settings.canEn ? '' : 'opacity-40 pointer-events-none'}">
					<label class="flex items-center gap-1.5">
						<span class="{labelClass} inline-flex items-center gap-0.5">{t('ign.scale')}<HelpTip key="help.ign.scale" /></span>
						<input type="number" step="any" bind:value={settings.scale} class="{inputClass} w-20 text-center" />
					</label>
					<label class="flex items-center gap-1.5">
						<span class="{labelClass} inline-flex items-center gap-0.5">{t('ign.zeroOffset')}<HelpTip key="help.ign.zeroOffset" /></span>
						<input type="number" step="any" bind:value={settings.zeroOffset} class="{inputClass} w-20 text-center" />
					</label>
					<span class="text-[10px] text-[var(--color-dash-text-dim)] font-mono">
						{t('ign.rawPreview')}: {rawPreview}
					</span>
				</div>
				{/if}
				<button onclick={saveSettings} disabled={saving || !settingsLoaded}
					class="px-2 py-1 text-[10px] rounded bg-[var(--color-dash-success)]/15 text-[var(--color-dash-success)] hover:bg-[var(--color-dash-success)]/25 transition-colors disabled:opacity-40">
					{saving ? t('common.saving') : t('common.saveToDevice')}
				</button>
			</section>
			<p class="text-[10px] text-[var(--color-dash-text-dim)]">{t('ign.ecuHint')}</p>
		{/if}
	{/if}
</div>
