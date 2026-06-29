<script lang="ts">
	import { readJsonConfig, writeJsonConfig } from '$lib/ble/chunked-transfer';
	import { bleState } from '$lib/stores/ble-connection.svelte';
	import { SVC_CAN_CONFIG, CHR_OUTPUTS, CHR_OUT_CHANNELS, CHR_TX_SIGNALS, SVC_BOOST, CHR_BOOST_SETTINGS } from '$lib/ble/uuids';
	import type { PhysOutputConfig, OutChannelsConfig, OutChannelInfo, SignalTxConfig } from '$lib/types/config';
	import { t } from '$lib/i18n/index.svelte';
	import HelpTip from '$lib/components/HelpTip.svelte';
	import ConnectPrompt from '$lib/components/ConnectPrompt.svelte';
	import { allParamEntries, firmwareNameToPwaName, tableChannelLabel } from '$lib/utils/param-mapping';
	import { PARAM_CACHE_SLOT_START } from '$lib/ble/protocol';
	import { getParamDisplayName, signalLabels } from '$lib/stores/signal-labels.svelte';
	import { boostSettings, loadBoostSettings } from '$lib/stores/boost-settings.svelte';
	import { settingsToDevice } from '$lib/utils/boost-pid-scale';
	import { deviceState } from '$lib/stores/device-state.svelte';
	import { liveData } from '$lib/stores/live-data.svelte';

	const MAX_OUTPUTS = 2;
	// Свободные пины под выходы (CAN 3/4, LED 21 заняты; ADC1 лучше беречь под входы)
	const OUTPUT_PINS = [11, 12, 13, 1, 2, 5, 6, 7, 8, 9, 10];

	function defaultOutput(): PhysOutputConfig {
		return {
			en: false, pin: -1, src: 'BST_OUT', freq: 30,
			inMin: 0, inMax: 100, invert: false,
			dutyMin: 0, dutyMax: 100, safe: 0, staleMs: 500
		};
	}

	let isConnected = $derived(bleState.status === 'connected');
	let outputs = $state<PhysOutputConfig[]>(Array.from({ length: MAX_OUTPUTS }, defaultOutput));
	let liveOutputs = $state<PhysOutputConfig[]>([]);
	let loaded = $state(false);
	let loading = $state(false);
	let saving = $state(false);
	let statusMsg = $state('');
	let refreshTimer: ReturnType<typeof setInterval> | null = null;

	function showStatus(msg: string, durationMs = 3000) {
		statusMsg = msg;
		setTimeout(() => { statusMsg = ''; }, durationMs);
	}

	// Источник: системные параметры (BST_OUT, OUT1..4, …) + замапленные cache-слоты.
	// Значение храним firmware-именем (src в прошивке резолвится getParamTypeByName).
	const isCacheSlot = (enumVal: number) =>
		enumVal >= PARAM_CACHE_SLOT_START && enumVal < PARAM_CACHE_SLOT_START + 40;
	let srcOptions = $derived(
		allParamEntries().filter(p =>
			p.enumVal > 1 &&   // без NONE и TIME
			(!isCacheSlot(p.enumVal) || signalLabels[p.enumVal - PARAM_CACHE_SLOT_START] !== undefined)
		)
	);
	const srcLabel = (firmwareName: string) => {
		const tbl = tableChannelLabel(firmwareName);   // CO1/OUT2..4 → TBL1..4
		if (tbl) return tbl;
		const m = firmwareName.match(/^CACHE(\d+)$/);
		if (m) return getParamDisplayName(firmwareNameToPwaName(firmwareName));
		return firmwareName;
	};

	async function loadOutputs(silent = false) {
		if (!silent) loading = true;
		try {
			const data = await readJsonConfig<{ outputs: PhysOutputConfig[] }>(SVC_CAN_CONFIG, CHR_OUTPUTS);
			if (data && Array.isArray(data.outputs)) {
				liveOutputs = data.outputs;
				if (!silent || !loaded) {
					const filled = data.outputs.slice(0, MAX_OUTPUTS).map(o => ({ ...defaultOutput(), ...o }));
					while (filled.length < MAX_OUTPUTS) filled.push(defaultOutput());
					outputs = filled;
				}
				loaded = true;
			}
		} catch (e) {
			if (!silent) showStatus(t('canRx.loadFailed') + ': ' + (e as Error).message);
		} finally {
			if (!silent) loading = false;
		}
	}

	async function save() {
		saving = true;
		try {
			const clean = outputs.map(({ liveDuty, liveSource, ...rest }) => rest);
			const ok = await writeJsonConfig(SVC_CAN_CONFIG, CHR_OUTPUTS, { outputs: clean });
			showStatus(ok ? t('canRx.savedOk') : t('canRx.saveFailed'));
			if (ok) await loadOutputs(true);
		} catch (e) {
			showStatus(t('canRx.saveFailed') + ': ' + (e as Error).message);
		} finally {
			saving = false;
		}
	}

	// ============================================================================
	// === Секция «CAN-отправка»: 5 маршрутов — BST_OUT (boost_settings) + OUT1..4
	// === (out_channels). Прячется целиком при выключенном CAN (standalone).
	// ============================================================================
	let canAvailable = $derived(deviceState.canEnabled !== false);

	// --- OUT1..4: редактируемая копия каналов из out_channels ---
	let outChannels = $state<OutChannelInfo[]>([]);
	let outChannelsLoaded = $state(false);
	async function loadOutChannels(silent = false) {
		const data = await readJsonConfig<OutChannelsConfig>(SVC_CAN_CONFIG, CHR_OUT_CHANNELS);
		if (data && Array.isArray(data.channels)) {
			if (!silent || !outChannelsLoaded) outChannels = data.channels.map(c => ({ ...c }));
			else outChannels.forEach((c, i) => { c.value = data.channels[i]?.value; });   // live-обновление значений
			outChannelsLoaded = true;
		}
	}
	async function saveOutChannels() {
		saving = true;
		try {
			const clean = outChannels.map(({ value, ...rest }) => rest);
			const ok = await writeJsonConfig(SVC_CAN_CONFIG, CHR_OUT_CHANNELS, { channels: clean });
			showStatus(ok ? t('canRx.savedOk') : t('canRx.saveFailed'));
		} catch (e) {
			showStatus(t('canRx.saveFailed') + ': ' + (e as Error).message);
		} finally {
			saving = false;
		}
	}

	// --- Трансляция параметров (passthrough): локальные входы и любые сигналы → CAN ---
	const MAX_TX_SIGNALS = 6;
	function defaultTxSignal(i: number): SignalTxConfig {
		return { en: false, src: '', canId: 0x280 + i, canByteOffset: 0, canBigEndian: true, scale: 10, canSendIntervalMs: 50 };
	}
	let txSignals = $state<SignalTxConfig[]>([]);
	let txSignalsLoaded = $state(false);
	async function loadTxSignals(silent = false) {
		const data = await readJsonConfig<{ signals: SignalTxConfig[] }>(SVC_CAN_CONFIG, CHR_TX_SIGNALS);
		if (data && Array.isArray(data.signals)) {
			if (!silent || !txSignalsLoaded) {
				const filled = data.signals.slice(0, MAX_TX_SIGNALS).map((s, i) => ({ ...defaultTxSignal(i), ...s }));
				while (filled.length < MAX_TX_SIGNALS) filled.push(defaultTxSignal(filled.length));
				txSignals = filled;
			} else {
				txSignals.forEach((s, i) => { s.value = data.signals[i]?.value; });   // live-обновление значений
			}
			txSignalsLoaded = true;
		}
	}
	async function saveTxSignals() {
		saving = true;
		try {
			const clean = txSignals.map(({ value, ...rest }) => rest);
			const ok = await writeJsonConfig(SVC_CAN_CONFIG, CHR_TX_SIGNALS, { signals: clean });
			showStatus(ok ? t('canRx.savedOk') : t('canRx.saveFailed'));
			if (ok) await loadTxSignals(true);
		} catch (e) {
			showStatus(t('canRx.saveFailed') + ': ' + (e as Error).message);
		} finally {
			saving = false;
		}
	}

	// --- BST_OUT: CAN-поля из общего стора boost_settings (редактируемая копия 4 полей).
	// Запись шлёт ВЕСЬ boost_settings (display→device конвертация PID); прошивка при
	// применении сбрасывает PID-состояние — для редкой смены адреса безвредно. ---
	let boostCan = $state({ canId: 0x26A, canByteOffset: 0, canBigEndian: true, canSendIntervalMs: 20 });
	let boostCanIdHex = $state('26A');
	let lastBoostEpoch = 0;
	$effect(() => {
		const e = boostSettings.epoch;
		if (e !== lastBoostEpoch) {
			lastBoostEpoch = e;
			const v = boostSettings.value;
			boostCan = { canId: v.canId, canByteOffset: v.canByteOffset, canBigEndian: v.canBigEndian, canSendIntervalMs: v.canSendIntervalMs };
			boostCanIdHex = v.canId.toString(16).toUpperCase();
		}
	});
	async function saveBoostCan() {
		saving = true;
		try {
			boostCan.canId = parseInt(boostCanIdHex, 16) || 0x26A;
			const full = { ...$state.snapshot(boostSettings.value), ...$state.snapshot(boostCan) };
			const ok = await writeJsonConfig(SVC_BOOST, CHR_BOOST_SETTINGS, settingsToDevice(full));
			if (ok) boostSettings.value = full;   // стор = то, что на устройстве
			showStatus(ok ? t('canRx.savedOk') : t('canRx.saveFailed'));
		} catch (e) {
			showStatus(t('canRx.saveFailed') + ': ' + (e as Error).message);
		} finally {
			saving = false;
		}
	}

	let initialLoadDone = $state(false);
	$effect(() => {
		if (isConnected && !initialLoadDone) {
			initialLoadDone = true;
			loadOutputs();
			loadOutChannels().catch(() => {});
			loadTxSignals().catch(() => {});
			if (!boostSettings.loaded) loadBoostSettings();
			refreshTimer = setInterval(() => {
				loadOutputs(true);
				loadOutChannels(true).catch(() => {});
				loadTxSignals(true).catch(() => {});
			}, 3000);   // live duty + значения каналов/маршрутов
		}
		if (!isConnected) {
			initialLoadDone = false;
			loaded = false;
			outChannelsLoaded = false;
			txSignalsLoaded = false;
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
		{t('outputs.title')}<HelpTip key="help.outputs.title" />
	</div>

	{#if !isConnected}
		<ConnectPrompt />
	{:else}
		<div class="flex items-center gap-2 flex-wrap">
			{#if loading}
				<span class="text-xs text-[var(--color-dash-accent)] inline-flex items-center gap-1.5">
					<span class="w-3 h-3 rounded-full border-2 border-[var(--color-dash-border)] border-t-[var(--color-dash-accent)] animate-spin"></span>
					{t('common.loading')}
				</span>
			{/if}
			<button onclick={() => loadOutputs()} disabled={loading || saving}
				class="px-2 py-1 text-[10px] rounded bg-[var(--color-dash-border)]/40 text-[var(--color-dash-text-dim)] hover:text-[var(--color-dash-text)] transition-colors disabled:opacity-40">
				{t('common.restoreFromFlash')}
			</button>
			<button onclick={save} disabled={saving || !loaded}
				class="px-2 py-1 text-[10px] rounded bg-[var(--color-dash-success)]/15 text-[var(--color-dash-success)] hover:bg-[var(--color-dash-success)]/25 transition-colors disabled:opacity-40">
				{saving ? t('common.saving') : t('common.saveToDevice')}
			</button>
			{#if statusMsg}<span class="text-xs text-[var(--color-dash-text-dim)] ml-auto">{statusMsg}</span>{/if}
		</div>

		<p class="text-[10px] text-[var(--color-dash-text-dim)]">{t('outputs.hint')}</p>

		<!-- ======================= Секция 1: физические ШИМ-выходы ======================= -->
		<div class="text-[10px] font-bold text-[var(--color-dash-text)] uppercase tracking-wider pt-1">{t('outputs.pwmSection')}</div>

		{#each outputs as out, idx}
			{@const live = liveOutputs[idx]}
			<section class="rounded-lg bg-[var(--color-dash-card)] border border-[var(--color-dash-border)]/50 p-3 space-y-3 {loaded ? '' : 'opacity-50 pointer-events-none'}">
				<div class="flex items-center justify-between">
					<span class="text-sm font-bold text-[var(--color-dash-text)] inline-flex items-center gap-1.5">
						{t('outputs.output')} {idx + 1}
						{#if out.en}<span class="w-2 h-2 rounded-full bg-[var(--color-dash-success)]"></span>{/if}
					</span>
					{#if out.en && live?.liveDuty !== undefined}
						<span class="text-sm font-mono text-[var(--color-dash-accent)] tabular-nums">{live.liveDuty.toFixed(1)}%</span>
					{/if}
				</div>

				<!-- Live duty bar -->
				{#if out.en && live?.liveDuty !== undefined}
					<div class="h-1.5 rounded bg-[var(--color-dash-bg)] overflow-hidden">
						<div class="h-full bg-[var(--color-dash-accent)] transition-all" style="width: {Math.max(0, Math.min(100, live.liveDuty))}%"></div>
					</div>
				{/if}

				<div class="flex items-end gap-3 flex-wrap">
					<label class="flex items-center gap-1.5 cursor-pointer pb-1">
						<input type="checkbox" bind:checked={out.en} class="accent-[var(--color-dash-accent)]" />
						<span class="text-xs text-[var(--color-dash-text)]">{t('common.enabled')}</span>
					</label>
					<label class="space-y-1">
						<span class="{labelClass} inline-flex items-center gap-0.5">GPIO<HelpTip key="help.outputs.pin" /></span>
						<select bind:value={out.pin} class="{inputClass} block w-20">
							<option value={-1}>—</option>
							{#each OUTPUT_PINS as p}<option value={p}>{p}</option>{/each}
						</select>
					</label>
					<label class="space-y-1">
						<span class="{labelClass} inline-flex items-center gap-0.5">{t('outputs.source')}<HelpTip key="help.outputs.source" /></span>
						<select bind:value={out.src} class="{inputClass} block w-36">
							{#each srcOptions as p}
								<option value={p.firmwareName}>{srcLabel(p.firmwareName)}</option>
							{/each}
						</select>
					</label>
					<label class="space-y-1">
						<span class="{labelClass} inline-flex items-center gap-0.5">{t('outputs.freq')}<HelpTip key="help.outputs.freq" /></span>
						<input type="number" min="1" max="1000" bind:value={out.freq} class="{inputClass} block w-20 text-center" />
					</label>
				</div>

				<!-- Маппинг значение → duty -->
				<div class="rounded border border-[var(--color-dash-border)]/40 p-2 space-y-2">
					<span class="text-[10px] font-bold text-[var(--color-dash-text)] uppercase inline-flex items-center gap-0.5">{t('outputs.mapping')}<HelpTip key="help.outputs.mapping" /></span>
					<div class="flex items-center gap-2 flex-wrap">
						<span class={labelClass}>{t('outputs.inRange')}</span>
						<input type="number" step="any" bind:value={out.inMin} class="{inputClass} w-20 text-center" />
						<span class="text-[10px] text-[var(--color-dash-text-dim)]">…</span>
						<input type="number" step="any" bind:value={out.inMax} class="{inputClass} w-20 text-center" />
						<span class="text-[10px] text-[var(--color-dash-text-dim)]">→ 0…100%</span>
						<label class="flex items-center gap-1.5 cursor-pointer ml-2">
							<input type="checkbox" bind:checked={out.invert} class="accent-[var(--color-dash-accent)]" />
							<span class="text-xs text-[var(--color-dash-text)] inline-flex items-center gap-0.5">{t('outputs.invert')}<HelpTip key="help.outputs.invert" /></span>
						</label>
					</div>
					<div class="flex items-center gap-2 flex-wrap">
						<span class="{labelClass} inline-flex items-center gap-0.5">{t('outputs.dutyClamp')}<HelpTip key="help.outputs.dutyClamp" /></span>
						<input type="number" min="0" max="100" bind:value={out.dutyMin} class="{inputClass} w-16 text-center" />
						<span class="text-[10px] text-[var(--color-dash-text-dim)]">…</span>
						<input type="number" min="0" max="100" bind:value={out.dutyMax} class="{inputClass} w-16 text-center" />
						<span class="text-[10px] text-[var(--color-dash-text-dim)]">%</span>
					</div>
					<div class="flex items-center gap-2 flex-wrap">
						<span class="{labelClass} inline-flex items-center gap-0.5">{t('outputs.safeDuty')}<HelpTip key="help.outputs.safeDuty" /></span>
						<input type="number" min="0" max="100" bind:value={out.safe} class="{inputClass} w-16 text-center" />
						<span class="text-[10px] text-[var(--color-dash-text-dim)]">%</span>
						<span class="{labelClass} ml-3 inline-flex items-center gap-0.5">{t('outputs.staleMs')}<HelpTip key="help.outputs.staleMs" /></span>
						<input type="number" min="100" max="5000" step="100" bind:value={out.staleMs} class="{inputClass} w-20 text-center" />
						<span class="text-[10px] text-[var(--color-dash-text-dim)]">ms</span>
					</div>
				</div>
			</section>
		{/each}

		<p class="text-[10px] text-[var(--color-dash-text-dim)]">{t('outputs.hwHint')}</p>

		<!-- ======================= Секция 2: CAN-отправка ======================= -->
		{#if canAvailable}
			<div class="text-[10px] font-bold text-[var(--color-dash-text)] uppercase tracking-wider pt-2 inline-flex items-center gap-1">{t('outputs.canSection')}<HelpTip key="help.outputs.canSection" /></div>
			<p class="text-[10px] text-[var(--color-dash-text-dim)]">{t('outputs.canHint')}</p>

			<!-- BST_OUT (boost) -->
			<section class="rounded-lg bg-[var(--color-dash-card)] border border-[var(--color-dash-border)]/50 p-3 space-y-2 {boostSettings.loaded ? '' : 'opacity-50 pointer-events-none'}">
				<div class="flex items-center justify-between">
					<span class="text-xs font-bold text-[var(--color-dash-text)] inline-flex items-center gap-1.5">
						BST_OUT
						{#if boostSettings.value.enabled}<span class="w-2 h-2 rounded-full bg-[var(--color-dash-success)]"></span>{/if}
						<span class="text-[var(--color-dash-text-dim)] font-normal">{t('outputs.boostRoute')}</span>
					</span>
					{#if liveData.params[3]?.value !== undefined}
						<span class="text-xs font-mono text-[var(--color-dash-accent)] tabular-nums">{liveData.params[3].value.toFixed(1)}%</span>
					{/if}
				</div>
				<p class="text-[10px] text-[var(--color-dash-text-dim)]">{t('outputs.boostSendHint')}</p>
				<div class="flex items-center gap-3 flex-wrap">
					<div class="flex items-center gap-1.5">
						<span class={labelClass}>{t('canTx.canId')}</span>
						<button onclick={() => { const v = (parseInt(boostCanIdHex, 16) || 0) - 1; if (v >= 0) boostCanIdHex = v.toString(16).toUpperCase(); }}
							class="w-5 h-5 flex items-center justify-center text-xs rounded bg-[var(--color-dash-bg)] border border-[var(--color-dash-border)] text-[var(--color-dash-text-dim)] hover:text-[var(--color-dash-accent)] hover:border-[var(--color-dash-accent)] transition-colors">&minus;</button>
						<span class="text-xs text-[var(--color-dash-text-dim)]">0x</span>
						<input type="text" bind:value={boostCanIdHex} maxlength="8" class="{inputClass} w-20 uppercase" />
						<button onclick={() => { const v = (parseInt(boostCanIdHex, 16) || 0) + 1; if (v <= 0x1FFFFFFF) boostCanIdHex = v.toString(16).toUpperCase(); }}
							class="w-5 h-5 flex items-center justify-center text-xs rounded bg-[var(--color-dash-bg)] border border-[var(--color-dash-border)] text-[var(--color-dash-text-dim)] hover:text-[var(--color-dash-accent)] hover:border-[var(--color-dash-accent)] transition-colors">+</button>
						<span class="text-[10px] text-[var(--color-dash-text-dim)] font-mono">= {parseInt(boostCanIdHex, 16) || 0} dec</span>
					</div>
					<label class="flex items-center gap-1.5">
						<span class={labelClass}>{t('canTx.canByteOffset')}</span>
						<input type="number" min="0" max="6" bind:value={boostCan.canByteOffset} class="{inputClass} w-14 text-center" />
					</label>
					<label class="flex items-center gap-1.5 cursor-pointer">
						<input type="checkbox" bind:checked={boostCan.canBigEndian} class="accent-[var(--color-dash-accent)]" />
						<span class="text-xs text-[var(--color-dash-text)]">{t('canTx.canBigEndian')}</span>
					</label>
					<label class="flex items-center gap-1.5">
						<span class={labelClass}>{t('canTx.canInterval')}</span>
						<input type="number" min="10" max="1000" step="10" bind:value={boostCan.canSendIntervalMs} class="{inputClass} w-20 text-center" />
					</label>
					<button onclick={saveBoostCan} disabled={saving || !boostSettings.loaded}
						class="px-2 py-1 text-[10px] rounded bg-[var(--color-dash-success)]/15 text-[var(--color-dash-success)] hover:bg-[var(--color-dash-success)]/25 transition-colors disabled:opacity-40">
						{saving ? t('common.saving') : t('common.saveToDevice')}
					</button>
				</div>
			</section>

			<!-- TBL1..4 (выход перемноженных таблиц; wire-каналы CO1/OUT2..4) -->
			{#each outChannels as ch, i}
				<section class="rounded-lg bg-[var(--color-dash-card)] border border-[var(--color-dash-border)]/50 p-3 space-y-2 {outChannelsLoaded ? '' : 'opacity-50 pointer-events-none'}">
					<div class="flex items-center justify-between">
						<span class="text-xs font-bold text-[var(--color-dash-text)] inline-flex items-center gap-1.5">
							TBL{i + 1}
							{#if ch.enabled}<span class="w-2 h-2 rounded-full bg-[var(--color-dash-success)]"></span>{/if}
						</span>
						{#if ch.value !== undefined}
							<span class="text-xs font-mono text-[var(--color-dash-accent)] tabular-nums">{ch.value.toFixed(1)}</span>
						{/if}
					</div>
					<div class="flex items-center gap-3 flex-wrap">
						<label class="flex items-center gap-1.5 cursor-pointer">
							<input type="checkbox" bind:checked={ch.enabled} class="accent-[var(--color-dash-accent)]" />
							<span class="text-xs text-[var(--color-dash-text)]">{t('outputs.sendToCan')}</span>
						</label>
						<div class="flex items-center gap-3 flex-wrap {ch.enabled ? '' : 'opacity-40 pointer-events-none'}">
							<div class="flex items-center gap-1.5">
								<span class={labelClass}>{t('canTx.canId')}</span>
								<button onclick={() => { if (ch.canId > 0) ch.canId--; }}
									class="w-5 h-5 flex items-center justify-center text-xs rounded bg-[var(--color-dash-bg)] border border-[var(--color-dash-border)] text-[var(--color-dash-text-dim)] hover:text-[var(--color-dash-accent)] hover:border-[var(--color-dash-accent)] transition-colors">&minus;</button>
								<span class="text-xs text-[var(--color-dash-text-dim)]">0x</span>
								<input type="text" value={ch.canId.toString(16).toUpperCase()} maxlength="8"
									onchange={(e) => { const v = parseInt(e.currentTarget.value, 16); if (!isNaN(v)) ch.canId = v; }}
									class="{inputClass} w-20 uppercase" />
								<button onclick={() => { if (ch.canId < 0x1FFFFFFF) ch.canId++; }}
									class="w-5 h-5 flex items-center justify-center text-xs rounded bg-[var(--color-dash-bg)] border border-[var(--color-dash-border)] text-[var(--color-dash-text-dim)] hover:text-[var(--color-dash-accent)] hover:border-[var(--color-dash-accent)] transition-colors">+</button>
								<span class="text-[10px] text-[var(--color-dash-text-dim)] font-mono">= {ch.canId} dec</span>
							</div>
							<label class="flex items-center gap-1.5">
								<span class={labelClass}>{t('canTx.canByteOffset')}</span>
								<input type="number" min="0" max="6" bind:value={ch.canByteOffset} class="{inputClass} w-14 text-center" />
							</label>
							<label class="flex items-center gap-1.5 cursor-pointer">
								<input type="checkbox" bind:checked={ch.canBigEndian} class="accent-[var(--color-dash-accent)]" />
								<span class="text-xs text-[var(--color-dash-text)]">{t('canTx.canBigEndian')}</span>
							</label>
							<label class="flex items-center gap-1.5">
								<span class={labelClass}>{t('canTx.canInterval')}</span>
								<input type="number" min="10" max="1000" step="10" bind:value={ch.canSendIntervalMs} class="{inputClass} w-20 text-center" />
							</label>
						</div>
					</div>
				</section>
			{/each}
			{#if outChannels.length > 0}
				<button onclick={saveOutChannels} disabled={saving || !outChannelsLoaded}
					class="px-2 py-1 text-[10px] rounded bg-[var(--color-dash-success)]/15 text-[var(--color-dash-success)] hover:bg-[var(--color-dash-success)]/25 transition-colors disabled:opacity-40">
					{saving ? t('common.saving') : t('outputs.saveChannels')}
				</button>
			{/if}

			<!-- ===== Секция 3: трансляция параметров (локальные входы / сигналы → CAN) ===== -->
			<div class="text-[10px] font-bold text-[var(--color-dash-text)] uppercase tracking-wider pt-3 inline-flex items-center gap-1">{t('outputs.txSection')}<HelpTip key="help.outputs.txSection" /></div>
			<p class="text-[10px] text-[var(--color-dash-text-dim)]">{t('outputs.txHint')}</p>

			{#each txSignals as tx, i}
				<section class="rounded-lg bg-[var(--color-dash-card)] border border-[var(--color-dash-border)]/50 p-3 space-y-2 {txSignalsLoaded ? '' : 'opacity-50 pointer-events-none'}">
					<div class="flex items-center justify-between">
						<span class="text-xs font-bold text-[var(--color-dash-text)] inline-flex items-center gap-1.5">
							{t('outputs.txRoute')} {i + 1}
							{#if tx.en}<span class="w-2 h-2 rounded-full bg-[var(--color-dash-success)]"></span>{/if}
						</span>
						{#if tx.value !== undefined}
							<span class="text-xs font-mono text-[var(--color-dash-accent)] tabular-nums">{tx.value.toFixed(2)}</span>
						{/if}
					</div>
					<div class="flex items-end gap-3 flex-wrap">
						<label class="flex items-center gap-1.5 cursor-pointer pb-1">
							<input type="checkbox" bind:checked={tx.en} class="accent-[var(--color-dash-accent)]" />
							<span class="text-xs text-[var(--color-dash-text)]">{t('outputs.sendToCan')}</span>
						</label>
						<label class="space-y-1">
							<span class="{labelClass} inline-flex items-center gap-0.5">{t('outputs.source')}<HelpTip key="help.outputs.txSource" /></span>
							<select bind:value={tx.src} class="{inputClass} block w-36">
								<option value="">—</option>
								{#each srcOptions as p}
									<option value={p.firmwareName}>{srcLabel(p.firmwareName)}</option>
								{/each}
							</select>
						</label>
					</div>
					<div class="flex items-center gap-3 flex-wrap {tx.en ? '' : 'opacity-40 pointer-events-none'}">
						<div class="flex items-center gap-1.5">
							<span class={labelClass}>{t('canTx.canId')}</span>
							<button onclick={() => { if (tx.canId > 0) tx.canId--; }}
								class="w-5 h-5 flex items-center justify-center text-xs rounded bg-[var(--color-dash-bg)] border border-[var(--color-dash-border)] text-[var(--color-dash-text-dim)] hover:text-[var(--color-dash-accent)] hover:border-[var(--color-dash-accent)] transition-colors">&minus;</button>
							<span class="text-xs text-[var(--color-dash-text-dim)]">0x</span>
							<input type="text" value={tx.canId.toString(16).toUpperCase()} maxlength="8"
								onchange={(e) => { const v = parseInt(e.currentTarget.value, 16); if (!isNaN(v)) tx.canId = v; }}
								class="{inputClass} w-20 uppercase" />
							<button onclick={() => { if (tx.canId < 0x1FFFFFFF) tx.canId++; }}
								class="w-5 h-5 flex items-center justify-center text-xs rounded bg-[var(--color-dash-bg)] border border-[var(--color-dash-border)] text-[var(--color-dash-text-dim)] hover:text-[var(--color-dash-accent)] hover:border-[var(--color-dash-accent)] transition-colors">+</button>
							<span class="text-[10px] text-[var(--color-dash-text-dim)] font-mono">= {tx.canId} dec</span>
						</div>
						<label class="flex items-center gap-1.5">
							<span class={labelClass}>{t('canTx.canByteOffset')}</span>
							<input type="number" min="0" max="6" bind:value={tx.canByteOffset} class="{inputClass} w-14 text-center" />
						</label>
						<label class="flex items-center gap-1.5">
							<span class="{labelClass} inline-flex items-center gap-0.5">{t('outputs.scale')}<HelpTip key="help.outputs.scale" /></span>
							<input type="number" step="any" bind:value={tx.scale} class="{inputClass} w-20 text-center" />
						</label>
						<label class="flex items-center gap-1.5 cursor-pointer">
							<input type="checkbox" bind:checked={tx.canBigEndian} class="accent-[var(--color-dash-accent)]" />
							<span class="text-xs text-[var(--color-dash-text)]">{t('canTx.canBigEndian')}</span>
						</label>
						<label class="flex items-center gap-1.5">
							<span class={labelClass}>{t('canTx.canInterval')}</span>
							<input type="number" min="10" max="1000" step="10" bind:value={tx.canSendIntervalMs} class="{inputClass} w-20 text-center" />
						</label>
					</div>
				</section>
			{/each}
			{#if txSignals.length > 0}
				<button onclick={saveTxSignals} disabled={saving || !txSignalsLoaded}
					class="px-2 py-1 text-[10px] rounded bg-[var(--color-dash-success)]/15 text-[var(--color-dash-success)] hover:bg-[var(--color-dash-success)]/25 transition-colors disabled:opacity-40">
					{saving ? t('common.saving') : t('outputs.saveTxSignals')}
				</button>
			{/if}
		{/if}
	{/if}
</div>
