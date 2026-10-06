/**
 * What vt420-term and vt420-native-host say over the socket: messages of a type byte, a length and the bytes.
 *
 *   to the host     h hello {columns, rows, term} as JSON, i input, r resize "columns,rows", p pause, u resume
 *   to vt420-term   d the program's output, x it exited, with its code
 */

import type { Socket } from "node:net";

export interface Message {
	type: string;
	data: Buffer;
}

export function send(socket: Socket, type: string, data: Buffer | string = Buffer.alloc(0)): void {
	const payload = typeof data === "string" ? Buffer.from(data, "latin1") : data;
	const header = Buffer.alloc(5);
	header[0] = type.charCodeAt(0);
	header.writeUInt32BE(payload.length, 1);
	socket.write(Buffer.concat([header, payload]));
}

/** Messages out of a stream of chunks. */
export class Frames {
	private buffer: Buffer = Buffer.alloc(0);
	private readonly handle: (message: Message) => void;

	constructor(handle: (message: Message) => void) {
		this.handle = handle;
	}

	push(chunk: Buffer): void {
		this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
		while (this.buffer.length >= 5) {
			const length = this.buffer.readUInt32BE(1);
			if (this.buffer.length < 5 + length) return;
			const message = { type: String.fromCharCode(this.buffer[0]!), data: this.buffer.subarray(5, 5 + length) };
			this.buffer = this.buffer.subarray(5 + length);
			this.handle(message);
		}
	}
}

/** Where a zellij session's native session listens: a directory only this user can enter. */
export function socketPath(runtimeDir: string, uid: number, session: string): string {
	return `${runtimeDir}/vt420-native-${uid}/${encodeURIComponent(session)}.sock`;
}
