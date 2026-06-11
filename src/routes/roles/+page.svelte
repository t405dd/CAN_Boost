<script lang="ts">
	import { readJsonConfig, writeJsonConfig } from '$lib/ble/chunked-transfer';
	import { bleState } from '$lib/stores/ble-connection.svelte';
	import { SVC_CAN_CONFIG, CHR_SIGNAL_ROLES } from '$lib/ble/uuids';
	import type { SignalRoleInfo } from '$lib/types/config';
	import { t } from '$lib/i18n/index.svelte';
	import HelpTip from '$lib/components/HelpTip.svelte';
	import ConnectPrompt from '$lib/components/ConnectPrompt.svelte';
	import { base } from '$app/paths';

	// Имена ролей по значению SignalRole (прошивка data_structures.h)
	const ROLE_KEYS: Record<number, string> = {
		1: 'roles.map', 2: 'roles.rpm', 3: 'roles.tps',
		4: 'roles.knock', 5: 'roles.clt', 6: 'roles.app'
	};
	const SIGNAL_ROLE_COUNT = 7;

	let isConnected = $derived(bleState.status === 'connected');
	let roles = $state<SignalRoleInfo[]>([]);
	let loaded = $state(false);
	let loading = $state(false);
	let saving = $state(false);
	let statusMsg = $state('');
	let refreshTimer: ReturnType<typeof setInterval> | null = null;

	function showStatus(msg: string, durationMs = 3000) {
		statusMsg = msg;
		setTimeout(() => { statusMsg = ''; }, durationMs);
	}

	async function loadRoles(silent = false) {
		if (!silent) loading = true;
		try {
			const data = await readJsonConfig<{ roles: SignalRoleInfo[] }>(SVC_CAN_CONFIG, CHR_SIGNAL_ROLES);
			if (data && Array.isArray(data.roles)) {
				roles = data.roles;
				loaded = true;
			}
		} catch (e) {
			if (!silent) showStatus(t('canRx.loadFailed') + ': ' + (e as Error).message);
		} finally {
			if (!silent) loading = false;
		}
	}

	// Приоритет на роль: пишем массив preferLocal[SIGNAL_ROLE_COUNT] (индекс = значение роли)
	async function setPriority(role: number, preferLocal: boolean) {
		saving = true;
		try {
			const arr = new Array(SIGNAL_ROLE_COUNT).fill(0);
			for (const r of roles) arr[r.role] = r.role === role ? (preferLocal ? 1 : 0) : r.preferLocal;
			const ok = await writeJsonConfig(SVC_CAN_CONFIG, CHR_SIGNAL_ROLES, { preferLocal: arr });
			showStatus(ok ? t('canRx.savedOk') : t('canRx.saveFailed'));
			await loadRoles(true);   // перечитать: прошивка уже пере-резолвила активный источник
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
			loadRoles();
			refreshTimer = setInterval(() => loadRoles(true), 3000);   // live: активный источник/значение
		}
		if (!isConnected) {
			initialLoadDone = false;
			loaded = false;
			if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
		}
		return () => {
			if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
		};
	});
</script>

<div class="space-y-3">
	<div class="text-xs text-[var(--color-dash-text-dim)] uppercase tracking-wider inline-flex items-center gap-1">
		{t('roles.title')}<HelpTip key="help.roles.title" />
	</div>

	{#if !isConnected}
		<ConnectPrompt />
	{:else}
		{#if statusMsg}<div class="text-xs text-[var(--color-dash-text-dim)]">{statusMsg}</div>{/if}
		{#if loading && !loaded}
			<div class="flex items-center gap-2 text-[11px] text-[var(--color-dash-text-dim)] py-2">
				<span class="w-3 h-3 rounded-full border-2 border-[var(--color-dash-border)] border-t-[var(--color-dash-accent)] animate-spin"></span>
				{t('common.readingDevice')}
			</div>
		{/if}

		{#if loaded}
			<p class="text-[10px] text-[var(--color-dash-text-dim)]">{t('roles.hint')}</p>

			{#each roles as r}
				{@const hasCan = r.canParam > 0}
				{@const hasLocal = r.localParam > 0}
				{@const assigned = hasCan || hasLocal}
				<section class="rounded-lg bg-[var(--color-dash-card)] border border-[var(--color-dash-border)]/50 p-3 {assigned ? '' : 'opacity-60'}">
					<div class="flex items-center justify-between mb-2">
						<span class="text-sm font-bold text-[var(--color-dash-text)]">{t((ROLE_KEYS[r.role] ?? 'roles.unknown') as any)}</span>
						{#if assigned && r.value !== undefined}
							<span class="text-sm font-mono text-[var(--color-dash-accent)] tabular-nums">{r.value.toFixed(1)}</span>
						{:else if !assigned}
							<span class="text-[10px] text-[var(--color-dash-text-dim)] uppercase">{t('roles.notAssigned')}</span>
						{/if}
					</div>

					{#if assigned}
						<div class="grid grid-cols-2 gap-2">
							<!-- CAN источник -->
							<div class="rounded border px-2 py-1.5 {r.active === 1
								? 'border-[var(--color-dash-success)] bg-[var(--color-dash-success)]/10'
								: 'border-[var(--color-dash-border)]/60'}">
								<div class="flex items-center justify-between">
									<span class="text-[9px] uppercase text-[var(--color-dash-text-dim)]">{t('roles.srcCan')}</span>
									{#if r.active === 1}<span class="text-[9px] font-bold text-[var(--color-dash-success)] uppercase">{t('roles.active')}</span>{/if}
								</div>
								<div class="text-xs font-mono text-[var(--color-dash-text)] truncate">{hasCan ? (r.canName ?? '—') : '—'}</div>
							</div>
							<!-- Локальный источник -->
							<div class="rounded border px-2 py-1.5 {r.active === 2
								? 'border-[var(--color-dash-success)] bg-[var(--color-dash-success)]/10'
								: 'border-[var(--color-dash-border)]/60'}">
								<div class="flex items-center justify-between">
									<span class="text-[9px] uppercase text-[var(--color-dash-text-dim)]">{t('roles.srcLocal')}</span>
									{#if r.active === 2}<span class="text-[9px] font-bold text-[var(--color-dash-success)] uppercase">{t('roles.active')}</span>{/if}
								</div>
								<div class="text-xs font-mono text-[var(--color-dash-text)] truncate">{hasLocal ? (r.localName ?? '—') : '—'}</div>
							</div>
						</div>

						<!-- Приоритет failover: имеет смысл только когда есть оба источника -->
						{#if hasCan && hasLocal}
							<div class="flex items-center gap-2 mt-2">
								<span class="text-[10px] text-[var(--color-dash-text-dim)] uppercase inline-flex items-center gap-0.5">{t('roles.priority')}<HelpTip key="help.roles.priority" /></span>
								<button onclick={() => setPriority(r.role, false)} disabled={saving}
									class="px-2 py-0.5 text-[10px] rounded border transition-colors disabled:opacity-40 {r.preferLocal === 0
										? 'bg-[var(--color-dash-accent)]/20 border-[var(--color-dash-accent)] text-[var(--color-dash-accent)] font-bold'
										: 'border-[var(--color-dash-border)] text-[var(--color-dash-text-dim)] hover:border-[var(--color-dash-accent)]'}">
									{t('roles.srcCan')}
								</button>
								<button onclick={() => setPriority(r.role, true)} disabled={saving}
									class="px-2 py-0.5 text-[10px] rounded border transition-colors disabled:opacity-40 {r.preferLocal === 1
										? 'bg-[var(--color-dash-accent)]/20 border-[var(--color-dash-accent)] text-[var(--color-dash-accent)] font-bold'
										: 'border-[var(--color-dash-border)] text-[var(--color-dash-text-dim)] hover:border-[var(--color-dash-accent)]'}">
									{t('roles.srcLocal')}
								</button>
								<span class="text-[9px] text-[var(--color-dash-text-dim)]">{t('roles.failoverHint')}</span>
							</div>
						{/if}
					{/if}
				</section>
			{/each}

			<p class="text-[10px] text-[var(--color-dash-text-dim)]">
				{t('roles.assignHint')}
				<a href="{base}/can-receive" class="text-[var(--color-dash-accent)] underline">{t('nav.canReceive')}</a> /
				<a href="{base}/local-inputs" class="text-[var(--color-dash-accent)] underline">{t('nav.localInputs')}</a>
			</p>
		{/if}
	{/if}
</div>
