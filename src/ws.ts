/**
 * Just enough of a WebSocket server (RFC 6455) for one page on this machine: the handshake, frames in both
 * directions, ping and close. Fragmented messages are joined; extensions are not offered.
 */

import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
/** A message larger than this closes the connection: the page sends keys and small requests. */
const MAX_MESSAGE = 4 * 1024 * 1024;

export interface WebSocketHandlers {
	text?: (text: string) => void;
	binary?: (data: Buffer) => void;
	close?: () => void;
}

export class WebSocket {
	private readonly socket: Duplex;
	private handlers: WebSocketHandlers = {};
	private buffer: Buffer = Buffer.alloc(0);
	private fragments: Buffer[] = [];
	private fragmentOpcode = 0;
	private closed = false;

	constructor(socket: Duplex) {
		this.socket = socket;
		socket.on("data", (chunk: Buffer) => this.receive(chunk));
		socket.on("close", () => this.finish());
		socket.on("error", () => this.finish());
	}

	/** Answer an upgrade request; undefined (and the socket refused) when it is not a WebSocket handshake. */
	static accept(request: IncomingMessage, socket: Duplex): WebSocket | undefined {
		const key = request.headers["sec-websocket-key"];
		if (typeof key !== "string" || request.headers.upgrade?.toLowerCase() !== "websocket") {
			socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
			return undefined;
		}
		const accept = createHash("sha1")
			.update(key + GUID)
			.digest("base64");
		socket.write(
			`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
		);
		return new WebSocket(socket);
	}

	on(handlers: WebSocketHandlers): void {
		this.handlers = handlers;
	}

	get open(): boolean {
		return !this.closed;
	}

	sendText(text: string): void {
		this.send(0x1, Buffer.from(text, "utf8"));
	}

	sendBinary(data: Uint8Array): void {
		this.send(0x2, Buffer.from(data.buffer, data.byteOffset, data.byteLength));
	}

	close(): void {
		if (this.closed) return;
		this.send(0x8, Buffer.alloc(0));
		this.socket.end();
		this.finish();
	}

	private send(opcode: number, payload: Buffer): void {
		if (this.closed) return;
		const length = payload.length;
		const header = length < 126 ? Buffer.alloc(2) : length < 0x10000 ? Buffer.alloc(4) : Buffer.alloc(10);
		header[0] = 0x80 | opcode;
		if (length < 126) header[1] = length;
		else if (length < 0x10000) {
			header[1] = 126;
			header.writeUInt16BE(length, 2);
		} else {
			header[1] = 127;
			header.writeBigUInt64BE(BigInt(length), 2);
		}
		this.socket.write(Buffer.concat([header, payload]));
	}

	private receive(chunk: Buffer): void {
		this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
		while (!this.closed) {
			const frame = this.frame();
			if (!frame) return;
			this.handle(frame.fin, frame.opcode, frame.payload);
		}
	}

	/** The next whole frame in the buffer, unmasked, or undefined until it has all arrived. */
	private frame(): { fin: boolean; opcode: number; payload: Buffer } | undefined {
		const buffer = this.buffer;
		if (buffer.length < 2) return undefined;
		const fin = (buffer[0]! & 0x80) !== 0;
		const opcode = buffer[0]! & 0x0f;
		const masked = (buffer[1]! & 0x80) !== 0;
		let length = buffer[1]! & 0x7f;
		let at = 2;
		if (length === 126) {
			if (buffer.length < 4) return undefined;
			length = buffer.readUInt16BE(2);
			at = 4;
		} else if (length === 127) {
			if (buffer.length < 10) return undefined;
			const long = buffer.readBigUInt64BE(2);
			if (long > BigInt(MAX_MESSAGE)) {
				this.close();
				return undefined;
			}
			length = Number(long);
			at = 10;
		}
		// a client masks every frame
		if (!masked) {
			this.close();
			return undefined;
		}
		if (buffer.length < at + 4 + length) return undefined;
		const mask = buffer.subarray(at, at + 4);
		const payload = Buffer.from(buffer.subarray(at + 4, at + 4 + length));
		for (let i = 0; i < payload.length; i++) payload[i]! ^= mask[i & 3]!;
		this.buffer = buffer.subarray(at + 4 + length);
		return { fin, opcode, payload };
	}

	private handle(fin: boolean, opcode: number, payload: Buffer): void {
		if (opcode === 0x8) {
			this.close();
			return;
		}
		if (opcode === 0x9) {
			this.send(0xa, payload);
			return;
		}
		if (opcode === 0xa) return;
		if (opcode === 0x0) {
			this.fragments.push(payload);
		} else {
			this.fragmentOpcode = opcode;
			this.fragments = [payload];
		}
		if (this.fragments.reduce((total, part) => total + part.length, 0) > MAX_MESSAGE) {
			this.close();
			return;
		}
		if (!fin) return;
		const message = Buffer.concat(this.fragments);
		this.fragments = [];
		if (this.fragmentOpcode === 0x1) this.handlers.text?.(message.toString("utf8"));
		else if (this.fragmentOpcode === 0x2) this.handlers.binary?.(message);
	}

	private finish(): void {
		if (this.closed) return;
		this.closed = true;
		this.handlers.close?.();
	}
}
