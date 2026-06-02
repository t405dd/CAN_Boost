<script lang="ts">
	import { bleState } from '$lib/stores/ble-connection.svelte';
	import { readJsonConfig, writeUint8 } from '$lib/ble/chunked-transfer';
	import { writeCharacteristic } from '$lib/ble/connection';
	import { SVC_SYSTEM, CHR_DEVICE_INFO, CHR_COMMAND, CHR_CURRENT_TIME,
		CMD_RESTART, CMD_FACTORY_RESET } from '$lib/ble/uuids';
	import type { DeviceInfo } from '$lib/types/config';
	import { t } from '$lib/i18n/index.svelte';
	import HelpTip from '$lib/components/HelpTip.svelte';
	import ConnectPrompt from '$lib/components/ConnectPrompt.svelte';

	let isConnected = $derived(bleState.status === 'connected');

	// --- Device Info ---
	let deviceInfo = $state<DeviceInfo | null>(null);
	let infoLoading = $state(false);
	let infoError = $state('');
	let refreshTimer = $state<ReturnType<typeof setInterval> | null>(null);

	async function loadDeviceInfo() {
		infoLoading = true;
		infoError = '';
		try {
			const data = await readJsonConfig<DeviceInfo>(SVC_SYSTEM, CHR_DEVICE_INFO);
			if (data) deviceInfo = data;
		} catch (e) {
			infoError = t('common.error');
			console.error('[System] Failed to read device info:', e);
		} finally {
			infoLoading = false;
		}
	}

	function formatHeap(bytes: number): string {
		return (bytes / 1024).toFixed(1) + ' KB';
	}
	function formatUptime(seconds: number): string {
		const h = Math.floor(seconds / 3600);
		const m = Math.floor((seconds % 3600) / 60);
		return `${h}h ${m.toString().padStart(2, '0')}m`;
	}

	$effect(() => {
		if (isConnected) {
			loadDeviceInfo();
			refreshTimer = setInterval(loadDeviceInfo, 5000);
		}
		return () => {
			if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
		};
	});

	// --- BLE PIN ---
	let localPin = $state(typeof window !== 'undefined' ? (localStorage.getItem('ble_pin') ?? '1234') : '1234');
	let pinSaveStatus = $state('');
	let pinOld = $state('');
	let pinNew = $state('');
	let pinChangeStatus = $state('');

	function saveLocalPin() {
		localStorage.setItem('ble_pin', localPin);
		pinSaveStatus = 'saved';
		setTimeout(() => pinSaveStatus = '', 2000);
	}

	async function changePinOnDevice() {
		if (!pinOld || !pinNew) return;
		pinChangeStatus = 'sending';
		try {
			const enc = new TextEncoder();
			const oldBytes = enc.encode(pinOld);
			const newBytes = enc.encode(pinNew);
			const buf = new Uint8Array(1 + oldBytes.length + 1 + newBytes.length);
			buf[0] = 0x10;
			buf.set(oldBytes, 1);
			buf[1 + oldBytes.length] = 0x00;
			buf.set(newBytes, 1 + oldBytes.length + 1);
			await writeCharacteristic(SVC_SYSTEM, CHR_COMMAND, buf.buffer);
			localStorage.setItem('ble_pin', pinNew);
			localPin = pinNew;
			pinOld = ''; pinNew = '';
			pinChangeStatus = 'changed';
		} catch (e) {
			console.error('[System] Failed to change PIN:', e);
			pinChangeStatus = 'error';
		}
		setTimeout(() => pinChangeStatus = '', 3000);
	}

	// --- Commands ---
	let restartStatus = $state('');
	let factoryResetStatus = $state('');
	let showFactoryConfirm = $state(false);

	async function restartDevice() {
		restartStatus = 'sending';
		try {
			await writeUint8(SVC_SYSTEM, CHR_COMMAND, CMD_RESTART);
			restartStatus = 'sent';
		} catch (e) {
			restartStatus = 'error';
			console.error('[System] Failed to restart:', e);
		}
		setTimeout(() => restartStatus = '', 3000);
	}

	async function factoryReset() {
		factoryResetStatus = 'sending';
		showFactoryConfirm = false;
		try {
			await writeUint8(SVC_SYSTEM, CHR_COMMAND, CMD_FACTORY_RESET);
			factoryResetStatus = 'sent';
		} catch (e) {
			factoryResetStatus = 'error';
			console.error('[System] Failed to factory reset:', e);
		}
		setTimeout(() => factoryResetStatus = '', 3000);
	}

	// --- Status LED legend (matches firmware can_bus_manager.cpp) ---
	const ledLegend = [
		{ color: '#2563ff', key: 'system.ledBoot' as const },
		{ color: '#16d24a', key: 'system.ledBoostOn' as const },
		{ color: '#e8e8e8', key: 'system.ledBoostOff' as const },
		{ color: '#ffd21a', key: 'system.ledNoData' as const },
		{ color: '#ff2b2b', key: 'system.ledFault' as const },
		{ color: '#ff2ea6', key: 'system.ledNoBus' as const },
	];

	// --- Time Sync ---
	let timeSyncStatus = $state('');
	async function syncTime() {
		timeSyncStatus = 'syncing';
		try {
			const timestamp = Math.floor(Date.now() / 1000);
			const buffer = new ArrayBuffer(4);
			new DataView(buffer).setUint32(0, timestamp, true);
			await writeCharacteristic(SVC_SYSTEM, CHR_CURRENT_TIME, buffer);
			timeSyncStatus = 'synced';
		} catch (e) {
			timeSyncStatus = 'error';
			console.error('[System] Time sync failed:', e);
		}
		setTimeout(() => timeSyncStatus = '', 3000);
	}
</script>

<div class="space-y-3">
	<div class="text-xs text-[var(--color-dash-text-dim)] uppercase tracking-wider">{t('system.title')}</div>

	{#if !isConnected}
		<ConnectPrompt />
	{:else}
		<!-- Device Info -->
		<div class="p-3 rounded-lg bg-[var(--color-dash-card)] border border-[var(--color-dash-border)]/50">
			<div class="flex items-center justify-between mb-3">
				<span class="text-xs text-[var(--color-dash-text-dim)] uppercase tracking-wider">{t('system.deviceInfo')}</span>
				<button onclick={loadDeviceInfo}
					class="text-[10px] text-[var(--color-dash-text-dim)] hover:text-[var(--color-dash-accent)] transition-colors" title="Refresh">
					<svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
						<path d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
					</svg>
				</button>
			</div>

			{#if infoError}<div class="text-xs text-[var(--color-dash-danger)] mb-2">{infoError}</div>{/if}

			{#if deviceInfo}
				<div class="grid grid-cols-2 gap-x-4 gap-y-1.5">
					<div>
						<div class="text-[9px] text-[var(--color-dash-text-dim)] uppercase">{t('common.name')}</div>
						<div class="text-sm text-[var(--color-dash-text)] font-bold">{deviceInfo.name}</div>
					</div>
					<div>
						<div class="text-[9px] text-[var(--color-dash-text-dim)] uppercase">{t('system.version')}</div>
						<div class="text-sm text-[var(--color-dash-accent)] font-bold tabular-nums">{deviceInfo.version}</div>
					</div>
					<div>
						<div class="text-[9px] text-[var(--color-dash-text-dim)] uppercase">{t('system.freeHeap')}</div>
						<div class="text-sm text-[var(--color-dash-text)] tabular-nums">{formatHeap(deviceInfo.heap)}</div>
					</div>
					<div>
						<div class="text-[9px] text-[var(--color-dash-text-dim)] uppercase">{t('system.freePsram')}</div>
						<div class="text-sm text-[var(--color-dash-text)] tabular-nums">{formatHeap(deviceInfo.psram)}</div>
					</div>
					<div>
						<div class="text-[9px] text-[var(--color-dash-text-dim)] uppercase">{t('system.uptime')}</div>
						<div class="text-sm text-[var(--color-dash-text)] tabular-nums">{formatUptime(deviceInfo.uptime)}</div>
					</div>
				</div>
			{:else if !infoLoading}
				<div class="text-center py-3 text-[var(--color-dash-text-dim)] text-xs">{t('system.noDeviceInfo')}</div>
			{/if}
		</div>

		<!-- BLE PIN -->
		<div class="p-3 rounded-lg bg-[var(--color-dash-card)] border border-[var(--color-dash-border)]/50">
			<span class="text-xs text-[var(--color-dash-text-dim)] uppercase tracking-wider block mb-2">{t('system.blePin')}</span>
			<p class="text-[10px] text-[var(--color-dash-text-dim)] mb-3">{t('system.blePinHint')}</p>

			<div class="flex items-center gap-2 mb-3">
				<div class="flex-1">
					<div class="text-[9px] text-[var(--color-dash-text-dim)] uppercase mb-1">{t('system.blePinCurrent')}</div>
					<input type="text" bind:value={localPin} maxlength="15"
						class="w-full px-2 py-1.5 rounded bg-[var(--color-dash-bg)] border border-[var(--color-dash-border)] text-xs text-[var(--color-dash-text)] font-mono outline-none focus:border-[var(--color-dash-accent)] transition-colors" />
				</div>
				<div class="flex flex-col items-end gap-1 shrink-0">
					{#if pinSaveStatus === 'saved'}<span class="text-[10px] text-[var(--color-dash-success)]">{t('system.blePinSaved')}</span>{/if}
					<button onclick={saveLocalPin}
						class="px-3 py-1.5 rounded text-[10px] font-bold bg-[var(--color-dash-accent)]/10 text-[var(--color-dash-accent)] border border-[var(--color-dash-accent)]/20 hover:bg-[var(--color-dash-accent)]/20 transition-colors">
						{t('system.blePinSaveLocal')}
					</button>
				</div>
			</div>

			<div class="pt-2 border-t border-[var(--color-dash-border)]/30">
				<div class="grid grid-cols-2 gap-2 mb-2">
					<div>
						<div class="text-[9px] text-[var(--color-dash-text-dim)] uppercase mb-1">{t('system.blePinOld')}</div>
						<input type="password" bind:value={pinOld} maxlength="15" placeholder="••••"
							class="w-full px-2 py-1.5 rounded bg-[var(--color-dash-bg)] border border-[var(--color-dash-border)] text-xs text-[var(--color-dash-text)] font-mono outline-none focus:border-[var(--color-dash-accent)] transition-colors" />
					</div>
					<div>
						<div class="text-[9px] text-[var(--color-dash-text-dim)] uppercase mb-1">{t('system.blePinNew')}</div>
						<input type="password" bind:value={pinNew} maxlength="15" placeholder="••••"
							class="w-full px-2 py-1.5 rounded bg-[var(--color-dash-bg)] border border-[var(--color-dash-border)] text-xs text-[var(--color-dash-text)] font-mono outline-none focus:border-[var(--color-dash-accent)] transition-colors" />
					</div>
				</div>
				<div class="flex items-center justify-between">
					{#if pinChangeStatus === 'changed'}<span class="text-[10px] text-[var(--color-dash-success)]">{t('system.blePinChanged')}</span>
					{:else if pinChangeStatus === 'error'}<span class="text-[10px] text-[var(--color-dash-danger)]">{t('system.blePinChangeFailed')}</span>
					{:else}<span></span>{/if}
					<button onclick={changePinOnDevice} disabled={!pinOld || !pinNew || pinChangeStatus === 'sending'}
						class="px-3 py-1.5 rounded text-[10px] font-bold bg-[var(--color-dash-warn)]/10 text-[var(--color-dash-warn)] border border-[var(--color-dash-warn)]/20 hover:bg-[var(--color-dash-warn)]/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
						{pinChangeStatus === 'sending' ? t('system.sending') : t('system.blePinChangeOnDevice')}
					</button>
				</div>
			</div>
		</div>

		<!-- Commands -->
		<div class="p-3 rounded-lg bg-[var(--color-dash-card)] border border-[var(--color-dash-border)]/50">
			<span class="text-xs text-[var(--color-dash-text-dim)] uppercase tracking-wider block mb-3">{t('system.commands')}</span>

			<div class="space-y-2">
				<button onclick={restartDevice} disabled={restartStatus === 'sending'}
					class="w-full py-2 rounded text-xs font-bold bg-[var(--color-dash-warn)]/10 text-[var(--color-dash-warn)] border border-[var(--color-dash-warn)]/20 hover:bg-[var(--color-dash-warn)]/20 transition-colors disabled:opacity-40">
					{#if restartStatus === 'sending'}{t('system.sending')}
					{:else if restartStatus === 'sent'}{t('system.restartSent')}
					{:else if restartStatus === 'error'}{t('system.sendFailed')}
					{:else}{t('system.restart')}{/if}
				</button>

				{#if showFactoryConfirm}
					<div class="p-2.5 rounded border border-[var(--color-dash-danger)]/40 bg-[var(--color-dash-danger)]/5">
						<p class="text-xs text-[var(--color-dash-danger)] mb-2 font-bold">{t('system.factoryResetConfirm')}</p>
						<div class="flex gap-2">
							<button onclick={factoryReset} class="flex-1 py-1.5 rounded text-xs font-bold bg-[var(--color-dash-danger)] text-white hover:bg-[var(--color-dash-danger)]/80 transition-colors">{t('system.factoryResetYes')}</button>
							<button onclick={() => showFactoryConfirm = false} class="flex-1 py-1.5 rounded text-xs font-bold bg-[var(--color-dash-border)]/50 text-[var(--color-dash-text-dim)] hover:bg-[var(--color-dash-border)] transition-colors">{t('common.cancel')}</button>
						</div>
					</div>
				{:else}
					<button onclick={() => showFactoryConfirm = true} disabled={factoryResetStatus === 'sending'}
						class="w-full py-2 rounded text-xs font-bold bg-[var(--color-dash-danger)]/10 text-[var(--color-dash-danger)] border border-[var(--color-dash-danger)]/20 hover:bg-[var(--color-dash-danger)]/20 transition-colors disabled:opacity-40">
						{#if factoryResetStatus === 'sent'}{t('system.factoryResetSent')}{:else}{t('system.factoryReset')}{/if}
					</button>
				{/if}
			</div>
		</div>

		<!-- Time Sync -->
		<div class="p-3 rounded-lg bg-[var(--color-dash-card)] border border-[var(--color-dash-border)]/50">
			<span class="text-xs text-[var(--color-dash-text-dim)] uppercase tracking-wider block mb-3">{t('system.timeSync')}</span>
			<p class="text-[10px] text-[var(--color-dash-text-dim)] mb-2">{t('system.timeSyncHint')}</p>
			<button onclick={syncTime} disabled={timeSyncStatus === 'syncing'}
				class="w-full py-2 rounded text-xs font-bold bg-[var(--color-dash-accent)]/10 text-[var(--color-dash-accent)] border border-[var(--color-dash-accent)]/20 hover:bg-[var(--color-dash-accent)]/20 transition-colors disabled:opacity-40">
				{#if timeSyncStatus === 'syncing'}{t('system.syncing')}
				{:else if timeSyncStatus === 'synced'}<span class="text-[var(--color-dash-success)]">{t('system.timeSynced')}</span>
				{:else if timeSyncStatus === 'error'}<span class="text-[var(--color-dash-danger)]">{t('system.syncFailed')}</span>
				{:else}{t('system.syncNow')}{/if}
			</button>
		</div>

		<!-- Status LED legend -->
		<div class="p-3 rounded-lg bg-[var(--color-dash-card)] border border-[var(--color-dash-border)]/50">
			<span class="text-xs text-[var(--color-dash-text-dim)] uppercase tracking-wider block mb-2">{t('system.led')}</span>
			<p class="text-[10px] text-[var(--color-dash-text-dim)] mb-3">{t('system.ledHint')}</p>
			<div class="space-y-2">
				{#each ledLegend as item}
					<div class="flex items-center gap-2.5">
						<span class="w-3.5 h-3.5 rounded-full shrink-0 border border-black/30"
							style="background-color: {item.color}; box-shadow: 0 0 6px {item.color};"></span>
						<span class="text-xs text-[var(--color-dash-text)]">{t(item.key)}</span>
					</div>
				{/each}
			</div>
		</div>
	{/if}
</div>
