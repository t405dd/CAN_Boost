// Resize helpers for boost config tables (1D / 2D).
// A table with numRows === 1 is 1D (X axis only); numRows >= 2 is 2D (bilinear).
// Firmware caps both dimensions at MAX_CAN_OUT_TABLE_{ROWS,COLS} = 16.

export interface ResizableTable {
	numCols: number;
	numRows: number;
	xAxisValues: number[];
	yAxisValues: number[];
	data: number[][];
}

/** Grow or shrink an axis to `n` points. New points continue the existing
 *  step (last delta), falling back to `fallbackStep` when it can't be inferred. */
export function resizeAxis(axis: number[], n: number, fallbackStep = 10): number[] {
	if (n <= 0) return [];
	if (n <= axis.length) return axis.slice(0, n);
	const out = axis.slice();
	while (out.length < n) {
		const len = out.length;
		if (len === 0) { out.push(0); continue; }
		const step = len >= 2 ? out[len - 1] - out[len - 2] : fallbackStep;
		out.push(out[len - 1] + (step > 0 ? step : fallbackStep));
	}
	return out;
}

/** Return a new table resized to `rows` × `cols`. Existing cells are kept;
 *  cells added by growth replicate the nearest edge value (so a tuned table
 *  isn't polluted with constants), falling back to `fill` for an empty table.
 *  yAxisValues is only meaningful in 2D (rows >= 2). */
export function resizeTable<T extends ResizableTable>(t: T, rows: number, cols: number, fill: number): T {
	const numRows = Math.max(1, Math.floor(rows));
	const numCols = Math.max(1, Math.floor(cols));
	// Оси могут отсутствовать: firmware для 1D deltaMap не шлёт yAxisValues → было undefined.slice() и
	// тихий обрыв ресайза. Подстраховываемся `?? []` по обеим осям.
	const xAxisValues = resizeAxis(t.xAxisValues ?? [], numCols);
	const yAxisValues = numRows > 1 ? resizeAxis(t.yAxisValues ?? [], numRows) : (t.yAxisValues ?? []).slice(0, numRows);

	const srcRows = t.data.length;
	const data: number[][] = [];
	for (let r = 0; r < numRows; r++) {
		const srcRow = t.data[Math.min(r, srcRows - 1)] ?? [];
		const row: number[] = [];
		for (let c = 0; c < numCols; c++) {
			const exact = t.data[r]?.[c];
			row.push(exact ?? srcRow[Math.min(c, srcRow.length - 1)] ?? fill);
		}
		data.push(row);
	}

	return { ...t, numCols, numRows, xAxisValues, yAxisValues, data };
}
