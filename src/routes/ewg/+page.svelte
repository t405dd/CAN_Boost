<script lang="ts">
	import { readJsonConfig, writeJsonConfig, writeUint8 } from '$lib/ble/chunked-transfer';
	import { writeCharacteristic } from '$lib/ble/connection';
	import { bleState } from '$lib/stores/ble-connection.svelte';
	import {
		SVC_CAN_CONFIG, CHR_EWG, SVC_SYSTEM, CHR_COMMAND,
		CMD_EWG_AUTOTUNE_START, CMD_EWG_AUTOTUNE_ABORT, CMD_EWG_RELAY_TEST, CMD_EWG_HOT_RECAL, CMD_EWG_JOG
	} from '$lib/ble/uuids';
	import {
		PARAM_EWG_TARGET_POS, PARAM_EWG_ACTUAL_POS, PARAM_EWG_DUTY,
		PARAM_EWG_CURRENT, PARAM_EWG_STATE, PARAM_EWG_AUTOTUNE, PARAM_CACHE_SLOT_START
	} from '$lib/ble/protocol';
	import type { EwgConfig } from '$lib/types/config';
	import { t } from '$lib/i18n/index.svelte';
	import ConnectPrompt from '$lib/components/ConnectPrompt.svelte';
	import { allParamEntries, firmwareNameToPwaName, tableChannelLabel } from '$lib/utils/param-mapping';
	import { getParamDisplayName, signalLabels } from '$lib/stores/signal-labels.svelte';
	import { liveData } from '$lib/stores/live-data.svelte';

	// Пины: драйверные (логические) и ADC1 (датчик/ток — только GPIO1..10, ADC2 конфликтует с BLE).
	const DRIVER_PINS = [11, 12, 13, 1, 2, 5, 6, 7, 8, 9, 10, 14, 38, 39, 40, 41, 42];
	const ADC_PINS = [1, 2, 5, 6, 7, 8, 9, 10];

	// Состояние/стадия — технические коды (не переводим).
	const STATE_LABELS = ['OFF', 'RUN', 'SAFE', 'SENSOR FAULT', 'STALL', 'NO SOURCE', 'AUTOTUNE', 'RECAL'];
	const STAGE_LABELS = ['—', 'endstops', 'friction', 'sys-id', 'compute', 'verify', 'persist', 'done', 'abort'];

	function defaultEwg(): EwgConfig {
		return {
			en: false, rpwm: 12, lpwm: 13, enpin: 11, freq: 4000, invDir: false,
			src: 'BST_OUT', inMin: 0, inMax: 100, invSp: false, staleMs: 250,
			posPin: 10, posDiv: 0.6, pv1: 0.5, pp1: 0, pv2: 4.5, pp2: 100,
			pvmin: 0.2, pvmax: 4.9, posEma: 0.35,
			curPin: 9, curDiv: 0.6, curV0: 0, curApV: 10, curLim: 8, curEma: 0.2,
			kp: 1.5, ki: 2.0, kd: 0.05, iwind: 40, dalpha: 0.3,
			deadband: 0.7, minOpen: 8, minClose: 8, maxDuty: 90, slew: 800,
			ff: Array(9).fill(0),
			stallA: 10, stallMs: 400, stallMin: 15,
			safePos: 0, faultRel: 0, home: true,
			adClosed: true, adOpen: true, recalMap: 105, recalTps: 5, recalRate: 0.02,
			idKv: 0, idTheta: 0, idSigma: 0
		};
	}

	let isConnected = $derived(bleState.status === 'connected');
	let ewg = $state<EwgConfig>(defaultEwg());
	let live = $state<EwgConfig | null>(null);
	let loaded = $state(false);
	let loading = $state(false);
	let saving = $state(false);
	let statusMsg = $state('');
	let refreshTimer: ReturnType<typeof setInterval> | null = null;

	function showStatus(msg: string, ms = 3000) { statusMsg = msg; setTimeout(() => { statusMsg = ''; }, ms); }

	// Источник уставки: системные параметры + замапленные cache-слоты (как на стр. «Выходы»).
	const isCacheSlot = (e: number) => e >= PARAM_CACHE_SLOT_START && e < PARAM_CACHE_SLOT_START + 40;
	let srcOptions = $derived(
		allParamEntries().filter(p =>
			p.enumVal > 1 &&
			!(p.enumVal >= 67 && p.enumVal <= 73) &&   // без собственной телеметрии EWG (нет самоссылки)
			(!isCacheSlot(p.enumVal) || signalLabels[p.enumVal - PARAM_CACHE_SLOT_START] !== undefined)
		)
	);
	const srcLabel = (fw: string) => {
		const tbl = tableChannelLabel(fw);   // CO1/OUT2..4 → TBL1..4
		if (tbl) return tbl;
		if (/^CACHE\d+$/.test(fw)) return getParamDisplayName(firmwareNameToPwaName(fw));
		return fw;
	};

	async function load(silent = false) {
		if (!silent) loading = true;
		try {
			const data = await readJsonConfig<EwgConfig>(SVC_CAN_CONFIG, CHR_EWG);
			if (data && typeof data.en === 'boolean') {
				live = data;
				if (!silent || !loaded) { ewg = { ...defaultEwg(), ...data, ff: data.ff ?? Array(9).fill(0) }; loaded = true; }
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
			const { livePos, liveTgt, liveCur, liveVolts, liveDuty, liveState, liveAt, ...clean } = ewg;
			const ok = await writeJsonConfig(SVC_CAN_CONFIG, CHR_EWG, clean);
			showStatus(ok ? t('canRx.savedOk') : t('canRx.saveFailed'));
			if (ok) await load(true);
		} catch (e) {
			showStatus(t('canRx.saveFailed') + ': ' + (e as Error).message);
		} finally {
			saving = false;
		}
	}

	async function cmd(byte: number) {
		try { await writeUint8(SVC_SYSTEM, CHR_COMMAND, byte); } catch (e) { showStatus((e as Error).message); }
	}
	async function jog(dir: number) {   // 0=стоп, 1=открыть, 2=закрыть
		try { await writeCharacteristic(SVC_SYSTEM, CHR_COMMAND, new Uint8Array([CMD_EWG_JOG, dir]).buffer); }
		catch (e) { showStatus((e as Error).message); }
	}
	function captureOpen() { if (live?.liveVolts !== undefined) ewg.pv1 = +live.liveVolts.toFixed(3); }
	function captureClosed() { if (live?.liveVolts !== undefined) ewg.pv2 = +live.liveVolts.toFixed(3); }

	// Live-телеметрия (быстрая, из notify-потока)
	let lvPos = $derived(liveData.params[PARAM_EWG_ACTUAL_POS]?.value);
	let lvTgt = $derived(liveData.params[PARAM_EWG_TARGET_POS]?.value);
	let lvDuty = $derived(liveData.params[PARAM_EWG_DUTY]?.value);
	let lvCur = $derived(liveData.params[PARAM_EWG_CURRENT]?.value);
	let lvState = $derived(liveData.params[PARAM_EWG_STATE]?.value ?? live?.liveState);
	let lvStage = $derived(liveData.params[PARAM_EWG_AUTOTUNE]?.value ?? live?.liveAt);
	let tuning = $derived(lvStage !== undefined && lvStage >= 1 && lvStage <= 6);

	let initialLoadDone = $state(false);
	$effect(() => {
		if (isConnected && !initialLoadDone) {
			initialLoadDone = true;
			load();
			refreshTimer = setInterval(() => load(true), 1500);   // liveVolts/liveState + капчур
		}
		if (!isConnected) {
			initialLoadDone = false; loaded = false;
			if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
		}
		return () => { if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; } };
	});

	const ic = 'px-2 py-1 text-xs rounded bg-[var(--color-dash-bg)] border border-[var(--color-dash-border)] text-[var(--color-dash-text)] font-mono focus:border-[var(--color-dash-accent)] focus:outline-none';
	const lc = 'text-[10px] text-[var(--color-dash-text-dim)] uppercase';
	const sec = 'rounded-lg bg-[var(--color-dash-card)] border border-[var(--color-dash-border)]/50 p-3 space-y-2';
	const head = 'text-[10px] font-bold text-[var(--color-dash-text)] uppercase tracking-wider pt-1';
</script>

<div class="space-y-3">
	<div class="text-xs text-[var(--color-dash-text-dim)] uppercase tracking-wider">{t('ewg.title')}</div>

	{#if !isConnected}
		<ConnectPrompt />
	{:else}
		<div class="flex items-center gap-2 flex-wrap">
			{#if loading}<span class="text-xs text-[var(--color-dash-accent)]">{t('common.loading')}</span>{/if}
			<button onclick={() => load()} disabled={loading || saving}
				class="px-2 py-1 text-[10px] rounded bg-[var(--color-dash-border)]/40 text-[var(--color-dash-text-dim)] hover:text-[var(--color-dash-text)] disabled:opacity-40">{t('common.restoreFromFlash')}</button>
			<button onclick={save} disabled={saving || !loaded}
				class="px-2 py-1 text-[10px] rounded bg-[var(--color-dash-success)]/15 text-[var(--color-dash-success)] hover:bg-[var(--color-dash-success)]/25 disabled:opacity-40">{saving ? t('common.saving') : t('common.saveToDevice')}</button>
			{#if statusMsg}<span class="text-xs text-[var(--color-dash-text-dim)] ml-auto">{statusMsg}</span>{/if}
		</div>

		<p class="text-[10px] text-[var(--color-dash-text-dim)]">{t('ewg.hint')}</p>
		<p class="text-[10px] text-[var(--color-dash-warn)] border border-[var(--color-dash-warn)]/40 rounded p-2">⚠ {t('ewg.designWarn')}</p>
		<p class="text-[10px] text-[var(--color-dash-danger)] border border-[var(--color-dash-danger)]/40 rounded p-2">🔴 {t('ewg.springWarn')}</p>

		<!-- ===== Live-телеметрия ===== -->
		<section class={sec}>
			<div class="flex items-center justify-between">
				<span class="text-xs font-bold text-[var(--color-dash-text)]">{t('ewg.telemetry')}</span>
				<span class="text-[11px] font-mono px-2 py-0.5 rounded {tuning ? 'bg-[var(--color-dash-warn)]/20 text-[var(--color-dash-warn)]' : 'bg-[var(--color-dash-border)]/40 text-[var(--color-dash-text-dim)]'}">
					{lvState !== undefined ? STATE_LABELS[lvState] ?? lvState : '—'}{tuning ? ` · ${STAGE_LABELS[lvStage ?? 0] ?? ''}` : ''}
				</span>
			</div>
			<!-- Бар: факт (заливка) vs цель (маркер) -->
			<div class="relative h-2.5 rounded bg-[var(--color-dash-bg)] overflow-hidden">
				<div class="h-full bg-[var(--color-dash-accent)] transition-all" style="width: {Math.max(0, Math.min(100, lvPos ?? 0))}%"></div>
				{#if lvTgt !== undefined}<div class="absolute top-0 h-full w-0.5 bg-[var(--color-dash-success)]" style="left: {Math.max(0, Math.min(100, lvTgt))}%"></div>{/if}
			</div>
			<div class="flex gap-4 text-[11px] font-mono text-[var(--color-dash-text-dim)] flex-wrap">
				<span>{t('ewg.actual')}: <span class="text-[var(--color-dash-accent)]">{lvPos?.toFixed(1) ?? '—'}%</span></span>
				<span>{t('ewg.target')}: <span class="text-[var(--color-dash-success)]">{lvTgt?.toFixed(1) ?? '—'}%</span></span>
				<span>{t('ewg.duty')}: {lvDuty?.toFixed(0) ?? '—'}%</span>
				<span>{t('ewg.current')}: {lvCur?.toFixed(1) ?? '—'} A</span>
			</div>
		</section>

		<div class={head}>{t('ewg.driverSection')}</div>
		<section class={sec}>
			<div class="flex items-end gap-3 flex-wrap">
				<label class="flex items-center gap-1.5 cursor-pointer pb-1">
					<input type="checkbox" bind:checked={ewg.en} class="accent-[var(--color-dash-accent)]" />
					<span class="text-xs text-[var(--color-dash-text)]">{t('common.enabled')}</span>
				</label>
				<label class="space-y-1"><span class={lc}>{t('ewg.rpwm')}</span>
					<select bind:value={ewg.rpwm} class="{ic} block w-16"><option value={-1}>—</option>{#each DRIVER_PINS as p}<option value={p}>{p}</option>{/each}</select></label>
				<label class="space-y-1"><span class={lc}>{t('ewg.lpwm')}</span>
					<select bind:value={ewg.lpwm} class="{ic} block w-16"><option value={-1}>—</option>{#each DRIVER_PINS as p}<option value={p}>{p}</option>{/each}</select></label>
				<label class="space-y-1"><span class={lc}>{t('ewg.enPin')}</span>
					<select bind:value={ewg.enpin} class="{ic} block w-16"><option value={-1}>—</option>{#each DRIVER_PINS as p}<option value={p}>{p}</option>{/each}</select></label>
				<label class="space-y-1"><span class={lc}>{t('ewg.freq')}</span>
					<input type="number" min="50" max="19000" bind:value={ewg.freq} class="{ic} block w-20 text-center" /></label>
				<label class="flex items-center gap-1.5 cursor-pointer pb-1">
					<input type="checkbox" bind:checked={ewg.invDir} class="accent-[var(--color-dash-accent)]" />
					<span class="text-xs text-[var(--color-dash-text)]">{t('ewg.invDir')}</span></label>
			</div>
		</section>

		<div class={head}>{t('ewg.setpointSection')}</div>
		<section class={sec}>
			<div class="flex items-end gap-3 flex-wrap">
				<label class="space-y-1"><span class={lc}>{t('ewg.source')}</span>
					<select bind:value={ewg.src} class="{ic} block w-36">
						{#each srcOptions as p}<option value={p.firmwareName}>{srcLabel(p.firmwareName)}</option>{/each}
					</select></label>
				<label class="space-y-1"><span class={lc}>{t('ewg.inRange')}</span>
					<div class="flex items-center gap-1">
						<input type="number" step="any" bind:value={ewg.inMin} class="{ic} w-16 text-center" />
						<span class="text-[10px] text-[var(--color-dash-text-dim)]">…</span>
						<input type="number" step="any" bind:value={ewg.inMax} class="{ic} w-16 text-center" />
					</div></label>
				<label class="flex items-center gap-1.5 cursor-pointer pb-1">
					<input type="checkbox" bind:checked={ewg.invSp} class="accent-[var(--color-dash-accent)]" />
					<span class="text-xs text-[var(--color-dash-text)]">{t('ewg.invSetpoint')}</span></label>
				<label class="space-y-1"><span class={lc}>{t('ewg.staleMs')}</span>
					<input type="number" min="100" max="5000" step="50" bind:value={ewg.staleMs} class="{ic} w-20 text-center" /></label>
			</div>
		</section>

		<div class={head}>{t('ewg.sensorSection')}</div>
		<section class={sec}>
			<div class="flex items-end gap-3 flex-wrap">
				<label class="space-y-1"><span class={lc}>{t('ewg.posPin')}</span>
					<select bind:value={ewg.posPin} class="{ic} block w-16">{#each ADC_PINS as p}<option value={p}>{p}</option>{/each}</select></label>
				<label class="space-y-1"><span class={lc}>{t('ewg.divider')}</span>
					<input type="number" step="0.001" bind:value={ewg.posDiv} class="{ic} w-20 text-center" /></label>
				<span class="text-[11px] font-mono text-[var(--color-dash-text-dim)] pb-1">{live?.liveVolts !== undefined ? live.liveVolts.toFixed(3) + ' V' : ''}</span>
			</div>
			<div class="flex items-end gap-2 flex-wrap">
				<label class="space-y-1"><span class={lc}>{t('ewg.calOpen')}</span>
					<input type="number" step="any" bind:value={ewg.pv1} class="{ic} w-20 text-center" /></label>
				<button onclick={captureOpen} class="px-2 py-1 text-[10px] rounded bg-[var(--color-dash-border)]/50 text-[var(--color-dash-text)] hover:text-[var(--color-dash-accent)] mb-0.5">{t('ewg.capture')}</button>
				<label class="space-y-1 ml-2"><span class={lc}>{t('ewg.calClosed')}</span>
					<input type="number" step="any" bind:value={ewg.pv2} class="{ic} w-20 text-center" /></label>
				<button onclick={captureClosed} class="px-2 py-1 text-[10px] rounded bg-[var(--color-dash-border)]/50 text-[var(--color-dash-text)] hover:text-[var(--color-dash-accent)] mb-0.5">{t('ewg.capture')}</button>
				<label class="space-y-1 ml-2"><span class={lc}>{t('ewg.validRange')}</span>
					<div class="flex items-center gap-1">
						<input type="number" step="any" bind:value={ewg.pvmin} class="{ic} w-16 text-center" />
						<span class="text-[10px] text-[var(--color-dash-text-dim)]">…</span>
						<input type="number" step="any" bind:value={ewg.pvmax} class="{ic} w-16 text-center" />
					</div></label>
			</div>
		</section>

		<div class={head}>{t('ewg.pidSection')}</div>
		<section class={sec}>
			<div class="flex items-end gap-3 flex-wrap">
				<label class="space-y-1"><span class={lc}>Kp</span><input type="number" step="any" bind:value={ewg.kp} class="{ic} w-16 text-center" /></label>
				<label class="space-y-1"><span class={lc}>Ki</span><input type="number" step="any" bind:value={ewg.ki} class="{ic} w-16 text-center" /></label>
				<label class="space-y-1"><span class={lc}>Kd</span><input type="number" step="any" bind:value={ewg.kd} class="{ic} w-16 text-center" /></label>
				<label class="space-y-1"><span class={lc}>{t('ewg.iwind')}</span><input type="number" step="any" bind:value={ewg.iwind} class="{ic} w-16 text-center" /></label>
				<label class="space-y-1"><span class={lc}>{t('ewg.dalpha')}</span><input type="number" step="any" bind:value={ewg.dalpha} class="{ic} w-16 text-center" /></label>
			</div>
			<div class="flex items-end gap-3 flex-wrap">
				<label class="space-y-1"><span class={lc}>{t('ewg.deadband')}</span><input type="number" step="any" bind:value={ewg.deadband} class="{ic} w-16 text-center" /></label>
				<label class="space-y-1"><span class={lc}>{t('ewg.minOpen')}</span><input type="number" step="any" bind:value={ewg.minOpen} class="{ic} w-16 text-center" /></label>
				<label class="space-y-1"><span class={lc}>{t('ewg.minClose')}</span><input type="number" step="any" bind:value={ewg.minClose} class="{ic} w-16 text-center" /></label>
				<label class="space-y-1"><span class={lc}>{t('ewg.maxDuty')}</span><input type="number" step="any" bind:value={ewg.maxDuty} class="{ic} w-16 text-center" /></label>
				<label class="space-y-1"><span class={lc}>{t('ewg.slew')}</span><input type="number" step="any" bind:value={ewg.slew} class="{ic} w-16 text-center" /></label>
			</div>
			<p class="text-[10px] text-[var(--color-dash-text-dim)] font-mono">ID: Kv={ewg.idKv?.toFixed(2)} θ={ewg.idTheta?.toFixed(3)}s σ={ewg.idSigma?.toFixed(2)}%</p>
		</section>

		<div class={head}>{t('ewg.currentSection')}</div>
		<section class={sec}>
			<div class="flex items-end gap-3 flex-wrap">
				<label class="space-y-1"><span class={lc}>{t('ewg.curPin')}</span>
					<select bind:value={ewg.curPin} class="{ic} block w-16"><option value={-1}>—</option>{#each ADC_PINS as p}<option value={p}>{p}</option>{/each}</select></label>
				<label class="space-y-1"><span class={lc}>{t('ewg.divider')}</span>
					<input type="number" step="0.001" bind:value={ewg.curDiv} class="{ic} w-20 text-center" /></label>
				<label class="space-y-1"><span class={lc}>{t('ewg.curV0')}</span>
					<input type="number" step="any" bind:value={ewg.curV0} class="{ic} w-16 text-center" /></label>
				<label class="space-y-1"><span class={lc}>{t('ewg.curApV')}</span>
					<input type="number" step="any" bind:value={ewg.curApV} class="{ic} w-16 text-center" /></label>
				<label class="space-y-1"><span class={lc}>{t('ewg.curLimit')}</span>
					<input type="number" step="any" bind:value={ewg.curLim} class="{ic} w-16 text-center" /></label>
				<label class="space-y-1"><span class={lc}>{t('ewg.stallA')}</span>
					<input type="number" step="any" bind:value={ewg.stallA} class="{ic} w-16 text-center" /></label>
				<label class="space-y-1"><span class={lc}>{t('ewg.stallMs')}</span>
					<input type="number" step="any" bind:value={ewg.stallMs} class="{ic} w-16 text-center" /></label>
			</div>
		</section>

		<div class={head}>{t('ewg.safetySection')}</div>
		<section class={sec}>
			<div class="flex items-end gap-3 flex-wrap">
				<label class="space-y-1"><span class={lc}>{t('ewg.safePos')}</span>
					<input type="number" min="0" max="100" bind:value={ewg.safePos} class="{ic} w-16 text-center" /></label>
				<label class="space-y-1"><span class={lc}>{t('ewg.faultRel')}</span>
					<select bind:value={ewg.faultRel} class="{ic} block w-40">
						<option value={0}>{t('ewg.faultDriveOpen')}</option>
						<option value={1}>{t('ewg.faultCoast')}</option>
					</select></label>
				<label class="flex items-center gap-1.5 cursor-pointer pb-1">
					<input type="checkbox" bind:checked={ewg.home} class="accent-[var(--color-dash-accent)]" />
					<span class="text-xs text-[var(--color-dash-text)]">{t('ewg.home')}</span></label>
			</div>
		</section>

		<div class={head}>{t('ewg.thermalSection')}</div>
		<section class={sec}>
			<div class="flex items-end gap-3 flex-wrap">
				<label class="flex items-center gap-1.5 cursor-pointer pb-1">
					<input type="checkbox" bind:checked={ewg.adClosed} class="accent-[var(--color-dash-accent)]" />
					<span class="text-xs text-[var(--color-dash-text)]">{t('ewg.adClosed')}</span></label>
				<label class="flex items-center gap-1.5 cursor-pointer pb-1">
					<input type="checkbox" bind:checked={ewg.adOpen} class="accent-[var(--color-dash-accent)]" />
					<span class="text-xs text-[var(--color-dash-text)]">{t('ewg.adOpen')}</span></label>
				<label class="space-y-1"><span class={lc}>{t('ewg.recalMap')}</span>
					<input type="number" step="any" bind:value={ewg.recalMap} class="{ic} w-20 text-center" /></label>
				<label class="space-y-1"><span class={lc}>{t('ewg.recalTps')}</span>
					<input type="number" step="any" bind:value={ewg.recalTps} class="{ic} w-16 text-center" /></label>
			</div>
		</section>

		<div class={head}>{t('ewg.autotuneSection')}</div>
		<section class={sec}>
			<p class="text-[10px] text-[var(--color-dash-warn)]">⚠ {t('ewg.autotuneWarn')}</p>
			<div class="flex items-center gap-2 flex-wrap">
				<button onclick={() => cmd(CMD_EWG_AUTOTUNE_START)} disabled={tuning}
					class="px-2 py-1 text-[11px] rounded bg-[var(--color-dash-accent)]/20 text-[var(--color-dash-accent)] hover:bg-[var(--color-dash-accent)]/30 disabled:opacity-40">{t('ewg.autotuneStart')}</button>
				<button onclick={() => cmd(CMD_EWG_RELAY_TEST)} disabled={tuning}
					class="px-2 py-1 text-[11px] rounded bg-[var(--color-dash-border)]/50 text-[var(--color-dash-text)] hover:text-[var(--color-dash-accent)] disabled:opacity-40">{t('ewg.relayTest')}</button>
				<button onclick={() => cmd(CMD_EWG_AUTOTUNE_ABORT)}
					class="px-2 py-1 text-[11px] rounded bg-[var(--color-dash-danger)]/15 text-[var(--color-dash-danger)] hover:bg-[var(--color-dash-danger)]/25">{t('ewg.autotuneAbort')}</button>
				<button onclick={() => cmd(CMD_EWG_HOT_RECAL)}
					class="px-2 py-1 text-[11px] rounded bg-[var(--color-dash-border)]/50 text-[var(--color-dash-text)] hover:text-[var(--color-dash-accent)]">{t('ewg.hotRecal')}</button>
				<!-- Ручной jog: удерживать -->
				<button onpointerdown={() => jog(1)} onpointerup={() => jog(0)} onpointerleave={() => jog(0)}
					class="px-2 py-1 text-[11px] rounded bg-[var(--color-dash-border)]/50 text-[var(--color-dash-text)] hover:text-[var(--color-dash-accent)] select-none">◄ {t('ewg.jogOpen')}</button>
				<button onpointerdown={() => jog(2)} onpointerup={() => jog(0)} onpointerleave={() => jog(0)}
					class="px-2 py-1 text-[11px] rounded bg-[var(--color-dash-border)]/50 text-[var(--color-dash-text)] hover:text-[var(--color-dash-accent)] select-none">{t('ewg.jogClose')} ►</button>
			</div>
		</section>
	{/if}
</div>
