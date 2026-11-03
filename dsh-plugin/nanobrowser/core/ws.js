// A small RFC 6455 server connection. It handles the handshake, a single text message at a time (with continuation
// frames), ping/pong and close. The chat protocol is JSON text; binary frames are ignored. Bounded to 1 MiB because
// the only client is the local side panel.

import { createHash } from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_FRAME = 1_000_000;

export class WsConnection {
  constructor(socket, req, handlers = {}, head) {
    this.socket = socket;
    this.handlers = handlers;
    this.closed = false;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentOpcode = 0;
    const key = req.headers['sec-websocket-key'];
    if (!key) {
      socket.destroy();
      this.closed = true;
      return;
    }
    const accept = createHash('sha1').update(`${key}${GUID}`).digest('base64');
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    socket.setNoDelay?.(true);
    socket.on('data', chunk => this.#onData(chunk));
    socket.on('close', () => this.#closed());
    socket.on('error', () => this.#closed());
    if (head?.length) this.#onData(head);
  }

  send(text) {
    this.#sendFrame(0x1, Buffer.from(String(text), 'utf8'));
  }

  sendJson(value) {
    this.send(JSON.stringify(value));
  }

  close(code = 1000) {
    if (this.closed) return;
    const payload = Buffer.alloc(2);
    payload.writeUInt16BE(code, 0);
    this.#sendFrame(0x8, payload);
    this.closed = true;
    try {
      this.socket.end();
    } catch {
      /* already gone */
    }
    this.handlers.onClose?.();
  }

  #closed() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.socket.destroy();
    } catch {
      /* already gone */
    }
    this.handlers.onClose?.();
  }

  #onData(chunk) {
    if (this.closed) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const frame = this.#parseFrame();
      if (!frame) return;
      this.#handleFrame(frame);
      if (this.closed) return;
    }
  }

  #parseFrame() {
    if (this.buffer.length < 2) return null;
    const first = this.buffer[0];
    const second = this.buffer[1];
    const fin = (first & 0x80) !== 0;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (this.buffer.length < 4) return null;
      length = this.buffer.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (this.buffer.length < 10) return null;
      const large = this.buffer.readBigUInt64BE(2);
      if (large > BigInt(MAX_FRAME)) {
        this.close(1009);
        return null;
      }
      length = Number(large);
      offset = 10;
    }
    if (length > MAX_FRAME) {
      this.close(1009);
      return null;
    }
    if (!masked) {
      this.close(1002);
      return null;
    }
    if (this.buffer.length < offset + 4 + length) return null;
    const mask = this.buffer.subarray(offset, offset + 4);
    offset += 4;
    const payload = Buffer.alloc(length);
    for (let index = 0; index < length; index += 1) payload[index] = this.buffer[offset + index] ^ mask[index & 3];
    this.buffer = this.buffer.subarray(offset + length);
    return { fin, opcode, payload };
  }

  #handleFrame(frame) {
    if (this.closed) return;
    const { fin, opcode, payload } = frame;
    if (opcode === 0x8) {
      this.close();
      return;
    }
    if (opcode === 0x9) {
      this.#sendFrame(0xa, payload);
      return;
    }
    if (opcode === 0xa) return;
    if (opcode === 0x1 || opcode === 0x2 || opcode === 0x0) {
      if (opcode !== 0x0) {
        this.fragmentOpcode = opcode;
        this.fragments = [];
      }
      this.fragments.push(payload);
      if (!fin) return;
      const data = Buffer.concat(this.fragments);
      this.fragments = [];
      if (this.fragmentOpcode === 0x1) this.handlers.onMessage?.(data.toString('utf8'));
      return;
    }
    this.close(1002);
  }

  #sendFrame(opcode, payload) {
    if (this.socket.destroyed) return;
    const length = payload.length;
    let header;
    if (length < 126) {
      header = Buffer.from([0x80 | opcode, length]);
    } else if (length < 65_536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(length), 2);
    }
    try {
      this.socket.write(Buffer.concat([header, payload]));
    } catch {
      this.#closed();
    }
  }
}
