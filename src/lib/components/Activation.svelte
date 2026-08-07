<script lang="ts">
	// Карточка активации устройства (страница /system). Отдельным компонентом, потому что
	// то же состояние показывает баннер в шапке — логика живёт в сторе, здесь только вид.
	import { license, activate, loadLicense } from '$lib/stores/license.svelte';
	import { t } from '$lib/i18n/index.svelte';

	let promo = $state('');

	// Текст ошибки сервера/устройства: коды приходят от API (Invalid promo code и т.п.) и от
	// стора (device_rejected/no_mac/...). Знакомые переводим, незнакомые показываем как есть —
	// сырой код всё равно полезнее «что-то пошло не так» при обращении в поддержку.
	type TKey = Parameters<typeof t>[0];
	const errorKeys: Record<string, TKey> = {
		bad_key: 'lic.errBadKey',
		device_rejected: 'lic.errDeviceRejected',
		ble_write_failed: 'lic.errBleWrite',
		no_mac: 'lic.errNoMac',
		'Invalid promo code': 'lic.errPromoInvalid',
		'Promo code expired': 'lic.errPromoUsed',
		'Promo code or payment required': 'lic.errPromoRequired',
		'Invalid MAC format': 'lic.errMac',
		'Failed to fetch': 'lic.errNetwork'
	};
	function errorText(code: string): string {
		const key = errorKeys[code];
		return key ? t(key) : code;
	}

	function stepText(): string {
		switch (license.step) {
			case 'reading': return t('lic.stepReading');
			case 'server': return t('lic.stepServer');
			case 'writing': return t('lic.stepWriting');
			case 'verifying': return t('lic.stepVerifying');
			default: return '';
		}
	}

	async function copyMac() {
		try { await navigator.clipboard.writeText(license.mac); } catch { /* нет доступа к буферу */ }
	}
</script>

<div class="p-3 rounded-lg bg-[var(--color-dash-card)] border {license.loaded && !license.licensed
		? 'border-[var(--color-dash-danger)]/40'
		: 'border-[var(--color-dash-border)]/50'}">
	<div class="flex items-center justify-between mb-2">
		<span class="text-xs text-[var(--color-dash-text-dim)] uppercase tracking-wider">{t('lic.title')}</span>
		<button onclick={() => loadLicense()}
			class="text-[10px] text-[var(--color-dash-text-dim)] hover:text-[var(--color-dash-accent)] transition-colors">
			{t('lic.refresh')}
		</button>
	</div>

	{#if !license.loaded}
		<div class="text-xs text-[var(--color-dash-text-dim)]">{t('lic.unknown')}</div>
	{:else}
		<!-- Статус -->
		<div class="flex items-center gap-2 mb-2">
			<span class="w-2 h-2 rounded-full {license.licensed
				? 'bg-[var(--color-dash-success)]'
				: license.boostAllowed ? 'bg-[var(--color-dash-warn)]' : 'bg-[var(--color-dash-danger)]'}"></span>
			<span class="text-sm font-bold {license.licensed
				? 'text-[var(--color-dash-success)]'
				: license.boostAllowed ? 'text-[var(--color-dash-warn)]' : 'text-[var(--color-dash-danger)]'}">
				{license.licensed ? t('lic.active') : license.boostAllowed ? t('lic.trial', String(license.trialLeft)) : t('lic.inactive')}
			</span>
		</div>

		{#if !license.licensed}
			<p class="text-[10px] text-[var(--color-dash-text-dim)] mb-3">{t('lic.hint', String(license.trialSec))}</p>
		{/if}

		<!-- MAC устройства: по нему выдаётся ключ -->
		<div class="mb-3">
			<div class="text-[9px] text-[var(--color-dash-text-dim)] uppercase mb-1">{t('lic.mac')}</div>
			<div class="flex items-center gap-2">
				<code class="flex-1 px-2 py-1.5 rounded bg-[var(--color-dash-bg)] border border-[var(--color-dash-border)]
					text-xs font-mono text-[var(--color-dash-text)] select-text break-all">{license.mac || '—'}</code>
				<button onclick={copyMac} disabled={!license.mac}
					class="px-2.5 py-1.5 rounded text-[10px] font-bold bg-[var(--color-dash-border)]/60 text-[var(--color-dash-text)]
						hover:bg-[var(--color-dash-border)] transition-colors disabled:opacity-40">
					{t('lic.copy')}
				</button>
			</div>
		</div>

		{#if license.licensed}
			<!-- Ключ отдаётся только активированным — доказательство владения для поддержки -->
			{#if license.key}
				<div class="mb-1">
					<div class="text-[9px] text-[var(--color-dash-text-dim)] uppercase mb-1">{t('lic.key')}</div>
					<code class="block px-2 py-1.5 rounded bg-[var(--color-dash-bg)] border border-[var(--color-dash-border)]
						text-[10px] font-mono text-[var(--color-dash-text-dim)] select-text break-all">{license.key}</code>
				</div>
			{/if}
			{#if license.justActivated}
				<div class="text-xs text-[var(--color-dash-success)] font-bold mt-2">{t('lic.done')}</div>
			{/if}
		{:else}
			<!-- Промокод → сервер выдаёт ключ → пишем в устройство -->
			<div class="text-[9px] text-[var(--color-dash-text-dim)] uppercase mb-1">{t('lic.promo')}</div>
			<div class="flex items-center gap-2 mb-2">
				<input type="text" bind:value={promo} maxlength="32" placeholder="XXXX-XXXX" spellcheck="false"
					class="flex-1 px-2 py-1.5 rounded bg-[var(--color-dash-bg)] border border-[var(--color-dash-border)]
						text-xs text-[var(--color-dash-text)] font-mono uppercase outline-none
						focus:border-[var(--color-dash-accent)] transition-colors" />
				<button onclick={() => activate(promo)} disabled={license.busy || !promo.trim()}
					class="px-3 py-1.5 rounded text-[10px] font-bold bg-[var(--color-dash-accent)]/15 text-[var(--color-dash-accent)]
						border border-[var(--color-dash-accent)]/25 hover:bg-[var(--color-dash-accent)]/25 transition-colors
						disabled:opacity-40 disabled:cursor-not-allowed">
					{license.busy ? t('lic.working') : t('lic.activate')}
				</button>
			</div>

			<!-- Повторная активация: MAC уже оплачен (перепрошивка, сброс NVS) — ключ выдаётся без промокода -->
			<button onclick={() => activate()} disabled={license.busy}
				class="w-full py-1.5 rounded text-[10px] font-bold bg-[var(--color-dash-border)]/50 text-[var(--color-dash-text-dim)]
					hover:bg-[var(--color-dash-border)] transition-colors disabled:opacity-40">
				{t('lic.restore')}
			</button>

			{#if license.busy && stepText()}
				<div class="text-[10px] text-[var(--color-dash-warn)] mt-2">{stepText()}</div>
			{:else if license.error}
				<div class="text-[10px] text-[var(--color-dash-danger)] mt-2 break-words">{errorText(license.error)}</div>
			{/if}

			<p class="text-[10px] text-[var(--color-dash-text-dim)] mt-2">{t('lic.buyHint')}</p>
		{/if}
	{/if}
</div>
