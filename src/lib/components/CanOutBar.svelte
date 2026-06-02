<script lang="ts">
	// Persistent header strip showing what the device transmits on the CAN bus:
	// boost controller output (enum 3) and CO1 (enum 2). Both arrive in the live
	// stream, so this just reflects the latest sampled values.
	import { liveData } from '$lib/stores/live-data.svelte';
	import { t } from '$lib/i18n/index.svelte';

	let boostOut = $derived(liveData.params[3]?.value);
	let co1 = $derived(liveData.params[2]?.value);

	let boostPct = $derived(boostOut === undefined ? 0 : Math.max(0, Math.min(100, boostOut)));

	function fmt(v: number, d = 1): string {
		return Number.isInteger(v) ? String(v) : v.toFixed(d);
	}
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
	</div>
{/if}
