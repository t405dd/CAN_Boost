<script lang="ts">
	import { t } from '$lib/i18n/index.svelte';
	import { bleState } from '$lib/stores/ble-connection.svelte';
	import { liveData } from '$lib/stores/live-data.svelte';
	import {
		logState, restoreLog, startRecording, stopRecording, clearLog,
		markEvent, shareLog, downloadLog
	} from '$lib/stores/client-log.svelte';
	import { debugLog, clearDebugLog, debugLogText } from '$lib/stores/debug-log.svelte';

	let isConnected = $derived(bleState.status === 'connected');
	let rate = $state(10);
	let markText = $state('');
	let statusMsg = $state('');
	let shareSupported = $derived(typeof navigator !== 'undefined' && !!(navigator as any).canShare);

	// Restore a previous (persisted) session once on mount.
	$effect(() => { void restoreLog(); });

	// Ticking clock for duration readout while recording.
	let now = $state(Date.now());
	$effect(() => {
		if (!logState.recording) return;
		const id = setInterval(() => { now = Date.now(); }, 500);
		return () => clearInterval(id);
	});

	let durationMs = $derived(logState.recording ? now - logState.startedAt : 0);

	function fmtDuration(ms: number): string {
		const s = Math.floor(ms / 1000);
		const m = Math.floor(s / 60);
		const sec = s % 60;
		return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
	}
	function fmtSize(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
	}

	const RATES = [2, 5, 10, 20, 25];

	function flash(msg: string) {
		statusMsg = msg;
		setTimeout(() => { if (statusMsg === msg) statusMsg = ''; }, 3000);
	}

	async function toggleRecord() {
		if (logState.recording) await stopRecording();
		else await startRecording(rate);
	}

	function doMark() {
		const txt = markText.trim() || 'mark';
		markEvent(txt);
		markText = '';
		flash(t('clog.marked'));
	}

	async function doShare() {
		const r = await shareLog();
		if (r === 'empty') flash(t('clog.noRows'));
		else if (r === 'downloaded') flash(t('clog.downloaded'));
		else flash(t('clog.shared'));
	}

	function doDownload() {
		const r = downloadLog();
		flash(r === 'empty' ? t('clog.noRows') : t('clog.downloaded'));
	}

	async function doClear() {
		if (!confirm(t('clog.clearConfirm'))) return;
		await clearLog();
		flash(t('clog.cleared'));
	}

	// --- Встроенный лог-вьюер (диагностика BLE на телефоне) ---
	let showDebug = $state(false);
	async function copyDebug() {
		const text = debugLogText();
		try {
			if (navigator.clipboard?.writeText) {
				await navigator.clipboard.writeText(text);
				flash(t('clog.dbgCopied'));
				return;
			}
		} catch { /* fallthrough to share */ }
		try {
			const nav = navigator as Navigator & { share?: (d: ShareData) => Promise<void> };
			if (nav.share) { await nav.share({ text }); return; }
		} catch { /* ignore */ }
		flash(t('clog.dbgCopyFail'));
	}

	// Compact live preview of key boost values (enum ids from protocol.ts).
	const PREVIEW = [
		{ id: 4, key: 'clog.pvTarget' as const },
		{ id: 3, key: 'clog.pvOutput' as const },
		{ id: 5, key: 'clog.pvError' as const },
		{ id: 7, key: 'clog.pvI' as const }
	];
	function pv(id: number): string {
		const v = liveData.params[id]?.value;
		return v === undefined ? '—' : (Number.isInteger(v) ? String(v) : v.toFixed(2));
	}
</script>

<div class="space-y-3">
	<div class="flex items-center justify-between text-xs text-[var(--color-dash-text-dim)]">
		<span class="uppercase tracking-wider">{t('clog.title')}</span>
		{#if statusMsg}<span class="text-[var(--color-dash-accent)]">{statusMsg}</span>{/if}
	</div>

	<p class="text-[11px] text-[var(--color-dash-text-dim)] leading-snug">{t('clog.hint')}</p>

	{#if !isConnected && !logState.recording}
		<div class="px-3 py-2 rounded-lg bg-[var(--color-dash-warn)]/10 border border-[var(--color-dash-warn)]/30 text-[11px] text-[var(--color-dash-warn)]">
			{t('clog.connectHint')}
		</div>
	{/if}

	<!-- Recorder card -->
	<section class="rounded-lg bg-[var(--color-dash-card)] border border-[var(--color-dash-border)]/50 p-3 space-y-3">
		<!-- Rate -->
		<div class="flex items-center gap-2 flex-wrap">
			<span class="text-[10px] text-[var(--color-dash-text-dim)] uppercase">{t('clog.rate')}</span>
			{#each RATES as r}
				<button onclick={() => rate = r} disabled={logState.recording}
					class="px-2 py-1 rounded text-[11px] font-mono transition-colors disabled:opacity-40
						{rate === r ? 'bg-[var(--color-dash-accent)] text-black font-bold' : 'bg-[var(--color-dash-border)]/50 text-[var(--color-dash-text-dim)] hover:text-[var(--color-dash-text)]'}">
					{r} Hz
				</button>
			{/each}
		</div>

		<!-- Start/Stop -->
		<button onclick={toggleRecord}
			class="w-full py-3 rounded-lg font-bold text-sm active:scale-95 transition-all
				{logState.recording
					? 'bg-[var(--color-dash-danger)]/20 text-[var(--color-dash-danger)] border border-[var(--color-dash-danger)]/40'
					: 'bg-[var(--color-dash-success)]/20 text-[var(--color-dash-success)] border border-[var(--color-dash-success)]/40'}">
			<span class="inline-flex items-center gap-2 justify-center">
				{#if logState.recording}
					<span class="w-2.5 h-2.5 rounded-full bg-[var(--color-dash-danger)] animate-pulse"></span>
					{t('clog.stop')}
				{:else}
					<span class="w-2.5 h-2.5 rounded-sm bg-[var(--color-dash-success)]"></span>
					{t('clog.start')}
				{/if}
			</span>
		</button>

		<!-- Stats -->
		<div class="grid grid-cols-2 sm:grid-cols-4 gap-2 text-center">
			<div class="rounded bg-[var(--color-dash-bg)] p-2">
				<div class="text-[9px] text-[var(--color-dash-text-dim)] uppercase">{t('clog.duration')}</div>
				<div class="text-sm font-mono text-[var(--color-dash-text)]">{fmtDuration(durationMs)}</div>
			</div>
			<div class="rounded bg-[var(--color-dash-bg)] p-2">
				<div class="text-[9px] text-[var(--color-dash-text-dim)] uppercase">{t('clog.rows')}</div>
				<div class="text-sm font-mono text-[var(--color-dash-text)]">{logState.rowCount}</div>
			</div>
			<div class="rounded bg-[var(--color-dash-bg)] p-2">
				<div class="text-[9px] text-[var(--color-dash-text-dim)] uppercase">{t('clog.size')}</div>
				<div class="text-sm font-mono text-[var(--color-dash-text)]">{fmtSize(logState.approxBytes)}</div>
			</div>
			<div class="rounded bg-[var(--color-dash-bg)] p-2">
				<div class="text-[9px] text-[var(--color-dash-text-dim)] uppercase">{t('clog.cols')}</div>
				<div class="text-sm font-mono text-[var(--color-dash-text)]">{logState.columns.length}</div>
			</div>
		</div>

		{#if logState.capped}
			<div class="text-[10px] text-[var(--color-dash-warn)]">{t('clog.capped')}</div>
		{/if}
		{#if logState.lastError}
			<div class="text-[10px] text-[var(--color-dash-danger)]">{logState.lastError}</div>
		{/if}

		<!-- Marker -->
		<div class="flex items-center gap-2">
			<input type="text" bind:value={markText} placeholder={t('clog.markPlaceholder')}
				disabled={!logState.recording}
				class="flex-1 min-w-0 px-2 py-1.5 text-xs rounded bg-[var(--color-dash-bg)] border border-[var(--color-dash-border)] text-[var(--color-dash-text)] focus:border-[var(--color-dash-accent)] focus:outline-none disabled:opacity-40" />
			<button onclick={doMark} disabled={!logState.recording}
				class="px-3 py-1.5 text-xs rounded bg-[var(--color-dash-warn)]/15 text-[var(--color-dash-warn)] hover:bg-[var(--color-dash-warn)]/25 transition-colors disabled:opacity-40 shrink-0">
				{t('clog.mark')}
			</button>
		</div>
	</section>

	<!-- Live preview -->
	{#if isConnected}
		<div class="grid grid-cols-4 gap-2">
			{#each PREVIEW as p}
				<div class="p-2 rounded-lg bg-[var(--color-dash-card)] border border-[var(--color-dash-border)]/40 text-center">
					<div class="text-[9px] text-[var(--color-dash-text-dim)] uppercase truncate">{t(p.key)}</div>
					<div class="text-sm font-bold font-mono text-[var(--color-dash-text)]">{pv(p.id)}</div>
				</div>
			{/each}
		</div>
	{/if}

	<!-- Export / clear -->
	<section class="rounded-lg bg-[var(--color-dash-card)] border border-[var(--color-dash-border)]/50 p-3 space-y-2">
		<div class="flex items-center justify-between">
			<span class="text-[11px] text-[var(--color-dash-text-dim)]">{t('clog.export')}</span>
			{#if !shareSupported}<span class="text-[9px] text-[var(--color-dash-text-dim)]">{t('clog.shareUnsupported')}</span>{/if}
		</div>
		<div class="flex items-center gap-2 flex-wrap">
			<button onclick={doShare} disabled={!logState.hasData}
				class="flex-1 min-w-[120px] px-3 py-2.5 rounded-lg bg-[var(--color-dash-accent)]/15 text-[var(--color-dash-accent)] text-sm font-bold hover:bg-[var(--color-dash-accent)]/25 transition-colors disabled:opacity-40">
				{t('clog.share')}
			</button>
			<button onclick={doDownload} disabled={!logState.hasData}
				class="px-3 py-2.5 rounded-lg bg-[var(--color-dash-border)]/50 text-[var(--color-dash-text)] text-sm hover:bg-[var(--color-dash-border)] transition-colors disabled:opacity-40">
				{t('clog.download')}
			</button>
			<button onclick={doClear} disabled={!logState.hasData || logState.recording}
				class="px-3 py-2.5 rounded-lg bg-[var(--color-dash-danger)]/10 text-[var(--color-dash-danger)] text-sm border border-[var(--color-dash-danger)]/20 hover:bg-[var(--color-dash-danger)]/20 transition-colors disabled:opacity-40">
				{t('clog.clear')}
			</button>
		</div>
	</section>

	<!-- Встроенный лог-вьюер: console.* (BLE/hydrate) прямо на телефоне -->
	<section class="rounded-lg bg-[var(--color-dash-card)] border border-[var(--color-dash-border)]/50">
		<button class="w-full flex items-center justify-between p-3" onclick={() => showDebug = !showDebug}>
			<span class="text-[11px] uppercase tracking-wider text-[var(--color-dash-text-dim)]">
				{t('clog.debugLog')} <span class="text-[var(--color-dash-text-dim)]/60">({debugLog.lines.length})</span>
			</span>
			<span class="text-xs text-[var(--color-dash-text-dim)]">{showDebug ? '−' : '+'}</span>
		</button>
		{#if showDebug}
			<div class="px-3 pb-3 space-y-2">
				<div class="flex items-center gap-2">
					<button onclick={copyDebug}
						class="px-3 py-1.5 text-xs rounded bg-[var(--color-dash-accent)]/15 text-[var(--color-dash-accent)] hover:bg-[var(--color-dash-accent)]/25 transition-colors">
						{t('clog.dbgCopy')}
					</button>
					<button onclick={clearDebugLog}
						class="px-3 py-1.5 text-xs rounded bg-[var(--color-dash-border)]/50 text-[var(--color-dash-text-dim)] hover:bg-[var(--color-dash-border)] transition-colors">
						{t('clog.clear')}
					</button>
				</div>
				<div class="max-h-72 overflow-auto rounded bg-[var(--color-dash-bg)] border border-[var(--color-dash-border)]/40 p-2">
					{#if debugLog.lines.length === 0}
						<div class="text-[11px] text-[var(--color-dash-text-dim)]">{t('clog.dbgEmpty')}</div>
					{:else}
						<pre class="text-[10px] leading-relaxed font-mono text-[var(--color-dash-text)] whitespace-pre-wrap break-all select-text">{debugLog.lines.join('\n')}</pre>
					{/if}
				</div>
			</div>
		{/if}
	</section>
</div>
