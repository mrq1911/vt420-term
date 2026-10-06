/**
 * The bell and the keyclick, made rather than recorded.
 */

export class Sound {
	private context: AudioContext | undefined;
	private lastBell = 0;

	/** Browsers allow sound only after the user did something on the page. */
	private audio(): AudioContext | undefined {
		try {
			this.context ??= new AudioContext();
			if (this.context.state === "suspended") void this.context.resume();
			return this.context;
		} catch {
			return undefined;
		}
	}

	/** A short tone near 800 Hz; bells that come too fast ring once. */
	bell(): void {
		const now = performance.now();
		if (now - this.lastBell < 150) return;
		this.lastBell = now;
		const audio = this.audio();
		if (!audio) return;
		const oscillator = audio.createOscillator();
		const gain = audio.createGain();
		oscillator.type = "square";
		oscillator.frequency.value = 784;
		gain.gain.setValueAtTime(0.06, audio.currentTime);
		gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.18);
		oscillator.connect(gain).connect(audio.destination);
		oscillator.start();
		oscillator.stop(audio.currentTime + 0.2);
	}

	/** A tick of noise, as the LK401's keys make. */
	click(): void {
		const audio = this.audio();
		if (!audio) return;
		const length = Math.floor(audio.sampleRate * 0.006);
		const buffer = audio.createBuffer(1, length, audio.sampleRate);
		const data = buffer.getChannelData(0);
		for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 2;
		const source = audio.createBufferSource();
		const gain = audio.createGain();
		gain.gain.value = 0.25;
		source.buffer = buffer;
		source.connect(gain).connect(audio.destination);
		source.start();
	}
}
