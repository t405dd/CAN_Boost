<script lang="ts">
	import { untrack } from 'svelte';
	import '../app.css';
	import { bleState, connect, disconnect, submitPin } from '$lib/stores/ble-connection.svelte';
	import { pwa, promptInstall } from '$lib/stores/pwa-install.svelte';
	import { pwaUpdate, checkForUpdate, applyUpdate } from '$lib/stores/pwa-update.svelte';
	import { boostMaps, setActiveBoostMap } from '$lib/stores/boost-maps.svelte';
	import { hydrateOnConnect, resetHydration } from '$lib/stores/hydrate.svelte';
	import { handleConnectionChange, markManualDisconnect } from '$lib/stores/client-log.svelte';
	import { t, i18n, setLocale, availableLocales } from '$lib/i18n/index.svelte';
	import CanOutBar from '$lib/components/CanOutBar.svelte';
	import BoostLiveBar from '$lib/components/BoostLiveBar.svelte';
	import { base } from '$app/paths';
	import { version } from '$app/environment';   // идентификатор загруженной сборки (см. svelte.config.js)
	import { initDebugLog } from '$lib/stores/debug-log.svelte';

	initDebugLog();   // перехват console.* в буфер (виден на стр. /logging) — для диагностики BLE на телефоне

	interface Props { children: import('svelte').Snippet }
	let { children }: Props = $props();

	let menuOpen = $state(false);
	let pinInput = $state('');

	// Единая гидрация при подключении: один оркестратор грузит все «лёгкие» конфиги в правильном
	// порядке (карты → boost_settings → co1 → подписи; большой chunked can_receive — последним).
	// Страницы биндятся к сторам и не показывают дефолты как реальные данные. См. hydrate.svelte.ts.
	$effect(() => {
		const status = bleState.status;   // ЕДИНСТВЕННАЯ зависимость эффекта
		// hydrate/reset пишут стора (resetHydration делает epoch++ — это чтение+запись реактивного
		// поля). Без untrack эти записи попали бы в зависимости эффекта → самоинвалидация →
		// effect_update_depth_exceeded (бесконечный цикл, ломавший реактивность и hydrate).
		untrack(() => {
			if (status === 'connected') {
				hydrateOnConnect().catch((e) => console.error('[hydrate] аварийно прервана:', e));
			} else {
				// disconnected/reconnecting/connecting — чистим стора + in-flight промисы, чтобы следующий
				// 'connected' (в т.ч. авто-реконнект через 'reconnecting') гидрировался заново, а не залипал.
				resetHydration();
			}
			// Логгер: пауза записи при потере связи, авто-возобновление после непреднамеренного обрыва.
			handleConnectionChange(status === 'connected');
		});
	});

	// Кнопка установки — только в браузере (с сайта), когда установка доступна
	// и приложение ещё не запущено как установленное (standalone).
	let showInstall = $derived(pwa.canInstall && !pwa.standalone);
	// Подсказка для iOS (там нет программной установки).
	let showIosHint = $derived(pwa.isIos && !pwa.standalone && !pwa.canInstall);

	const navItems = [
		{ href: '/', key: 'nav.liveData' as const, icon: 'M' },
		{ href: '/can-receive', key: 'nav.canReceive' as const, icon: 'R' },
		{ href: '/can-transmit', key: 'nav.canTransmit' as const, icon: 'T' },
		{ href: '/boost', key: 'nav.boost' as const, icon: 'B' },
		{ href: '/logging', key: 'nav.logging' as const, icon: 'L' },
		{ href: '/system', key: 'nav.system' as const, icon: 'G' }
	];

	const statusColors: Record<string, string> = {
		connected: 'bg-[var(--color-dash-success)]',
		connecting: 'bg-[var(--color-dash-warn)]',
		reconnecting: 'bg-[var(--color-dash-warn)]',
		disconnected: 'bg-[var(--color-dash-danger)]'
	};

	let isWorking = $derived(bleState.status === 'connecting' || bleState.status === 'reconnecting');

	/** Translate a connection step + detail into a user-friendly string */
	function stepText(): string {
		const step = bleState.statusStep;
		const detail = bleState.statusDetail;
		const key = `ble.step.${step}` as any;
		// Try translated text with detail as {0} argument
		if (detail) return t(key, detail);
		return t(key);
	}

	function handleConnect() {
		if (bleState.status === 'connected') {
			markManualDisconnect();   // отличить ручное отключение от обрыва (без авто-возобновления записи)
			disconnect();
		} else if (bleState.status === 'disconnected') {
			connect();
		}
	}

	// Ручная проверка обновления (кнопка в меню). 'ready' → применяем сразу; 'fresh' → подтверждаем.
	let updateMsg = $state('');
	async function doCheckUpdate() {
		updateMsg = '';
		const r = await checkForUpdate();
		if (r === 'ready' || pwaUpdate.updateReady) applyUpdate();
		else if (r === 'fresh') {
			updateMsg = t('pwa.upToDate');
			setTimeout(() => { updateMsg = ''; }, 3000);
		} else {
			updateMsg = t('pwa.updateUnsupported');
			setTimeout(() => { updateMsg = ''; }, 3000);
		}
	}
</script>

<div class="flex flex-col h-dvh bg-[var(--color-dash-bg)] no-select">
	<!-- Header -->
	<header class="flex items-center justify-between px-3 py-2 bg-[var(--color-dash-card)] border-b border-[var(--color-dash-border)] shrink-0">
		<button onclick={() => menuOpen = !menuOpen}
			class="w-8 h-8 flex items-center justify-center text-[var(--color-dash-text)] hover:text-[var(--color-dash-accent)] transition-colors">
			<svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
				{#if menuOpen}
					<path d="M6 18L18 6M6 6l12 12" />
				{:else}
					<path d="M4 6h16M4 12h16M4 18h16" />
				{/if}
			</svg>
		</button>

		<div class="flex flex-col items-center leading-none">
			<span class="text-sm font-bold tracking-wider text-[var(--color-dash-accent)]">MS3 CAN BC</span>
			<span class="text-[9px] text-[var(--color-dash-text-dim)] tracking-wide mt-0.5" title={t('pwa.buildVersion')}>v{version}</span>
		</div>

		<div class="flex items-center gap-2">
			{#if showInstall}
				<button onclick={promptInstall}
					class="flex items-center gap-1 px-2.5 py-1 rounded text-xs font-bold
						bg-[var(--color-dash-accent)]/15 text-[var(--color-dash-accent)] hover:bg-[var(--color-dash-accent)]/25 transition-colors">
					<svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
						<path d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
					</svg>
					{t('pwa.install')}
				</button>
			{/if}
			<button onclick={handleConnect}
				class="flex items-center gap-2 px-3 py-1 rounded text-xs transition-colors
					{bleState.status === 'connected' ? 'bg-[var(--color-dash-success)]/15 text-[var(--color-dash-success)]' :
					 bleState.status === 'disconnected' ? 'bg-[var(--color-dash-danger)]/15 text-[var(--color-dash-danger)]' :
					 'bg-[var(--color-dash-warn)]/15 text-[var(--color-dash-warn)]'}
					hover:opacity-80">
				<span class="w-2 h-2 rounded-full {statusColors[bleState.status]}"></span>
				{bleState.status === 'connected' ? t('ble.connected') :
				 bleState.status === 'connecting' ? t('ble.connecting') :
				 bleState.status === 'reconnecting' ? t('ble.reconnecting') : t('ble.disconnected')}
			</button>
		</div>
	</header>

	<!-- Доступно обновление PWA: применяется по кнопке (страница перезагрузится на новую сборку) -->
	{#if pwaUpdate.updateReady}
		<button onclick={applyUpdate}
			class="shrink-0 w-full px-3 py-1.5 bg-[var(--color-dash-accent)]/15 border-b border-[var(--color-dash-accent)]/30
				text-[11px] font-bold text-[var(--color-dash-accent)] text-center hover:bg-[var(--color-dash-accent)]/25 transition-colors">
			{t('pwa.updateAvailable')} — {t('pwa.update')}
		</button>
	{/if}

	<!-- iOS: установка только вручную -->
	{#if showIosHint}
		<div class="shrink-0 px-3 py-1.5 bg-[var(--color-dash-accent)]/10 border-b border-[var(--color-dash-accent)]/20
			text-[11px] text-[var(--color-dash-accent)] text-center">
			{t('pwa.iosHint')}
		</div>
	{/if}

	<!-- Connection progress bar -->
	{#if isWorking}
		<div class="shrink-0">
			<div class="h-0.5 bg-[var(--color-dash-border)] overflow-hidden">
				<div class="h-full bg-[var(--color-dash-accent)] animate-progress-bar"></div>
			</div>
			<div class="px-3 py-1 bg-[var(--color-dash-card)]/80 border-b border-[var(--color-dash-border)]/50
				text-xs text-[var(--color-dash-warn)] text-center tracking-wide">
				{stepText()}
			</div>
		</div>
	{/if}

	<!-- CAN OUT strip: what the device transmits (boost output + CO1) -->
	{#if bleState.status === 'connected'}
		<CanOutBar />
	{/if}

	<!-- Live boost strip: RPM / MAP / Error — всегда перед глазами на всех страницах -->
	{#if bleState.status === 'connected'}
		<BoostLiveBar />
	{/if}

	<!-- Сквозной селектор карт буста: на всех страницах. Показываем сразу при подключении —
	     имена/активная карта подтянутся, как только устройство ответит (на Android чтение мелкого
	     конфига иногда задерживается, но сама полоса и переключение доступны без ожидания). -->
	{#if bleState.status === 'connected'}
		<div class="shrink-0 flex items-stretch gap-1 px-2 py-1 bg-[var(--color-dash-card)] border-b border-[var(--color-dash-border)]/50">
			<span class="self-center text-[9px] uppercase tracking-wider text-[var(--color-dash-text-dim)] pr-1 shrink-0">{t('boost.maps')}</span>
			{#each boostMaps.mapsMeta as m, i}
				<button onclick={() => setActiveBoostMap(i)} disabled={boostMaps.switching}
					class="flex-1 min-w-0 px-1.5 py-1 text-[11px] rounded border truncate transition-colors disabled:opacity-50 {boostMaps.loaded && i === boostMaps.activeMap
						? 'bg-[var(--color-dash-accent)]/20 border-[var(--color-dash-accent)] text-[var(--color-dash-accent)] font-bold'
						: 'bg-[var(--color-dash-bg)] border-[var(--color-dash-border)] text-[var(--color-dash-text-dim)] hover:border-[var(--color-dash-accent)]'}">
					{m.name || `Map ${i + 1}`}
				</button>
			{/each}
			{#if boostMaps.switching || !boostMaps.loaded}
				<span class="self-center w-3 h-3 shrink-0 rounded-full border-2 border-[var(--color-dash-border)] border-t-[var(--color-dash-accent)] animate-spin"></span>
			{/if}
		</div>
	{/if}

	<!-- Navigation drawer -->
	{#if menuOpen}
		<div class="absolute inset-0 z-50 flex">
			<!-- Backdrop -->
			<button class="absolute inset-0 bg-black/60 cursor-default" onclick={() => menuOpen = false}
				aria-label="Close menu"></button>
			<!-- Drawer -->
			<nav class="relative w-64 h-full bg-[var(--color-dash-card)] border-r border-[var(--color-dash-border)] overflow-y-auto">
				<div class="p-4 border-b border-[var(--color-dash-border)]">
					<h2 class="text-sm font-bold text-[var(--color-dash-accent)] tracking-wider">{t('nav.title')}</h2>
				</div>
				{#each navItems as item}
					<a href="{base}{item.href}"
						class="flex items-center gap-3 px-4 py-3 text-sm text-[var(--color-dash-text)] hover:bg-[var(--color-dash-card-hover)] hover:text-[var(--color-dash-accent)] transition-colors border-b border-[var(--color-dash-border)]/30"
						onclick={() => menuOpen = false}>
						<span class="w-6 h-6 flex items-center justify-center rounded bg-[var(--color-dash-border)] text-[var(--color-dash-accent)] text-xs font-bold">{item.icon}</span>
						{t(item.key)}
					</a>
				{/each}
				<!-- Build version + ручная проверка обновления -->
				<div class="px-4 py-3 border-t border-[var(--color-dash-border)] space-y-2">
					<div>
						<div class="text-[10px] text-[var(--color-dash-text-dim)] uppercase tracking-wider">{t('pwa.buildVersion')}</div>
						<div class="text-xs font-mono text-[var(--color-dash-accent)] mt-0.5 select-text">v{version}</div>
					</div>
					{#if pwaUpdate.supported}
						<button onclick={doCheckUpdate} disabled={pwaUpdate.checking}
							class="w-full px-3 py-2 rounded-lg text-xs font-bold transition-colors disabled:opacity-50
								{pwaUpdate.updateReady
									? 'bg-[var(--color-dash-accent)] text-black'
									: 'bg-[var(--color-dash-border)]/60 text-[var(--color-dash-text)] hover:bg-[var(--color-dash-border)]'}">
							{pwaUpdate.checking ? t('pwa.checking') : pwaUpdate.updateReady ? t('pwa.update') : t('pwa.checkUpdate')}
						</button>
						{#if updateMsg}
							<div class="text-[10px] text-[var(--color-dash-text-dim)] text-center">{updateMsg}</div>
						{/if}
					{/if}
				</div>
				<!-- Language switcher -->
				<div class="p-4 border-t border-[var(--color-dash-border)]">
					<div class="flex items-center gap-2">
						<span class="text-xs text-[var(--color-dash-text-dim)]">{t('lang.label')}:</span>
						{#each availableLocales as loc}
							<button
								onclick={() => setLocale(loc.code)}
								class="px-2 py-1 rounded text-xs transition-colors
									{i18n.locale === loc.code
										? 'bg-[var(--color-dash-accent)] text-black font-bold'
										: 'bg-[var(--color-dash-border)] text-[var(--color-dash-text-dim)] hover:text-[var(--color-dash-text)]'}">
								{loc.label}
							</button>
						{/each}
					</div>
				</div>
			</nav>
		</div>
	{/if}

	<!-- Page content -->
	<main class="flex-1 overflow-y-auto p-3">
		{@render children()}
	</main>
</div>

<!-- PIN rejection modal -->
{#if bleState.pinRejected}
	<div class="fixed inset-0 z-[200] flex items-center justify-center bg-black/75">
		<div class="bg-[var(--color-dash-card)] border border-[var(--color-dash-danger)]/50 rounded-xl p-6 mx-4 w-full max-w-xs shadow-xl">
			<p class="text-sm font-bold text-[var(--color-dash-danger)] mb-1">{t('pin.wrongTitle')}</p>
			<p class="text-xs text-[var(--color-dash-text-dim)] mb-4">{t('pin.wrongHint')}</p>
			<label for="pin-input" class="block text-[10px] text-[var(--color-dash-text-dim)] uppercase tracking-wider mb-1">{t('pin.label')}</label>
			<input
				id="pin-input"
				bind:value={pinInput}
				type="password"
				inputmode="numeric"
				maxlength="16"
				placeholder="1234"
				class="w-full px-3 py-2 rounded-lg bg-[var(--color-dash-bg)] border border-[var(--color-dash-border)]
					text-[var(--color-dash-text)] text-sm tracking-widest mb-4 focus:outline-none focus:border-[var(--color-dash-accent)]"
				onkeydown={(e) => { if (e.key === 'Enter' && pinInput) submitPin(pinInput); }}
			/>
			<button
				onclick={() => { if (pinInput) submitPin(pinInput); }}
				disabled={!pinInput}
				class="w-full py-2.5 rounded-lg bg-[var(--color-dash-accent)] text-black font-bold text-sm
					disabled:opacity-40 disabled:cursor-not-allowed active:scale-95 transition-all">
				{t('pin.submit')}
			</button>
		</div>
	</div>
{/if}
