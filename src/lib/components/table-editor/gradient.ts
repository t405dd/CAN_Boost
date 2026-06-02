// Gradient color calculation for table cells with neighbor smoothing

/** Compute smoothed value by averaging with 4 neighbors */
export function smoothedValue(
	data: number[][],
	row: number,
	col: number,
	numRows: number,
	numCols: number,
	neighborWeight: number = 0.4
): number {
	const centerVal = data[row][col];
	let neighborSum = 0;
	let neighborCount = 0;

	if (row > 0) { neighborSum += data[row - 1][col]; neighborCount++; }
	if (row < numRows - 1) { neighborSum += data[row + 1][col]; neighborCount++; }
	if (col > 0) { neighborSum += data[row][col - 1]; neighborCount++; }
	if (col < numCols - 1) { neighborSum += data[row][col + 1]; neighborCount++; }

	if (neighborCount === 0) return centerVal;
	const neighborAvg = neighborSum / neighborCount;
	return centerVal * (1 - neighborWeight) + neighborAvg * neighborWeight;
}

/** Interpolate color from blue (cold) -> white (mid) -> red (hot) */
export function gradientColor(value: number, min: number, max: number): string {
	if (max <= min) return 'transparent';
	const t = Math.max(0, Math.min(1, (value - min) / (max - min)));

	let r: number, g: number, b: number;
	if (t < 0.5) {
		// Blue -> White
		const s = t * 2;
		r = Math.round(40 + s * 215);
		g = Math.round(60 + s * 195);
		b = Math.round(220 + s * 35);
	} else {
		// White -> Red
		const s = (t - 0.5) * 2;
		r = Math.round(255);
		g = Math.round(255 - s * 200);
		b = Math.round(255 - s * 210);
	}
	return `rgb(${r},${g},${b})`;
}

/** Text color: dark for light backgrounds, light for dark backgrounds */
export function gradientTextColor(value: number, min: number, max: number): string {
	if (max <= min) return 'inherit';
	const t = Math.max(0, Math.min(1, (value - min) / (max - min)));
	return (t > 0.2 && t < 0.8) ? '#1a1a2e' : '#e0e0e0';
}
