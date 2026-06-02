<script lang="ts">
	// Заглушка для страниц в состоянии «не подключено»: сообщение + кнопка «Подключиться»,
	// а во время (пере)подключения — спиннер и текущий шаг. Позволяет подключаться с любой страницы.
	import { bleState, connect } from '$lib/stores/ble-connection.svelte';
	import { t } from '$lib/i18n/index.svelte';

	let working = $derived(bleState.status === 'connecting' || bleState.status === 'reconnecting');
</script>

<div class="flex flex-col items-center justify-center gap-4 py-12">
	<div class="w-14 h-14 rounded-full bg-[var(--color-dash-card)] border-2 border-[var(--color-dash-border)] flex items-center justify-center">
		{#if working}
			<div class="w-7 h-7 rounded-full border-2 border-[var(--color-dash-border)] border-t-[var(--color-dash-accent)] animate-spin"></div>
		{:else}
			<svg class="w-7 h-7 text-[var(--color-dash-accent)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
				<path d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z" />
			</svg>
		{/if}
	</div>

	{#if working}
		<p class="text-[var(--color-dash-warn)] text-sm font-bold">
			{bleState.status === 'reconnecting' ? t('ble.reconnectingBtn') : t('ble.connectingBtn')}
		</p>
		{#if bleState.statusStep !== 'idle'}
			<p class="text-[var(--color-dash-text-dim)] text-xs">
				{#if bleState.statusDetail}{t(`ble.step.${bleState.statusStep}` as any, bleState.statusDetail)}{:else}{t(`ble.step.${bleState.statusStep}` as any)}{/if}
			</p>
		{/if}
	{:else}
		<p class="text-[var(--color-dash-text-dim)] text-sm">{t('ble.connectPrompt')}</p>
		<button onclick={() => connect()}
			class="px-6 py-3 rounded-lg bg-[var(--color-dash-accent)] text-black font-bold text-sm
				hover:bg-[var(--color-dash-accent)]/80 active:scale-95 transition-all">
			{t('ble.connect')}
		</button>
	{/if}

	{#if bleState.lastError}
		<p class="text-[var(--color-dash-warn)] text-xs text-center max-w-xs">{bleState.lastError}</p>
	{/if}
</div>
