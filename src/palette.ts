/**
 * Colours for a monochrome terminal. A VT420 has bold, underline, blink and reverse video and nothing else, so each
 * colour a program uses is judged by how it looks: a light or vivid background becomes reverse video, a vivid
 * foreground becomes bold, and greys and whites stay as they are. With zellij's default theme the active tab is
 * inverted while inactive tabs and the bar stay plain, and the focused pane's frame is bold.
 */

export type Rgb = readonly [number, number, number];

const CUBE = [0, 95, 135, 175, 215, 255];
const BASIC: readonly Rgb[] = [
	[0, 0, 0],
	[205, 0, 0],
	[0, 205, 0],
	[205, 205, 0],
	[0, 0, 238],
	[205, 0, 205],
	[0, 205, 205],
	[229, 229, 229],
	[127, 127, 127],
	[255, 0, 0],
	[0, 255, 0],
	[255, 255, 0],
	[92, 92, 255],
	[255, 0, 255],
	[0, 255, 255],
	[255, 255, 255],
];

/** What a program means by the default foreground and background: light text on a dark screen. */
export const DEFAULT_FOREGROUND: Rgb = [229, 229, 229];
export const DEFAULT_BACKGROUND: Rgb = [0, 0, 0];

/** xterm's 256-colour palette. */
export function paletteRgb(index: number): Rgb {
	if (index < 16) return BASIC[index] ?? DEFAULT_BACKGROUND;
	if (index < 232) {
		const value = index - 16;
		return [CUBE[Math.floor(value / 36)]!, CUBE[Math.floor(value / 6) % 6]!, CUBE[value % 6]!];
	}
	const grey = 8 + (index - 232) * 10;
	return [grey, grey, grey];
}

export function unpackRgb(packed: number): Rgb {
	return [(packed >> 16) & 0xff, (packed >> 8) & 0xff, packed & 0xff];
}

function measure([red, green, blue]: Rgb): { luminance: number; saturation: number } {
	const max = Math.max(red, green, blue);
	const min = Math.min(red, green, blue);
	return {
		luminance: (0.299 * red + 0.587 * green + 0.114 * blue) / 255,
		saturation: max === 0 ? 0 : (max - min) / max,
	};
}

/** A background that reads as lit: light, or a vivid colour of middling brightness. Mid greys do not count. */
export function isLight(rgb: Rgb): boolean {
	const { luminance, saturation } = measure(rgb);
	return luminance >= 0.6 || (saturation >= 0.5 && luminance >= 0.4);
}

/** A foreground that stands out from plain text: a vivid colour that is not nearly black. */
export function isAccent(rgb: Rgb): boolean {
	const { luminance, saturation } = measure(rgb);
	return saturation >= 0.5 && luminance >= 0.08;
}
