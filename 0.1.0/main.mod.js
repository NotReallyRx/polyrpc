import { PolyMod } from "https://cdn.polymodloader.com/cb/polytrackmods/PolyModLoader/0.6.3/PolyTypes.js";

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
  constructor({ WebSocket, token, client, state, version, largeImage, onStatus, onAccount }) {
    this.WebSocket = WebSocket;
    this.token = token;
    this.client = client;
    this.state = state;
    this.version = version;
    this.largeImage = largeImage;
    this.onStatus = typeof onStatus === 'function' ? onStatus : () => {};
    this.onAccount = typeof onAccount === 'function' ? onAccount : () => {};
    this.socket = null;
    this.heartbeat = null;
    this.heartbeatStart = null;
    this.connectTimeout = null;
    this.interval = null;
    this.seq = null;
    this.acked = true;
    this.attempts = 0;
    this.ready = false;
    this.closed = false;
    this.startedAt = Date.now();
    this.user = null;
    this.resolveReady = null;
    this.rejectReady = null;
  }

  get connected() {
    return this.ready;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
      this.connect();
    });
  }

  update(next = {}) {
    if (this.closed) throw new Error('RPC session is closed.');

    if (next.client !== undefined) this.client = field(next.client, 'PolyRPC');
    if (next.state !== undefined) this.state = field(next.state);
    if (next.version !== undefined) this.version = field(next.version);
    if (next.largeImage !== undefined) this.largeImage = next.largeImage;

    if (this.ready) this.sendPresence();
  }

  close() {
    if (this.closed) return;

    const reject = this.rejectReady;
    this.resolveReady = null;
    this.rejectReady = null;
    if (reject) reject(new Error('RPC session closed before it became ready.'));
    this.status('closed');
    this.shutdown();
  }

  connect() {
    if (this.closed) return;

    this.status('connecting');

    let socket;
    try {
      socket = new this.WebSocket(GATEWAY_URL);
    } catch (error) {
      this.fail(error instanceof Error ? error.message : 'Could not open the Discord gateway.');
      return;
    }

    this.socket = socket;

    socket.addEventListener('message', (event) => this.handleMessage(event.data));
    socket.addEventListener('close', (event) => this.handleClose(event.code));
    socket.addEventListener('error', () => {
      if (!this.closed) this.status('error', 'Gateway connection failed.');
    });

    if (typeof socket.on === 'function') {
      socket.on('unexpected-response', (_request, response) => {
        this.fail(`Discord rejected the gateway connection (HTTP ${response.statusCode}).`);
      });
    }

    this.connectTimeout = setTimeout(() => {
      if (!this.ready && !this.closed) {
        this.fail('Timed out connecting to the Discord gateway.');
      }
    }, CONNECT_TIMEOUT);
  }

  handleMessage(raw) {
    if (this.closed) return;

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

    if (typeof packet.s === 'number') this.seq = packet.s;

    switch (packet.op) {
      case 0:
        if (packet.t === 'READY') this.handleReady(packet.d);
        break;
      case 1:
        this.sendHeartbeat();
        break;
      case 7:
        this.reconnect();
        break;
      case 9:
        this.fail('Discord rejected the session. Check the token.');
        break;
      case 10:
        this.interval = packet.d.heartbeat_interval;
        this.startHeartbeat();
        this.identify();
        break;
      case 11:
        this.acked = true;
        break;
      default:
        break;
    }
  }

  handleReady(data) {
    clearTimeout(this.connectTimeout);
    this.connectTimeout = null;
    this.ready = true;
    this.attempts = 0;
    this.user = data?.user || null;

    this.onAccount(this.user);
    this.sendPresence();

    const resolve = this.resolveReady;
    this.resolveReady = null;
    this.rejectReady = null;
    if (resolve) resolve();
    this.status('connected');
  }

  identify() {
    this.send({
      op: 2,
      d: {
        token: this.token,
        capabilities: 125,
        properties: {
          os: platformName(),
          browser: 'polyrpc',
          device: 'polyrpc',
        },
        presence: this.presencePayload(),
        compress: false,
      },
    });
  }

  presencePayload() {
    const name = field(this.client, 'PolyRPC');
    const details = field(this.state);
    const state = field(this.version);
    const largeImage = this.largeImage || 'logo';

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
      timestamps: { start: this.startedAt },
    };

    return {
      since: 0,
      activities: [activity],
      status: 'online',
      afk: false,
    };
  }

  sendPresence() {
    this.send({ op: 3, d: this.presencePayload() });
  }

  startHeartbeat() {
    clearInterval(this.heartbeat);
    clearTimeout(this.heartbeatStart);
    this.acked = true;

    const jitter = Math.floor(Math.random() * this.interval);
    this.heartbeatStart = setTimeout(() => {
      if (this.closed) return;
      this.sendHeartbeat();
      this.heartbeat = setInterval(() => this.sendHeartbeat(), this.interval);
    }, jitter);
  }

  sendHeartbeat() {
    if (this.closed) return;

    if (!this.acked) {
      this.reconnect();
      return;
    }

    this.acked = false;
    this.send({ op: 1, d: this.seq });
  }

  send(payload) {
    if (this.socket && this.socket.readyState === 1) {
      this.socket.send(JSON.stringify(payload));
    }
  }

  reconnect() {
    if (this.closed) return;
    this.ready = false;
    try {
      if (this.socket) this.socket.close();
    } catch {
      this.handleClose(1006);
    }
  }

  handleClose(code) {
    this.clearTimers();
    this.ready = false;

    if (this.closed) return;

    if (code === 4003 || code === 4004) {
      this.fail('Discord rejected the token.');
      return;
    }

    if (code === 4013 || code === 4014) {
      this.fail(`Discord closed the gateway connection (${code}).`);
      return;
    }

    if (this.attempts >= MAX_ATTEMPTS) {
      this.fail('Lost the connection to Discord.');
      return;
    }

    this.attempts += 1;
    const delay = Math.min(30000, 1500 * Math.pow(2, this.attempts - 1));
    this.status('connecting', `Reconnecting (attempt ${this.attempts}).`);
    setTimeout(() => this.connect(), delay);
  }

  fail(message) {
    if (this.closed) return;

    const error = message instanceof Error ? message : new Error(message);
    const reject = this.rejectReady;
    this.resolveReady = null;
    this.rejectReady = null;
    if (reject) reject(error);
    this.status('error', error.message);
    this.shutdown();
  }

  status(status, error = null) {
    this.onStatus(status, error);
  }

  clearTimers() {
    clearInterval(this.heartbeat);
    clearTimeout(this.heartbeatStart);
    clearTimeout(this.connectTimeout);
    this.heartbeat = null;
    this.heartbeatStart = null;
    this.connectTimeout = null;
  }

  shutdown() {
    this.closed = true;
    this.ready = false;
    this.token = null;
    this.clearTimers();

    try {
      if (this.socket) this.socket.close();
    } catch {
      // ignore
    }

    this.socket = null;
  }
}

async function sendRpcRequest({ state, version, client, id, largeImage, onStatus, onAccount } = {}) {
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

class PolyRpcMod extends PolyMod {
  rpc = null;
  connecting = false;
  toggleBtn = null;
  stateTimer = null;
  tokenKey = "polyrpc_token";

  init = (pml) => {
    this.pml = pml;

    pml.registerSettingCategory("PolyRPC");
    pml.addCustomClickableButtons("Quick actions", [
      {
        text: "Set Discord Token",
        callback: () => this.setToken(),
      },
      {
        text: "Clear Discord Token",
        callback: () => this.clearToken(),
      },
    ]);
    pml.addCustomClickableButtons("Discord Rich Presence", [
      {
        text: "Toggle Discord RPC",
        callback: () => this.toggle(),
      },
    ]);

    this.updateToggleLabel();
    this.startStateUpdater();
  };

  getToken = () => {
    try {
      return localStorage.getItem(this.tokenKey) || "";
    } catch (e) {
      return "";
    }
  };

  setStoredToken = (token) => {
    try {
      localStorage.setItem(this.tokenKey, token);
    } catch (e) {
      // ignore
    }
  };

  clearToken = () => {
    try {
      localStorage.removeItem(this.tokenKey);
    } catch (e) {
      // ignore
    }
    alert("Token cleared.");
  };

  setToken = () => {
    const input = prompt("Discord user token (saved to localStorage)");
    if (input === null) return;
    const trimmed = String(input).trim();
    if (!trimmed) {
      alert("Token not set.");
      return;
    }
    if (/\s/.test(trimmed)) {
      alert("Token must not contain whitespace.");
      return;
    }
    this.setStoredToken(trimmed);
    alert("Token saved to localStorage.");
  };

  updateToggleLabel = () => {
    const btns = Array.from(document.querySelectorAll("button"));
    for (const btn of btns) {
      if (btn.textContent && btn.textContent.trim() === "Toggle Discord RPC") {
        this.toggleBtn = btn;
        break;
      }
    }
    if (this.toggleBtn) {
      this.toggleBtn.textContent = this.rpc?.connected ? "Disconnect Discord RPC" : "Connect Discord RPC";
    }
  };

  toggle = async () => {
    if (this.rpc?.connected) {
      this.disconnect();
      return;
    }
    await this.connect();
  };

  connect = async () => {
    if (this.connecting) return;
    if (this.rpc?.connected) {
      alert("Discord RPC is already connected.");
      this.updateToggleLabel();
      return;
    }
    const token = this.getToken();
    if (!token) {
      alert("Set a Discord token first via Quick actions > Set Discord Token.");
      return;
    }

    this.connecting = true;
    try {
      if (this.rpc) this.rpc.close();

      const state = this.getScreenState();
      this.rpc = await sendRpcRequest({
        id: token,
        client: "polymodloader",
        version: "0.6.3",
        state: state,
        largeImage: "logo",
      });

      alert("Discord RPC connected.");
    } catch (error) {
      this.rpc = null;
      alert(`Discord RPC failed: ${error.message}`);
    } finally {
      this.connecting = false;
      this.updateToggleLabel();
    }
  };

  disconnect = () => {
    if (!this.rpc) {
      alert("Discord RPC is not connected.");
      this.updateToggleLabel();
      return;
    }

    this.rpc.close();
    this.rpc = null;
    alert("Discord RPC disconnected.");
    this.updateToggleLabel();
  };

  isHidden = (el) => {
    if (!el) return true;
    if (el.classList.contains("hidden")) return true;
    const style = getComputedStyle(el);
    if (style.display === "none") return true;
    return false;
  };

  getScreenState = () => {
    try {
      const gameUi = document.querySelector(".game-ui");
      if (gameUi && !this.isHidden(gameUi)) {
        const gameToolbar = document.querySelector(".game-toolbar-ui");
        if (gameToolbar && !this.isHidden(gameToolbar)) {
          const trackNameEl = gameToolbar.querySelector(".track-name");
          const trackName = trackNameEl && trackNameEl.textContent ? trackNameEl.textContent.trim() : "";
          if (trackName) return `Playing: ${trackName}`;
        }
        const timeAnnouncer = document.querySelector(".time-announcer-ui");
        if (timeAnnouncer && !this.isHidden(timeAnnouncer)) {
          const trackNameEl = timeAnnouncer.querySelector(".track-name");
          const trackName = trackNameEl && trackNameEl.textContent ? trackNameEl.textContent.trim() : "";
          if (trackName) return `Playing: ${trackName}`;
        }
        return "Playing";
      }

      const editorUi = document.querySelector(".editor-ui");
      if (editorUi && !this.isHidden(editorUi)) {
        const trackSettingsBtn = editorUi.querySelector(".track-settings-container > button");
        const trackName = trackSettingsBtn && trackSettingsBtn.textContent ? trackSettingsBtn.textContent.trim() : "";
        if (trackName) return `Editing: ${trackName}`;
        return "Editing";
      }

      const trackExportUi = document.querySelector(".track-export-ui");
      if (trackExportUi && !this.isHidden(trackExportUi)) {
        const importBtn = trackExportUi.querySelector(".button.right");
        if (importBtn && importBtn.textContent && importBtn.textContent.includes("Import")) {
          return "Importing";
        }
        return "Exporting";
      }

      const trackInfoUi = document.querySelector(".track-info-ui");
      if (trackInfoUi && !this.isHidden(trackInfoUi)) {
        const trackNameEl = trackInfoUi.querySelector(".side-panel h2");
        const trackName = trackNameEl && trackNameEl.textContent ? trackNameEl.textContent.trim() : "";
        if (trackName) return `Track Info: ${trackName}`;
        return "Track Info";
      }

      const trackSelectionUi = document.querySelector(".track-selection-ui");
      if (trackSelectionUi && !this.isHidden(trackSelectionUi)) {
        return "Track Selection";
      }

      const settingsMenuUi = document.querySelector(".settings-menu-ui");
      if (settingsMenuUi && !this.isHidden(settingsMenuUi)) {
        return "Settings";
      }

      const menuUi = document.querySelector(".menu-ui");
      if (menuUi && !this.isHidden(menuUi)) {
        return "Main Menu";
      }

      return "Idle";
    } catch (e) {
      return "Idle";
    }
  };

  startStateUpdater = () => {
    if (this.stateTimer) clearInterval(this.stateTimer);
    this.stateTimer = setInterval(() => {
      this.updateToggleLabel();
      if (this.rpc?.connected) {
        try {
          const state = this.getScreenState();
          this.rpc.update({ state: state, client: "polymodloader", version: "0.6.3", largeImage: "logo" });
        } catch (e) {
          // ignore
        }
      }
    }, 1500);
  };
}

export const polyMod = new PolyRpcMod();
