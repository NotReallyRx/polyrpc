const GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json';
const MAX_FIELD_LENGTH = 128;
const MAX_TOKEN_LENGTH = 512;
const MAX_ATTEMPTS = 5;
const CONNECT_TIMEOUT = 20000;
const DEFAULT_APP_ID = '1563193636215193632';

function field(value, fallback = '') {
  if (typeof value !== 'string') return fallback;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return (cleaned || fallback).slice(0, MAX_FIELD_LENGTH);
}

function normalizeToken(value) {
  if (typeof value !== 'string') {
    throw new TypeError('id must be a Discord user token string.');
  }

  const token = value.trim();
  if (!token) throw new TypeError('id is required.');
  if (token.length > MAX_TOKEN_LENGTH) throw new RangeError('id is too long.');
  if (/\s/.test(token)) throw new TypeError('id must not contain whitespace.');

  return token;
}

function getWebSocket() {
  if (typeof globalThis.WebSocket === 'function') {
    return globalThis.WebSocket;
  }

  throw new Error('WebSocket is unavailable. Use a browser or Node 22+.');
}

function platformName() {
  if (globalThis.process?.versions?.node) return globalThis.process.platform || 'unknown';
  if (typeof navigator !== 'undefined') return navigator.platform || 'browser';
  return 'unknown';
}

class RpcSession {
  #WebSocket;
  #token;
  #client;
  #state;
  #version;
  #largeImage;
  #socket = null;
  #heartbeat = null;
  #heartbeatStart = null;
  #connectTimeout = null;
  #interval = null;
  #seq = null;
  #acked = true;
  #attempts = 0;
  #ready = false;
  #closed = false;
  #startedAt = Date.now();
  #onStatus;
  #onAccount;
  #user = null;
  #resolveReady = null;
  #rejectReady = null;

  constructor({ WebSocket, token, client, state, version, largeImage, onStatus, onAccount }) {
    this.#WebSocket = WebSocket;
    this.#token = token;
    this.#client = client;
    this.#state = state;
    this.#version = version;
    this.#largeImage = largeImage;
    this.#onStatus = typeof onStatus === 'function' ? onStatus : () => {};
    this.#onAccount = typeof onAccount === 'function' ? onAccount : () => {};
  }

  get connected() {
    return this.#ready;
  }

  get user() {
    return this.#user;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.#resolveReady = resolve;
      this.#rejectReady = reject;
      this.#connect();
    });
  }

  update(next = {}) {
    if (this.#closed) throw new Error('RPC session is closed.');

    if (next.client !== undefined) this.#client = field(next.client, 'PolyRPC');
    if (next.state !== undefined) this.#state = field(next.state);
    if (next.version !== undefined) this.#version = field(next.version);
    if (next.largeImage !== undefined) this.#largeImage = next.largeImage;

    if (this.#ready) this.#sendPresence();
  }

  close() {
    if (this.#closed) return;

    const reject = this.#rejectReady;
    this.#resolveReady = null;
    this.#rejectReady = null;
    reject?.(new Error('RPC session closed before it became ready.'));
    this.#status('closed');
    this.#shutdown();
  }

  #connect() {
    if (this.#closed) return;

    this.#status('connecting');

    let socket;
    try {
      socket = new this.#WebSocket(GATEWAY_URL);
    } catch (error) {
      this.#fail(error instanceof Error ? error.message : 'Could not open the Discord gateway.');
      return;
    }

    this.#socket = socket;

    socket.addEventListener('message', (event) => this.#handleMessage(event.data));
    socket.addEventListener('close', (event) => this.#handleClose(event.code));
    socket.addEventListener('error', () => {
      if (!this.#closed) this.#status('error', 'Gateway connection failed.');
    });

    if (typeof socket.on === 'function') {
      socket.on('unexpected-response', (_request, response) => {
        this.#fail(`Discord rejected the gateway connection (HTTP ${response.statusCode}).`);
      });
    }

    this.#connectTimeout = setTimeout(() => {
      if (!this.#ready && !this.#closed) {
        this.#fail('Timed out connecting to the Discord gateway.');
      }
    }, CONNECT_TIMEOUT);
  }

  #handleMessage(raw) {
    if (this.#closed) return;

    let data = raw;
    if (data && typeof data === 'object' && 'data' in data) data = data.data;

    let text;
    if (typeof data === 'string') {
      text = data;
    } else if (data instanceof ArrayBuffer) {
      text = new TextDecoder().decode(new Uint8Array(data));
    } else if (ArrayBuffer.isView(data)) {
      text = new TextDecoder().decode(data);
    } else {
      text = String(data);
    }

    let packet;
    try {
      packet = JSON.parse(text);
    } catch {
      return;
    }

    if (typeof packet.s === 'number') this.#seq = packet.s;

    switch (packet.op) {
      case 0:
        if (packet.t === 'READY') this.#handleReady(packet.d);
        break;
      case 1:
        this.#sendHeartbeat();
        break;
      case 7:
        this.#reconnect();
        break;
      case 9:
        this.#fail('Discord rejected the session. Check the token.');
        break;
      case 10:
        this.#interval = packet.d.heartbeat_interval;
        this.#startHeartbeat();
        this.#identify();
        break;
      case 11:
        this.#acked = true;
        break;
      default:
        break;
    }
  }

  #handleReady(data) {
    clearTimeout(this.#connectTimeout);
    this.#connectTimeout = null;
    this.#ready = true;
    this.#attempts = 0;
    this.#user = data?.user || null;

    this.#onAccount(this.#user);
    this.#sendPresence();

    const resolve = this.#resolveReady;
    this.#resolveReady = null;
    this.#rejectReady = null;
    resolve?.();
    this.#status('connected');
  }

  #identify() {
    this.#send({
      op: 2,
      d: {
        token: this.#token,
        capabilities: 125,
        properties: {
          os: platformName(),
          browser: 'polyrpc',
          device: 'polyrpc',
        },
        presence: this.#presencePayload(),
        compress: false,
      },
    });
  }

  #presencePayload() {
    const name = field(this.#client, 'PolyRPC');
    const details = field(this.#state);
    const state = field(this.#version);
    const largeImage = this.#largeImage || 'logo';

    const activity = {
      name,
      type: 0,
      details: details || undefined,
      state: state || undefined,
      assets: {
        large_image: largeImage,
        large_text: name,
      },
      application_id: DEFAULT_APP_ID,
      timestamps: { start: this.#startedAt },
    };

    return {
      since: 0,
      activities: [activity],
      status: 'online',
      afk: false,
    };
  }

  #sendPresence() {
    this.#send({ op: 3, d: this.#presencePayload() });
  }

  #startHeartbeat() {
    clearInterval(this.#heartbeat);
    clearTimeout(this.#heartbeatStart);
    this.#acked = true;

    const jitter = Math.floor(Math.random() * this.#interval);
    this.#heartbeatStart = setTimeout(() => {
      if (this.#closed) return;
      this.#sendHeartbeat();
      this.#heartbeat = setInterval(() => this.#sendHeartbeat(), this.#interval);
    }, jitter);
  }

  #sendHeartbeat() {
    if (this.#closed) return;

    if (!this.#acked) {
      this.#reconnect();
      return;
    }

    this.#acked = false;
    this.#send({ op: 1, d: this.#seq });
  }

  #send(payload) {
    if (this.#socket && this.#socket.readyState === 1) {
      this.#socket.send(JSON.stringify(payload));
    }
  }

  #reconnect() {
    if (this.#closed) return;
    this.#ready = false;
    try {
      this.#socket?.close();
    } catch {
      this.#handleClose(1006);
    }
  }

  #handleClose(code) {
    this.#clearTimers();
    this.#ready = false;

    if (this.#closed) return;

    if (code === 4003 || code === 4004) {
      this.#fail('Discord rejected the token.');
      return;
    }

    if (code === 4013 || code === 4014) {
      this.#fail(`Discord closed the gateway connection (${code}).`);
      return;
    }

    if (this.#attempts >= MAX_ATTEMPTS) {
      this.#fail('Lost the connection to Discord.');
      return;
    }

    this.#attempts += 1;
    const delay = Math.min(30000, 1500 * 2 ** (this.#attempts - 1));
    this.#status('connecting', `Reconnecting (attempt ${this.#attempts}).`);
    setTimeout(() => this.#connect(), delay);
  }

  #fail(message) {
    if (this.#closed) return;

    const error = message instanceof Error ? message : new Error(message);
    const reject = this.#rejectReady;
    this.#resolveReady = null;
    this.#rejectReady = null;
    reject?.(error);
    this.#status('error', error.message);
    this.#shutdown();
  }

  #status(status, error = null) {
    this.#onStatus(status, error);
  }

  #clearTimers() {
    clearInterval(this.#heartbeat);
    clearTimeout(this.#heartbeatStart);
    clearTimeout(this.#connectTimeout);
    this.#heartbeat = null;
    this.#heartbeatStart = null;
    this.#connectTimeout = null;
  }

  #shutdown() {
    this.#closed = true;
    this.#ready = false;
    this.#token = null;
    this.#clearTimers();

    try {
      this.#socket?.close();
    } catch {
      // ignore
    }

    this.#socket = null;
  }
}

export async function sendRpcRequest({ state, version, client, id, largeImage, onStatus, onAccount } = {}) {
  const token = normalizeToken(id);
  const WebSocket = getWebSocket();

  const session = new RpcSession({
    WebSocket,
    token,
    client: field(client, 'PolyRPC'),
    state: field(state),
    version: field(version),
    largeImage,
    onStatus,
    onAccount,
  });

  const handle = {
    get connected() {
      return session.connected;
    },
    get user() {
      return session.user;
    },
    update(next) {
      session.update(next);
      return handle;
    },
    close() {
      session.close();
    },
  };

  await session.start();
  return handle;
}
