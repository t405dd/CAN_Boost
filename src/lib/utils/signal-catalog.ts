// Predefined CAN signal catalog (static/predefined_signals.json).
// A library of known signals with full decode parameters, used to add received
// signals by picking from a list instead of typing every field by hand.

import { base } from '$app/paths';
import type { CanSignalDataType } from '$lib/types/config';

export interface PredefinedSignal {
	internalId: string;
	pdfName?: string;
	friendlyName: string;
	groupName: string;
	pdfFunction?: string;
	unit: string;
	defaultCanId: number;
	defaultIsExtendedId: boolean;
	startByte: number;
	lengthBytes: number;
	dataType: CanSignalDataType;
	isBigEndian: boolean;
	multiplier: number;
	divider: number;
	offset: number;
	requiresFtoC: boolean;
	requiresVssProcessing: boolean;
	defaultTargetParam?: number;
}

let _cache: PredefinedSignal[] | null = null;

/** Load the predefined signal catalog (cached after first fetch). */
export async function loadSignalCatalog(): Promise<PredefinedSignal[]> {
	if (_cache) return _cache;
	const res = await fetch(`${base}/predefined_signals.json`);
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	_cache = (await res.json()) as PredefinedSignal[];
	return _cache;
}

/** Numeric sort key for group ordering: "Simplified Dash" first, then
 *  "Advanced RT Data (Group N)" by N ascending, everything else after. */
export function groupSortKey(groupName: string): number {
	const g = groupName.trim();
	if (g.toLowerCase().startsWith('simplified')) return -1;
	const m = g.match(/Group\s+(\d+)/i);
	return m ? parseInt(m[1], 10) : 100000;
}
