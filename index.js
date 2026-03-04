'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const dgram = require('dgram');
const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');

// --- Configuration -----------------------------------------------------------

const APP_DIR = __dirname;

const CONFIG = {
  serverUrl:           process.env.SERVER_URL,
  apiKey:              process.env.API_KEY,
  routerHost:          process.env.ROUTER_HOST         || '192.168.0.1',
  routerApiUsername:   process.env.ROUTER_API_USERNAME || '',
  routerApiPassword:   process.env.ROUTER_API_PASSWORD || '',
  serialBaud: 9600,         // Must match Elatec output baud rate
  minCardLength: 4,
  maxCardLength: 20,
  cardCooldownMs: 2_000,    // ignore re-reads of the same card within this window
  batchIntervalMs: 30_000,  // ms between batch send attempts
  maxQueueSize: 10_000,
  deviceScanIntervalMs: 5_000,
  heartbeatIntervalMs: 300_000,
};

if (!CONFIG.serverUrl || !CONFIG.apiKey) {
  console.error('FATAL: SERVER_URL and API_KEY must be set in .env — see .env.example');
  process.exit(1);
}

// Tracks last-seen timestamp (ms) per card number for cooldown enforcement.
const recentCards = new Map();

// --- Logging -----------------------------------------------------------------

function log(message) {
  const ts = new Date().toISOString().slice(0, 19) + 'Z';
  console.log(`[${ts}] ${message}`);
}

// --- TapQueue ----------------------------------------------------------------

class TapQueue {
  constructor(maxSize = 10_000, persistPath = null) {
    this._queue = [];
    this._maxSize = maxSize;
    this._persistPath = persistPath;
    this._load();
    log(`[Queue] Initialized with max size ${maxSize}, persist=${persistPath}, recovered=${this._queue.length} taps`);
  }

  _load() {
    if (!this._persistPath) return;
    try {
      if (fs.existsSync(this._persistPath)) {
        const data = JSON.parse(fs.readFileSync(this._persistPath, 'utf8'));
        if (Array.isArray(data)) {
          this._queue = data.slice(-this._maxSize);
          log(`[Queue] Recovered ${this._queue.length} taps from ${this._persistPath}`);
        }
      }
    } catch (e) {
      log(`[Queue] WARNING - Failed to load saved taps: ${e.message}`);
    }
  }

  _save() {
    if (!this._persistPath) return;
    try {
      const tmp = this._persistPath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this._queue));
      fs.renameSync(tmp, this._persistPath);
    } catch (e) {
      log(`[Queue] WARNING - Failed to save taps: ${e.message}`);
    }
  }

  enqueue(tap) {
    const wasFull = this._queue.length >= this._maxSize;
    if (wasFull) {
      this._queue.shift();
      log(`[Queue] Queue full (${this._maxSize}) - oldest tap evicted`);
    }
    this._queue.push(tap);
    this._save();
    const size = this._queue.length;
    if (size % 100 === 0 || size >= this._maxSize - 1000) {
      log(`[Queue] Size: ${size}/${this._maxSize}`);
    } else {
      log(`[Queue] Tap enqueued. Queue size: ${size}`);
    }
  }

  getBatch() {
    if (this._queue.length === 0) return [];
    const batch = [...this._queue];
    this._queue = [];
    this._save();
    log(`[Queue] Pulled batch of ${batch.length} taps`);
    return batch;
  }

  requeue(taps) {
    this._queue = [...taps, ...this._queue].slice(-this._maxSize);
    this._save();
    log(`[Queue] Requeued ${taps.length} taps. Queue size: ${this._queue.length}`);
  }

  get size() {
    return this._queue.length;
  }
}

// --- Router API helpers ------------------------------------------------------

function routerRequest(apiPath, timeoutMs = 5_000) {
  return new Promise((resolve) => {
    const options = {
      hostname: CONFIG.routerHost,
      port: 80,
      path: apiPath,
      method: 'GET',
      timeout: timeoutMs,
    };

    if (CONFIG.routerApiUsername) {
      const creds = Buffer.from(`${CONFIG.routerApiUsername}:${CONFIG.routerApiPassword}`).toString('base64');
      options.headers = { Authorization: `Basic ${creds}` };
    }

    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          resolve({ ok: true, data: JSON.parse(body) });
        } catch (e) {
          resolve({ ok: false, error: `Invalid JSON: ${e.message}` });
        }
      });
    });

    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, error: 'Request timed out' });
    });
    req.end();
  });
}

// --- Vehicle ID --------------------------------------------------------------

async function fetchVehicleId() {
  log('[Config] Fetching system_id from router...');

  const result = await routerRequest('/api/config/system/system_id');

  if (result.ok) {
    log(`[Config] Raw system_id response: ${JSON.stringify(result.data)}`);
    const value = result.data?.data ?? result.data;
    const str = (value !== null && value !== undefined) ? String(value).trim() : '';
    if (str) {
      log(`[Config] vehicleID: ${str}`);
      return str;
    }
  } else {
    log(`[Config] ERROR fetching system_id: ${result.error}`);
  }

  log('[Config] WARNING - system_id not found, defaulting to UNKNOWN');
  return 'UNKNOWN';
}

// --- GPS ---------------------------------------------------------------------

async function fetchGps() {
  const result = await routerRequest('/api/status/gps', 3_000);

  if (result.ok) {
    const data = result.data?.data ?? result.data;
    const latitude = data?.lastpos?.latitude ?? null;
    const longitude = data?.lastpos?.longitude ?? null;
    return { latitude, longitude };
  }

  log(`[GPS] Request failed: ${result.error}`);
  return { latitude: null, longitude: null };
}

// --- Card Validation & Processing --------------------------------------------

function validateCardNumber(cardNumber) {
  if (!cardNumber) {
    return { valid: false, reason: 'Empty card number' };
  }
  if (cardNumber.length < CONFIG.minCardLength) {
    return { valid: false, reason: `Too short (${cardNumber.length} chars)` };
  }
  if (cardNumber.length > CONFIG.maxCardLength) {
    return { valid: false, reason: `Too long (${cardNumber.length} chars)` };
  }

  log(`Card data: "${cardNumber}" (len=${cardNumber.length}, hex=${Buffer.from(cardNumber).toString('hex')})`);

  if (/^[a-zA-Z0-9]+$/.test(cardNumber)) {
    return { valid: true, reason: 'Valid alphanumeric' };
  }
  return { valid: false, reason: 'Invalid characters in card number' };
}

async function processCard(cardNumber, devicePath, tapQueue, busNumber) {
  log(`[Process] Card from ${devicePath}: "${cardNumber}"`);

  const { valid, reason } = validateCardNumber(cardNumber);
  if (!valid) {
    log(`[Process] REJECTED - ${reason}`);
    return false;
  }

  // Cooldown: ignore re-reads of the same card within the cooldown window.
  const now = Date.now();
  const lastSeen = recentCards.get(cardNumber) ?? 0;
  if (now - lastSeen < CONFIG.cardCooldownMs) {
    log(`[Process] DUPLICATE - ${cardNumber} seen ${now - lastSeen}ms ago, ignoring`);
    return false;
  }
  recentCards.set(cardNumber, now);
  // Prune entries older than the cooldown so the map doesn't grow unbounded.
  for (const [card, ts] of recentCards) {
    if (now - ts > CONFIG.cardCooldownMs) recentCards.delete(card);
  }

  log(`[Process] ACCEPTED - ${cardNumber} (${reason})`);

  const { latitude, longitude } = await fetchGps();
  log(`[Process] GPS: lat=${latitude}, lon=${longitude}`);

  tapQueue.enqueue({
    card_number: cardNumber,
    timestamp_utc: new Date().toISOString().slice(0, 19) + 'Z',
    latitude,
    longitude,
    bus_number: busNumber,
  });

  log(`[Process] Tap enqueued: card=${cardNumber}, bus=${busNumber}, gps=(${latitude},${longitude})`);
  return true;
}

// --- Batch Sender ------------------------------------------------------------

class BatchSender {
  constructor(tapQueue, serverUrl, apiKey = '', intervalMs = 30_000) {
    this._queue = tapQueue;
    this._serverUrl = serverUrl;
    this._apiKey = apiKey;
    this._intervalMs = intervalMs;
    this._timer = null;
    this._sending = false;
  }

  start() {
    this._timer = setInterval(() => this._sendBatch(), this._intervalMs);
    log(`[BatchSender] Started - sending every ${this._intervalMs / 1000}s to ${this._serverUrl}`);
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  _sendBatch() {
    if (this._sending) {
      log('[BatchSender] Previous send still in progress, skipping interval');
      return;
    }

    const raw = this._queue.getBatch();
    if (raw.length === 0) {
      log('[BatchSender] No taps to send. Queue empty.');
      return;
    }

    // Deduplicate by card_number + timestamp_utc before sending.
    const seen = new Set();
    const batch = raw.filter((tap) => {
      const key = `${tap.card_number}|${tap.timestamp_utc}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (batch.length < raw.length) {
      log(`[BatchSender] Removed ${raw.length - batch.length} duplicate tap(s) before send`);
    }

    this._sending = true;

    const payload = JSON.stringify({
      taps: batch,
      batch_size: batch.length,
      sent_at_utc: new Date().toISOString().slice(0, 19) + 'Z',
    });

    const url = new URL(this._serverUrl);
    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: 15_000,
    };

    if (this._apiKey) {
      options.headers['x-api-key'] = this._apiKey;
    }

    log(`[BatchSender] Sending batch of ${batch.length} taps...`);

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        this._sending = false;
        if (res.statusCode >= 200 && res.statusCode < 300) {
          log(`[BatchSender] SUCCESS - HTTP ${res.statusCode}, ${batch.length} taps delivered`);
        } else if (res.statusCode >= 400 && res.statusCode < 500) {
          log(`[BatchSender] DROPPED - HTTP ${res.statusCode} (bad request, batch discarded): ${body}`);
        } else {
          log(`[BatchSender] FAILED - HTTP ${res.statusCode} (server error, will retry): ${body}`);
          this._queue.requeue(batch);
        }
      });
    });

    req.on('error', (e) => {
      this._sending = false;
      log(`[BatchSender] FAILED - Network error: ${e.message}`);
      this._queue.requeue(batch);
    });

    req.on('timeout', () => {
      req.destroy();
      this._sending = false;
      log('[BatchSender] FAILED - Request timeout');
      this._queue.requeue(batch);
    });

    req.write(payload);
    req.end();
  }
}

// --- Serial Card Reader ------------------------------------------------------

class SerialCardReader {
  constructor(devicePath, baud, tapQueue, busNumber) {
    this._devicePath = devicePath;
    this._baud = baud;
    this._tapQueue = tapQueue;
    this._busNumber = busNumber;
    this._port = null;
    this._reconnectTimer = null;
  }

  open() {
    try {
      this._port = new SerialPort({
        path: this._devicePath,
        baudRate: this._baud,
        autoOpen: false,
      });

      const parser = this._port.pipe(new ReadlineParser({ delimiter: '\r' }));

      parser.on('data', (line) => {
        const cardNumber = line.trim();
        if (cardNumber) {
          log(`>>> Card tap on ${this._devicePath}: "${cardNumber}" <<<`);
          processCard(cardNumber, this._devicePath, this._tapQueue, this._busNumber)
            .catch((e) => log(`[Process] Error: ${e.message}`));
        }
      });

      this._port.on('close', () => {
        log(`[Serial] ${this._devicePath} closed — scheduling reconnect`);
        this._scheduleReconnect();
      });

      this._port.on('error', (e) => {
        log(`[Serial] Error on ${this._devicePath}: ${e.message}`);
      });

      this._port.open((err) => {
        if (err) {
          log(`[Serial] Failed to open ${this._devicePath}: ${err.message}`);
          this._port = null;
          this._scheduleReconnect();
          return;
        }
        log(`[Serial] Opened ${this._devicePath} at ${this._baud} baud`);
      });
    } catch (e) {
      log(`[Serial] Exception opening ${this._devicePath}: ${e.message}`);
      this._port = null;
      this._scheduleReconnect();
    }
  }

  _scheduleReconnect(delayMs = 5_000) {
    if (this._reconnectTimer) return;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      log(`[Reconnect] Attempting to reopen ${this._devicePath}`);
      this.open();
    }, delayMs);
  }

  close() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this._port?.isOpen) {
      this._port.close();
    }
    this._port = null;
  }

  get isOpen() {
    return this._port?.isOpen ?? false;
  }
}

// --- Device Monitor ----------------------------------------------------------

class DeviceMonitor {
  constructor(tapQueue, busNumber, baud) {
    this._tapQueue = tapQueue;
    this._busNumber = busNumber;
    this._baud = baud;
    this._readers = new Map(); // devicePath -> SerialCardReader
    this._scanTimer = null;
  }

  async start() {
    await this._scan();
    this._scanTimer = setInterval(() => this._scan(), CONFIG.deviceScanIntervalMs);
    log(`[DeviceMonitor] Started - scanning every ${CONFIG.deviceScanIntervalMs / 1000}s`);

    if (this._readers.size === 0) {
      log('No serial device found on startup. Waiting for Elatec reader (ttyACM0 or ttyUSB0)...');
    }
  }

  stop() {
    if (this._scanTimer) {
      clearInterval(this._scanTimer);
      this._scanTimer = null;
    }
    for (const reader of this._readers.values()) {
      reader.close();
    }
  }

  async _scan() {
    try {
      const ports = await SerialPort.list();
      const usbPorts = ports.filter((p) =>
        p.path.includes('ttyACM') || p.path.includes('ttyUSB')
      );

      for (const portInfo of usbPorts) {
        if (!this._readers.has(portInfo.path)) {
          log(`*** New serial device detected: ${portInfo.path} ***`);
          const reader = new SerialCardReader(portInfo.path, this._baud, this._tapQueue, this._busNumber);
          this._readers.set(portInfo.path, reader);
          reader.open();
        }
      }
    } catch (e) {
      log(`[DeviceMonitor] Scan error: ${e.message}`);
    }
  }

  get readerCount() {
    return this._readers.size;
  }

  get readerPaths() {
    return [...this._readers.keys()];
  }
}

// --- Main --------------------------------------------------------------------

async function main() {
  log('=== piTaps App Starting ===');
  log(`Config: server=${CONFIG.serverUrl}, baud=${CONFIG.serialBaud}, batch_interval=${CONFIG.batchIntervalMs / 1000}s`);

  const busNumber = await fetchVehicleId();

  const persistPath = path.join(APP_DIR, 'tap_queue.json');
  const tapQueue = new TapQueue(CONFIG.maxQueueSize, persistPath);

  const batchSender = new BatchSender(
    tapQueue,
    CONFIG.serverUrl,
    CONFIG.apiKey,
    CONFIG.batchIntervalMs,
  );
  batchSender.start();

  const monitor = new DeviceMonitor(tapQueue, busNumber, CONFIG.serialBaud);
  await monitor.start();

  const heartbeat = setInterval(() => {
    log(`[Heartbeat] Readers: ${monitor.readerPaths.join(', ') || 'none'}, queue: ${tapQueue.size}`);
  }, CONFIG.heartbeatIntervalMs);

  const shutdown = () => {
    log('Shutting down...');
    clearInterval(heartbeat);
    batchSender.stop();
    monitor.stop();
    const remaining = tapQueue.size;
    if (remaining > 0) {
      log(`WARNING: ${remaining} unsent taps in queue at shutdown`);
    }
    log('=== piTaps App Stopped ===');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // ---- UDP LISTENER (experimental) ----------------------------------------
  const udpSocket = dgram.createSocket('udp4');
  udpSocket.on('message', (msg, rinfo) => {
    console.log(`[UDP] ${rinfo.address}:${rinfo.port} — ${msg.toString()}`);
  });
  udpSocket.on('error', (err) => {
    log(`[UDP] Socket error: ${err.message}`);
    udpSocket.close();
  });
  udpSocket.bind(34952, () => {
    log(`[UDP] Listening on port ${udpSocket.address().port}`);
  });
  // ---- END UDP LISTENER ----------------------------------------------------

  log('=== piTaps App Running ===');
}

main().catch((err) => {
  log(`FATAL: ${err.message}`);
  process.exit(1);
});
