<script lang="ts">
	// Карточка обновления прошивки на /system — подробный вид того же процесса, что и баннер
	// в шапке: состояние живёт в сторе fw-update, а не здесь. Поэтому уход со страницы посреди
	// заливки её не обрывает, а вернувшись, видно тот же прогресс и тот же лог.
	//
	// Два источника образа:
	//   • манифест рядом с приложением (firmware/manifest.json) — авто-проверка версии, кнопка
	//     появляется сама; качается ПРЕДСЖАТЫЙ .z;
	//   • файл с устройства (.bin) — работает всегда, в том числе без интернета и для своих
	//     сборок. Сжатие тогда делает браузер.
	import { t } from '$lib/i18n/index.svelte';
	import { fwUpdate, fwBusy, fwHasUpdate, fwOtaSupported, checkFwManifest, startFwUpdate, dismissFwError } from '$lib/stores/fw-update.svelte';
	import type { DeviceInfo } from '$lib/types/config';

	let { info }: { info: DeviceInfo | null } = $props();

	let showConfirm = $state<'manifest' | 'file' | null>(null);
	let pendingFile = $state<{ name: string; buf: ArrayBuffer } | null>(null);
	let fileInput = $state<HTMLInputElement | null>(null);

	let busy = $derived(fwBusy());
	let phase = $derived(fwUpdate.phase);

	// Манифест статический — одного чтения за сессию достаточно (внутри guard). Шапка тоже
	// его дёргает; дубля не будет.
	checkFwManifest();

	async function onFilePicked(e: Event) {
		const input = e.target as HTMLInputElement;
		const file = input.files?.[0];
		input.value = ''; // чтобы повторный выбор того же файла снова сработал
		if (!file) return;
		pendingFile = { name: file.name, buf: await file.arrayBuffer() };
		showConfirm = 'file';
	}

	async function start(source: 'manifest' | 'file') {
		showConfirm = null;
		const buf = source === 'file' ? pendingFile?.buf : undefined;
		pendingFile = null;
		await startFwUpdate(buf);
	}

	// Полоса прогресса: заливка (accent) → запись во flash (warn) → готово (success).
	let barColor = $derived(
		phase === 'error' ? 'var(--color-dash-danger)'
			: phase === 'done' ? 'var(--color-dash-success)'
			: phase === 'flashing' || phase === 'verifying' ? 'var(--color-dash-warn)'
			: 'var(--color-dash-accent)'
	);

	// Явная таблица вместо шаблонной строки — так отсутствующий перевод ловит компилятор,
	// а не пользователь, который увидит ключ вместо текста.
	const PHASE_KEYS = {
		idle: 'ota.phase.idle',
		preparing: 'ota.phase.preparing',
		downloading: 'ota.phase.downloading',
		compressing: 'ota.phase.compressing',
		uploading: 'ota.phase.uploading',
		flashing: 'ota.phase.flashing',
		verifying: 'ota.phase.verifying',
		done: 'ota.phase.done',
		error: 'ota.phase.error'
	} as const;
	let phaseLabel = $derived(t(PHASE_KEYS[phase]));
</script>

<div class="p-3 rounded-lg bg-[var(--color-dash-card)] border border-[var(--color-dash-border)]/50">
	<span class="text-xs text-[var(--color-dash-text-dim)] uppercase tracking-wider block mb-2">{t('ota.title')}</span>

	<!-- Что залито сейчас -->
	<div class="grid grid-cols-2 gap-x-4 gap-y-1.5 mb-3">
		<div>
			<div class="text-[9px] text-[var(--color-dash-text-dim)] uppercase">{t('ota.installed')}</div>
			<div class="text-sm text-[var(--color-dash-text)] font-bold tabular-nums">{info?.version ?? '—'}</div>
		</div>
		<div>
			<div class="text-[9px] text-[var(--color-dash-text-dim)] uppercase">{t('ota.available')}</div>
			<div class="text-sm font-bold tabular-nums {fwHasUpdate() ? 'text-[var(--color-dash-warn)]' : 'text-[var(--color-dash-text-dim)]'}">
				{fwUpdate.manifest?.version ?? '—'}
			</div>
		</div>
		{#if info?.built}
			<div class="col-span-2">
				<div class="text-[9px] text-[var(--color-dash-text-dim)] uppercase">{t('ota.built')}</div>
				<div class="text-[11px] text-[var(--color-dash-text-dim)] font-mono">{info.built}{info.partition ? ` · ${info.partition}` : ''}</div>
			</div>
		{/if}
	</div>

	{#if !fwOtaSupported()}
		<!-- Однораздельная таблица: OTA невозможна физически, и лучше сказать это заранее,
		     чем дать нажать кнопку и получить отказ на OTA_BEGIN. -->
		<div class="p-2.5 rounded border border-[var(--color-dash-warn)]/40 bg-[var(--color-dash-warn)]/5 mb-3">
			<p class="text-[11px] text-[var(--color-dash-warn)]">{t('ota.noPartition')}</p>
		</div>
	{/if}

	{#if !busy}
		<p class="text-[10px] text-[var(--color-dash-text-dim)] mb-2">{t('ota.hint')}</p>

		{#if fwHasUpdate() && fwOtaSupported()}
			{#if fwUpdate.manifest?.notes}
				<p class="text-[10px] text-[var(--color-dash-text)] mb-2 whitespace-pre-line">{fwUpdate.manifest.notes}</p>
			{/if}
			<button onclick={() => (showConfirm = 'manifest')}
				class="w-full py-2 mb-2 rounded text-xs font-bold bg-[var(--color-dash-warn)]/10 text-[var(--color-dash-warn)] border border-[var(--color-dash-warn)]/20 hover:bg-[var(--color-dash-warn)]/20 transition-colors">
				{t('ota.updateTo')} {fwUpdate.manifest?.version}
			</button>
		{/if}

		<input type="file" accept=".bin,application/octet-stream" class="hidden"
			bind:this={fileInput} onchange={onFilePicked} />
		<button onclick={() => fileInput?.click()} disabled={!fwOtaSupported()}
			class="w-full py-2 rounded text-xs font-bold bg-[var(--color-dash-accent)]/10 text-[var(--color-dash-accent)] border border-[var(--color-dash-accent)]/20 hover:bg-[var(--color-dash-accent)]/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
			{t('ota.pickFile')}
		</button>
	{/if}

	{#if showConfirm}
		<div class="mt-2 p-2.5 rounded border border-[var(--color-dash-warn)]/40 bg-[var(--color-dash-warn)]/5">
			<p class="text-xs text-[var(--color-dash-warn)] mb-1 font-bold">{t('ota.confirmTitle')}</p>
			<p class="text-[10px] text-[var(--color-dash-text-dim)] mb-2">
				{showConfirm === 'file' ? pendingFile?.name : `${info?.version} → ${fwUpdate.manifest?.version}`}
			</p>
			<p class="text-[10px] text-[var(--color-dash-danger)] mb-2">{t('ota.confirmWarn')}</p>
			<div class="flex gap-2">
				<button onclick={() => start(showConfirm!)}
					class="flex-1 py-1.5 rounded text-xs font-bold bg-[var(--color-dash-warn)] text-black hover:bg-[var(--color-dash-warn)]/80 transition-colors">
					{t('ota.start')}
				</button>
				<button onclick={() => { showConfirm = null; pendingFile = null; }}
					class="flex-1 py-1.5 rounded text-xs font-bold bg-[var(--color-dash-border)]/50 text-[var(--color-dash-text-dim)] hover:bg-[var(--color-dash-border)] transition-colors">
					{t('common.cancel')}
				</button>
			</div>
		</div>
	{/if}

	{#if phase !== 'idle'}
		<div class="mt-3">
			<div class="flex items-center justify-between mb-1">
				<span class="text-[10px] font-bold" style="color: {barColor}">{phaseLabel}</span>
				<span class="text-[10px] text-[var(--color-dash-text-dim)] tabular-nums">
					{#if phase === 'uploading' && fwUpdate.speedKbs > 0}
						{fwUpdate.speedKbs.toFixed(1)} KB/s · {Math.ceil(fwUpdate.etaSec)} s ·
					{/if}
					{fwUpdate.pct}%
				</span>
			</div>
			<div class="h-1.5 rounded-full bg-[var(--color-dash-border)]/40 overflow-hidden">
				<div class="h-full transition-[width] duration-150" style="width: {fwUpdate.pct}%; background-color: {barColor}"></div>
			</div>

			{#if phase === 'done'}
				<p class="mt-2 text-[11px] text-[var(--color-dash-success)]">{t('ota.doneHint')}</p>
			{:else if phase === 'error'}
				<p class="mt-2 text-[11px] text-[var(--color-dash-danger)] font-mono break-all">{fwUpdate.error}</p>
				<button onclick={dismissFwError}
					class="mt-2 w-full py-1.5 rounded text-[11px] font-bold bg-[var(--color-dash-border)]/50 text-[var(--color-dash-text-dim)] hover:bg-[var(--color-dash-border)] transition-colors">
					{t('common.close')}
				</button>
			{:else}
				<p class="mt-2 text-[11px] text-[var(--color-dash-warn)]">{t('ota.doNotDisconnect')}</p>
			{/if}

			{#if fwUpdate.log.length}
				<!-- Терминал: единственный носитель диалога с прошивкой (OTA_ACK/OTA_LINK/OTA_ERROR).
				     Без него любой сбой выглядел бы просто как «не получилось». -->
				<pre class="mt-2 max-h-40 overflow-y-auto text-[10px] leading-relaxed font-mono text-[var(--color-dash-text-dim)] bg-[var(--color-dash-bg)] rounded p-2 whitespace-pre-wrap break-all">{fwUpdate.log.join('\n')}</pre>
			{/if}
		</div>
	{/if}
</div>
