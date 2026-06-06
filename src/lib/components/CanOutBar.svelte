<script lang="ts">
	// Persistent header strip showing what the device transmits on the CAN bus:
	// boost controller output (enum 3) and CO1 (enum 2), plus the boost controller
	// state (enum 55) so it's clear WHY the output is what it is — e.g. a stale
	// MAP/RPM signal forces a safe 0% output ("no data") rather than a real command.
	import { liveData } from '$lib/stores/live-data.svelte';
	import { boostSettings } from '$lib/stores/boost-settings.svelte';
	import { PARAM_BOOST_STATE } from '$lib/ble/protocol';
	import { t } from '$lib/i18n/index.svelte';

	let boostOut = $derived(liveData.params[3]?.value);
	let co1 = $derived(liveData.params[2]?.value);
	let state = $derived(liveData.params[PARAM_BOOST_STATE]?.value);

	let boostPct = $derived(boostOut === undefined ? 0 : Math.max(0, Math.min(100, boostOut)));

	function fmt(v: number, d = 1): string {
		return Number.isInteger(v) ? String(v) : v.toFixed(d);
	}

	// Boost state code (firmware enum BoostState) → { label key, css color var, warn }.
	// warn=true marks states where the output is NOT a live command (data stale / off / cut).
	const STATES: Record<number, { key: any; color: string; warn: boolean }> = {
		0: { key: 'hdr.stOff',       color: 'var(--color-dash-text-dim)', warn: true },
		1: { key: 'hdr.stNoMap',     color: 'var(--color-dash-warn)',     warn: true },
		2: { key: 'hdr.stNoRpm',     color: 'var(--color-dash-warn)',     warn: true },
		3: { key: 'hdr.stNoTps',     color: 'var(--color-dash-warn)',     warn: true },
		4: { key: 'hdr.stOverboost', color: 'var(--color-dash-danger)',   warn: true },
		5: { key: 'hdr.stIdle',      color: 'var(--color-dash-text-dim)', warn: false },
		6: { key: 'hdr.stSpool',     color: 'var(--color-dash-accent)',   warn: false },
		7: { key: 'hdr.stPid',       color: 'var(--color-dash-success)',  warn: false },
		8: { key: 'hdr.stCut',       color: 'var(--color-dash-danger)',   warn: true }
	};
	let st = $derived(state === undefined ? null : (STATES[Math.round(state)] ?? null));

	// В режиме «только BIAS» фаза регулирования (7) внутренне зовётся PID, но P/I/D
	// отключены — выход чистый feedforward. Показываем «BIAS», чтобы не путать.
	let stKey = $derived(
		st && Math.round(state!) === 7 && boostSettings.value.biasOnly ? 'hdr.stBias' : st?.key
	);
</script>

{#if boostOut !== undefined || co1 !== undefined}
	<div class="shrink-0 flex items-center gap-3 px-3 py-1 bg-[var(--color-dash-card)]/70 border-b border-[var(--color-dash-border)]/40 text-[10px] font-mono overflow-x-auto">
		<span class="text-[var(--color-dash-text-dim)] uppercase tracking-wider shrink-0">{t('hdr.canOut')}</span>

		{#if boostOut !== undefined}
			<div class="flex items-center gap-1.5 shrink-0">
				<span class="text-[var(--color-dash-text-dim)]">BOOST</span>
				<span class="text-[var(--color-dash-accent)] font-bold tabular-nums w-12 text-right">{fmt(boostOut)}%</span>
				<div class="w-16 h-1.5 rounded-full bg-[var(--color-dash-border)]/60 overflow-hidden">
					<div class="h-full bg-[var(--color-dash-accent)] transition-all duration-100" style="width: {boostPct}%"></div>
				</div>
			</div>
		{/if}

		{#if co1 !== undefined}
			<div class="flex items-center gap-1.5 shrink-0">
				<span class="text-[var(--color-dash-text-dim)]">CO1</span>
				<span class="text-[var(--color-dash-text)] font-bold tabular-nums">{fmt(co1)}</span>
			</div>
		{/if}

		<!-- Boost state chip: explains why the output is what it is -->
		{#if st}
			<div class="flex items-center gap-1 shrink-0 ml-auto px-1.5 py-0.5 rounded"
				style="color: {st.color}; background-color: color-mix(in srgb, {st.color} 14%, transparent);">
				{#if st.warn}
					<svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
						<path d="M12 9v4m0 4h.01M10.3 3.86l-8.4 14.55A1.5 1.5 0 003.2 21h17.6a1.5 1.5 0 001.3-2.59L13.7 3.86a1.5 1.5 0 00-2.6 0z" />
					</svg>
				{/if}
				<span class="font-bold uppercase tracking-wide">{t(stKey)}</span>
			</div>
		{/if}
	</div>
{/if}
