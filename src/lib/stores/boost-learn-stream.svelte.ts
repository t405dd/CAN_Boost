// Shared boost learn-delta stream (Svelte 5 runes).
//
// Firmware streams self-learning corrections (changed cells of Ki/Kp/Kd/BIAS tables)
// over CHR_BOOST_LEARN_DELTA as a binary packet: [count:u8] + count×{tableId:u8,row:u8,col:u8,value:f32 LE}.
//
// Multiple consumers need these deltas at once (the Boost page mutates the open tables
// for the live highlight; the logger records every correction with a timestamp regardless
// of which page is open). A single ref-counted subscription fans out to all of them — so
// one consumer unsubscribing never calls stopNotifications() out from under another.

import { SVC_BOOST, CHR_BOOST_LEARN_DELTA } from '$lib/ble/uuids';
import { subscribeCharacteristic } from '$lib/ble/connection';
import { bleState } from './ble-connection.svelte';

// tableId mapping mirrors BOOST_LEARN_ID_* in firmware (boost_controller.cpp).
export interface LearnDelta {
	tableId: number; // 0=Ki, 1=Kp, 2=Kd, 3=BIAS
	row: number;
	col: number;
	value: number;
}

type Listener = (deltas: LearnDelta[]) => void;

const listeners = new Set<Listener>();
let unsub: (() => void) | null = null;
let subscribing = false;

function parsePacket(view: DataView): LearnDelta[] {
	const out: LearnDelta[] = [];
	if (view.byteLength < 1) return out;
	const count = view.getUint8(0);
	let off = 1;
	for (let i = 0; i < count && off + 7 <= view.byteLength; i++) {
		out.push({
			tableId: view.getUint8(off),
			row: view.getUint8(off + 1),
			col: view.getUint8(off + 2),
			value: view.getFloat32(off + 3, true) // LE, mirrors buildBoostLearnDeltaPacket
		});
		off += 7;
	}
	return out;
}

async function ensureSubscribed(): Promise<void> {
	if (unsub || subscribing) return;
	if (listeners.size === 0) return;
	if (bleState.status !== 'connected') return; // (re)subscribe later via the connect effect
	subscribing = true;
	try {
		unsub = await subscribeCharacteristic(SVC_BOOST, CHR_BOOST_LEARN_DELTA, (view) => {
			const deltas = parsePacket(view);
			if (deltas.length === 0) return;
			for (const l of listeners) {
				try {
					l(deltas);
				} catch {
					/* a misbehaving listener must not break the others */
				}
			}
		});
	} finally {
		subscribing = false;
	}
}

/** Register a consumer of learn deltas. Returns an unsubscribe fn. Ref-counted:
 *  the underlying GATT subscription starts on the first listener and stops on the last. */
export function onLearnDelta(cb: Listener): () => void {
	listeners.add(cb);
	void ensureSubscribed();
	return () => {
		listeners.delete(cb);
		if (listeners.size === 0 && unsub) {
			unsub();
			unsub = null;
		}
	};
}

// (Re)subscribe whenever a connection is (re)established; drop the stale handle on disconnect
// (the characteristic object is invalid after a GATT drop — re-subscribe gets a fresh one).
if (typeof window !== 'undefined') {
	$effect.root(() => {
		$effect(() => {
			if (bleState.status === 'connected') {
				void ensureSubscribed();
			} else {
				unsub = null;
			}
		});
	});
}
