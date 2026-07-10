'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');
const GtfsRealtimeBindings = require('gtfs-realtime-bindings');
const AdmZip = require('adm-zip');

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
  batchIntervalMs: 20_000,  // ms between batch send attempts
  maxQueueSize: 10_000,
  deviceScanIntervalMs: 5_000,
  heartbeatIntervalMs: 300_000,
  gtfsRtVehiclesUrl:   process.env.GTFS_RT_VEHICLES_URL || 'https://bustracker.ridewta.com/gtfsrt/vehicles',
  gtfsRtTripsUrl:      process.env.GTFS_RT_TRIPS_URL    || 'https://bustracker.ridewta.com/gtfsrt/trips',
  gtfsRtPollIntervalMs:    30_000, // how often to poll GTFS-RT and update current stop
  stopProximityMeters:     150,    // GPS distance threshold for stop validation
  atLastStopMeters:        50,     // distance to last stop that triggers end-of-trip detection
  atLastStopConfirmPolls:  2,      // consecutive polls within atLastStopMeters to confirm arrival
  backfillWindowSecs:      900,    // ±15 min buffer around scheduled trip window for back-fill
  gtfsTimezone:            process.env.GTFS_TIMEZONE || 'America/Los_Angeles',
  gtfsStaticUrl:           process.env.GTFS_STATIC_URL || 'https://github.com/whatcomtrans/publicwtadata/raw/master/GTFS/wta_gtfs_latest.zip',
  cardListSyncUrl:         process.env.CARD_LIST_SYNC_URL || 'https://api.taps.ridewta.com',
  cardListSyncIntervalMs:  parseInt(process.env.CARD_LIST_SYNC_INTERVAL_MS, 10) || 60_000,
};

// Tracks last-seen timestamp (ms) per card number for cooldown enforcement.
const recentCards = new Map();

// Feedback bytes sent back to the Elatec reader after each tap.
const FEEDBACK = { VALID: 0x47, INVALID: 0x52 };  // 'G', 'R'

// --- Remote config (S3) ------------------------------------------------------

const REMOTE_CONFIG_CACHE_PATH = path.join(APP_DIR, 'remote_config_cache.json');

async function loadRemoteConfig() {
  const bucket = process.env.S3_CONFIG_BUCKET;
  const key    = process.env.S3_CONFIG_KEY || 'pitaps-config.json';
  const region = process.env.AWS_REGION    || 'us-west-2';

  if (!bucket) {
    log('[Config] S3_CONFIG_BUCKET not set — SERVER_URL/API_KEY must be in .env');
    return null;
  }

  try {
    log(`[Config] Fetching fleet config from s3://${bucket}/${key}...`);
    const client = new S3Client({ region });
    const resp   = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const chunks = [];
    for await (const chunk of resp.Body) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const config = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    log(`[Config] Fleet config loaded (${Object.keys(config).join(', ')})`);
    try { fs.writeFileSync(REMOTE_CONFIG_CACHE_PATH, JSON.stringify(config)); } catch (_) {}
    return config;
  } catch (e) {
    log(`[Config] WARNING - S3 fetch failed: ${e.message}`);
  }

  try {
    if (fs.existsSync(REMOTE_CONFIG_CACHE_PATH)) {
      const config = JSON.parse(fs.readFileSync(REMOTE_CONFIG_CACHE_PATH, 'utf8'));
      log('[Config] Using cached fleet config from last successful S3 fetch');
      return config;
    }
  } catch (e) {
    log(`[Config] WARNING - Fleet config cache unreadable: ${e.message}`);
  }

  log('[Config] No fleet config available from S3 or cache — falling back to .env');
  return null;
}

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

  // Updates taps in place. fn(tap) should return the updated tap object, or null to leave unchanged.
  // Returns the count of updated taps.
  backfill(fn) {
    let count = 0;
    for (let i = 0; i < this._queue.length; i++) {
      const updated = fn(this._queue[i]);
      if (updated !== null) {
        this._queue[i] = updated;
        count++;
      }
    }
    if (count > 0) this._save();
    return count;
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

// --- GTFS time utilities -----------------------------------------------------

// Converts a GTFS "HH:MM:SS" time string to seconds since midnight.
// GTFS allows values ≥ 86400 for trips that run past midnight.
function gtfsTimeToSecs(timeStr) {
  if (!timeStr) return null;
  const parts = timeStr.split(':');
  if (parts.length < 2) return null;
  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  const s = parseInt(parts[2] ?? '0', 10);
  if (isNaN(h) || isNaN(m) || isNaN(s)) return null;
  return h * 3600 + m * 60 + s;
}

// Converts a UTC ISO timestamp to seconds since local midnight in the given IANA timezone.
function utcTimestampToLocalSecs(isoUtc, timezone) {
  try {
    const date = new Date(isoUtc);
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    }).formatToParts(date);
    const get = (type) => parseInt(parts.find((p) => p.type === type)?.value ?? '0', 10);
    return get('hour') * 3600 + get('minute') * 60 + get('second');
  } catch {
    return null;
  }
}

// --- Haversine distance ------------------------------------------------------

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R     = 6_371_000; // Earth radius in metres
  const toRad = (deg) => deg * Math.PI / 180;
  const dLat  = toRad(lat2 - lat1);
  const dLon  = toRad(lon2 - lon1);
  const a     = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

// --- GTFS Static Cache -------------------------------------------------------

class GtfsStaticCache {
  constructor(staticUrl) {
    this._staticUrl   = staticUrl;
    this._stopTimes   = new Map(); // trip_id → [{stopSequence, stopId, lat, lon}] sorted by sequence
    this._stops       = new Map(); // stop_id → {lat, lon}
    this._trips       = new Map(); // trip_id → {route_id, service_id}
    this._loaded      = false;
    this._loadPromise = null;
  }

  // Returns sorted stop array for a trip (with lat/lon), or null if not yet loaded / not found.
  getStops(tripId) {
    if (!this._loaded || tripId == null) return null;
    return this._stopTimes.get(String(tripId)) ?? null;
  }

  // Returns the stop_code for a stop_id, or null if not loaded / not found.
  getStopCode(stopId) {
    if (!this._loaded || stopId == null) return null;
    return this._stops.get(String(stopId))?.stop_code ?? null;
  }

  // Returns {route_id, service_id} for a trip, or null if not loaded / not found.
  getTripInfo(tripId) {
    if (!this._loaded || tripId == null) return null;
    return this._trips.get(String(tripId)) ?? null;
  }

  // Kicks off the download+parse if not already started. Safe to call multiple times.
  ensureLoaded() {
    if (this._loaded) return Promise.resolve();
    if (!this._loadPromise) {
      this._loadPromise = this._downloadAndParse()
        .then(() => { this._loaded = true; })
        .catch((e) => {
          log(`[GTFS-Static] Load failed: ${e.message}`);
          this._loadPromise = null; // allow a later retry
        });
    }
    return this._loadPromise;
  }

  _downloadZip(urlStr, redirectsLeft = 5) {
    return new Promise((resolve, reject) => {
      if (redirectsLeft <= 0) return reject(new Error('Too many redirects'));
      const url = new URL(urlStr);
      const lib = url.protocol === 'https:' ? https : http;
      const chunks = [];
      const req = lib.request({
        hostname: url.hostname,
        path:     url.pathname + url.search,
        method:   'GET',
        headers:  { 'User-Agent': 'piTaps/1.0' },
        timeout:  120_000,
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          resolve(this._downloadZip(res.headers.location, redirectsLeft - 1));
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Download timed out')); });
      req.end();
    });
  }

  async _downloadAndParse() {
    log(`[GTFS-Static] Downloading from ${this._staticUrl}...`);
    const buffer = await this._downloadZip(this._staticUrl);
    log(`[GTFS-Static] Downloaded ${(buffer.length / 1024 / 1024).toFixed(1)} MB — parsing stops + stop_times...`);

    const zip = new AdmZip(buffer);

    // --- Parse stops.txt → stop coordinates ---
    const stopsEntry = zip.getEntry('stops.txt');
    if (stopsEntry) {
      const csv     = stopsEntry.getData().toString('utf8');
      const lines   = csv.split('\n');
      const headers = lines[0].toLowerCase().replace(/\r/g, '').split(',').map((h) => h.trim());
      const idIdx   = headers.indexOf('stop_id');
      const codeIdx = headers.indexOf('stop_code');
      const latIdx  = headers.indexOf('stop_lat');
      const lonIdx  = headers.indexOf('stop_lon');
      if (idIdx >= 0 && latIdx >= 0 && lonIdx >= 0) {
        for (let i = 1; i < lines.length; i++) {
          const line = lines[i].trim();
          if (!line) continue;
          const cols      = line.split(',');
          const stopId    = cols[idIdx]?.trim();
          const stop_code = codeIdx >= 0 ? (cols[codeIdx]?.trim() || null) : null;
          const lat       = parseFloat(cols[latIdx]?.trim());
          const lon       = parseFloat(cols[lonIdx]?.trim());
          if (stopId && !isNaN(lat) && !isNaN(lon)) {
            this._stops.set(stopId, { lat, lon, stop_code });
          }
        }
        log(`[GTFS-Static] Loaded ${this._stops.size} stop coordinates`);
      } else {
        log('[GTFS-Static] WARNING - stops.txt missing stop_id/stop_lat/stop_lon columns');
      }
    } else {
      log('[GTFS-Static] WARNING - stops.txt not found in ZIP');
    }

    // --- Parse trips.txt → trip metadata (route_id, service_id) ---
    const tripsEntry = zip.getEntry('trips.txt');
    if (tripsEntry) {
      const csv     = tripsEntry.getData().toString('utf8');
      const lines   = csv.split('\n');
      const headers = lines[0].toLowerCase().replace(/\r/g, '').split(',').map((h) => h.trim());
      const tIdIdx  = headers.indexOf('trip_id');
      const rIdIdx  = headers.indexOf('route_id');
      const sIdIdx  = headers.indexOf('service_id');
      if (tIdIdx >= 0 && rIdIdx >= 0 && sIdIdx >= 0) {
        for (let i = 1; i < lines.length; i++) {
          const line = lines[i].trim();
          if (!line) continue;
          const cols      = line.split(',');
          const tripId    = cols[tIdIdx]?.trim();
          const routeId   = cols[rIdIdx]?.trim();
          const serviceId = cols[sIdIdx]?.trim();
          if (tripId && routeId) {
            this._trips.set(tripId, { route_id: routeId, service_id: serviceId || null });
          }
        }
        log(`[GTFS-Static] Loaded ${this._trips.size} trip records`);
      } else {
        log('[GTFS-Static] WARNING - trips.txt missing required columns');
      }
    } else {
      log('[GTFS-Static] WARNING - trips.txt not found in ZIP');
    }

    // --- Parse stop_times.txt → trip stop sequences (enriched with coords) ---
    const entry = zip.getEntry('stop_times.txt');
    if (!entry) throw new Error('stop_times.txt not found in GTFS ZIP');

    const csv     = entry.getData().toString('utf8');
    const lines   = csv.split('\n');
    const headers = lines[0].toLowerCase().replace(/\r/g, '').split(',').map((h) => h.trim());

    const tripIdIdx      = headers.indexOf('trip_id');
    const stopIdIdx      = headers.indexOf('stop_id');
    const stopSeqIdx     = headers.indexOf('stop_sequence');
    const arrivalTimeIdx = headers.indexOf('arrival_time');
    if (tripIdIdx < 0 || stopIdIdx < 0 || stopSeqIdx < 0) {
      throw new Error('stop_times.txt missing required columns');
    }

    // Temporary map to track earliest/latest stop per trip for scheduled time window
    const tripTimeMap = new Map(); // trip_id → {minSeq, startTime, maxSeq, endTime}

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const cols        = line.split(',');
      const tripId      = cols[tripIdIdx]?.trim();
      const stopId      = cols[stopIdIdx]?.trim();
      const seq         = parseInt(cols[stopSeqIdx]?.trim(), 10);
      const arrivalTime = arrivalTimeIdx >= 0 ? (cols[arrivalTimeIdx]?.trim() || null) : null;
      if (!tripId || !stopId || isNaN(seq)) continue;
      if (!this._stopTimes.has(tripId)) this._stopTimes.set(tripId, []);
      const coords = this._stops.get(stopId) ?? { lat: null, lon: null };
      this._stopTimes.get(tripId).push({ stopSequence: seq, stopId, lat: coords.lat, lon: coords.lon });

      // Track first (min seq) and last (max seq) arrival times for back-fill window
      if (arrivalTime) {
        if (!tripTimeMap.has(tripId)) {
          tripTimeMap.set(tripId, { minSeq: seq, startTime: arrivalTime, maxSeq: seq, endTime: arrivalTime });
        } else {
          const t = tripTimeMap.get(tripId);
          if (seq < t.minSeq) { t.minSeq = seq; t.startTime = arrivalTime; }
          if (seq > t.maxSeq) { t.maxSeq = seq; t.endTime   = arrivalTime; }
        }
      }
    }

    for (const stops of this._stopTimes.values()) {
      stops.sort((a, b) => a.stopSequence - b.stopSequence);
    }

    // Merge scheduled time windows into the trips map
    for (const [tripId, times] of tripTimeMap) {
      const tripEntry = this._trips.get(tripId);
      if (tripEntry) {
        tripEntry.startSecs = gtfsTimeToSecs(times.startTime);
        tripEntry.endSecs   = gtfsTimeToSecs(times.endTime);
      }
    }

    log(`[GTFS-Static] Loaded ${this._stopTimes.size} trips with stop sequences and time windows`);
  }
}

// --- GTFS-RT Cache -----------------------------------------------------------

class GtfsRtCache {
  constructor(vehiclesUrl, tripsUrl, pollIntervalMs, staticCache) {
    this._vehiclesUrl    = vehiclesUrl;
    this._tripsUrl       = tripsUrl;
    this._pollIntervalMs = pollIntervalMs;
    this._staticCache    = staticCache;
    this._vehiclesFeed   = null;
    this._tripsFeed      = null;
    this._busNumber      = null;
    this._tapQueue       = null;
    this._pollTimer      = null;
    this._polling        = false;
    // Continuously updated vehicle state (trip/route/service from static GTFS, stop from resolution logic)
    this._state = { tripId: null, routeId: null, serviceId: null, stopId: null, stopCode: null, lat: null, lon: null, updatedAt: null };
    // Enriched stop arrays for the current and previous trip (from static GTFS + stop coords)
    this._gtfsRtTripId      = null; // most recent trip ID as reported by GTFS-RT (for change detection)
    this._currentTripStops  = null; // [{stopSequence, stopId, lat, lon}]
    this._previousTripId    = null;
    this._previousTripStops = null;
    // Connectivity outage tracking
    this._feedFailed                 = false; // true when vehicles feed fetch fails
    this._atLastStop                 = false; // true once bus confirmed dwelling at trip's last stop
    this._consecutiveNearLastStop    = 0;     // polls within atLastStopMeters of last stop
  }

  // Start proactive polling. Fires immediately, then every pollIntervalMs.
  startPolling(busNumber, tapQueue) {
    this._busNumber = String(busNumber);
    this._tapQueue  = tapQueue;
    log(`[GTFS-RT] Starting poll every ${this._pollIntervalMs / 1000}s for bus ${this._busNumber}`);
    this._poll();
    this._pollTimer = setInterval(() => this._poll(), this._pollIntervalMs);
  }

  stopPolling() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  _fetchFeed(urlStr) {
    return new Promise((resolve) => {
      const url = new URL(urlStr);
      const req = https.request({
        hostname: url.hostname,
        path: url.pathname + url.search,
        method: 'GET',
        timeout: 10_000,
      }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          try {
            const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(Buffer.concat(chunks));
            resolve({ ok: true, feed });
          } catch (e) {
            resolve({ ok: false, error: `Decode failed: ${e.message}` });
          }
        });
      });
      req.on('error',   (e) => resolve({ ok: false, error: e.message }));
      req.on('timeout', ()  => { req.destroy(); resolve({ ok: false, error: 'Timed out' }); });
      req.end();
    });
  }

  async _refresh() {
    log('[GTFS-RT] Fetching vehicles + trips feeds...');
    const [vResult, tResult] = await Promise.all([
      this._fetchFeed(this._vehiclesUrl),
      this._fetchFeed(this._tripsUrl),
    ]);
    if (vResult.ok) {
      this._vehiclesFeed = vResult.feed;
      log(`[GTFS-RT] Vehicles: ${this._vehiclesFeed.entity.length} entities`);
    } else {
      log(`[GTFS-RT] WARNING - Vehicles fetch failed: ${vResult.error}`);
    }
    if (tResult.ok) {
      this._tripsFeed = tResult.feed;
      log(`[GTFS-RT] Trips: ${this._tripsFeed.entity.length} entities`);
    } else {
      log(`[GTFS-RT] WARNING - Trips fetch failed: ${tResult.error}`);
    }
    return { vehiclesOk: vResult.ok, tripsOk: tResult.ok };
  }

  async _poll() {
    if (this._polling) return;
    this._polling = true;
    try {
      const [gps, { vehiclesOk }] = await Promise.all([fetchGps(), this._refresh()]);

      // Retry static GTFS download if startup failed — fire-and-forget, result available next poll
      if (!this._staticCache._loaded) this._staticCache.ensureLoaded();

      const wasFailedBeforeThisPoll = this._feedFailed;

      // Update feed failure flag based on whether the vehicles feed (primary) succeeded
      this._feedFailed = !vehiclesOk;

      const busStr = this._busNumber;
      let rtTripId = null, rtRouteId = null, currentStopSeq = null, currentStatus = null;

      // Try vehicles feed first — has route, trip, and current stop sequence/status
      if (this._vehiclesFeed?.entity) {
        for (const entity of this._vehiclesFeed.entity) {
          const veh = entity.vehicle;
          if (!veh) continue;
          if (String(veh.vehicle?.id ?? '') === busStr) {
            rtTripId       = veh.trip?.tripId  ?? null;
            rtRouteId      = veh.trip?.routeId ?? null;
            currentStopSeq = veh.currentStopSequence ?? null;
            currentStatus  = veh.currentStatus ?? null; // 0=INCOMING_AT, 1=STOPPED_AT, 2=IN_TRANSIT_TO
            break;
          }
        }
      }

      // Fall back to trips feed if trip not found in vehicles
      if (!rtTripId && this._tripsFeed?.entity) {
        for (const entity of this._tripsFeed.entity) {
          const tu = entity.tripUpdate;
          if (!tu) continue;
          if (String(tu.vehicle?.id ?? '') === busStr) {
            rtTripId  = tu.trip?.tripId  ?? null;
            rtRouteId = tu.trip?.routeId ?? null;
            break;
          }
        }
      }

      // Track GTFS-RT trip changes — rebuild enriched stop list for new trip
      if (rtTripId && rtTripId !== this._gtfsRtTripId) {
        log(`[GTFS-RT] Trip changed: ${this._gtfsRtTripId ?? 'none'} → ${rtTripId}`);
        this._previousTripId    = this._gtfsRtTripId;
        this._previousTripStops = this._currentTripStops;
        this._currentTripStops  = this._staticCache.getStops(rtTripId);
        this._gtfsRtTripId      = rtTripId;
        if (!this._currentTripStops) {
          log(`[GTFS-RT] Static stop data not yet available for trip ${rtTripId}`);
        }
      } else if (rtTripId && !this._currentTripStops) {
        // Static data may have loaded since the last poll — retry
        this._currentTripStops = this._staticCache.getStops(rtTripId);
      }

      // Feed recovery: back-fill queued 'no match: connectivity' taps then clear outage state
      if (wasFailedBeforeThisPoll && vehiclesOk && rtTripId) {
        log(`[GTFS-RT] Feed recovered on trip ${rtTripId} — attempting back-fill`);
        this._backfillConnectivityTaps();
        this._atLastStop              = false;
        this._consecutiveNearLastStop = 0;
      }

      // End-of-trip monitoring during a feed outage
      if (this._feedFailed && !this._atLastStop) {
        const lastStop = this._currentTripStops?.[this._currentTripStops.length - 1];
        if (lastStop?.lat != null && gps.latitude != null) {
          const distToEnd = haversineMeters(gps.latitude, gps.longitude, lastStop.lat, lastStop.lon);
          if (distToEnd <= CONFIG.atLastStopMeters) {
            this._consecutiveNearLastStop++;
            if (this._consecutiveNearLastStop >= CONFIG.atLastStopConfirmPolls) {
              this._atLastStop = true;
              log(`[GTFS-RT] Bus confirmed at last stop of trip ${this._gtfsRtTripId} — taps will get 'no match: connectivity'`);
            }
          } else {
            this._consecutiveNearLastStop = 0;
          }
        }
      }

      // Determine which stop the bus is at and which trip that stop belongs to.
      // At trip boundaries these may differ from rtTripId (see _resolveStop).
      let stopId = null;
      let resolvedTripId = rtTripId; // the trip the resolved stop belongs to
      if (currentStopSeq != null && currentStatus != null) {
        const resolved = this._resolveStop(currentStopSeq, currentStatus, gps.latitude, gps.longitude, rtTripId);
        if (resolved) {
          stopId         = resolved.stopId;
          resolvedTripId = resolved.sourceTripId;
        }
      } else if (this._currentTripStops) {
        // No sequence data from GTFS-RT — use GPS alone to find nearest stop on the trip
        const nearest = this._findNearestStop(this._currentTripStops, gps.latitude, gps.longitude);
        if (nearest) {
          stopId = nearest.stopId;
          log(`[GTFS-RT] No sequence data — GPS nearest stop: ${stopId} (${nearest.distance.toFixed(0)}m)`);
        }
      }

      // resolvedTripId may be null if bus not in feeds — retain previous
      resolvedTripId = resolvedTripId ?? this._state.tripId;

      // Look up authoritative route_id and service_id from static trips data
      const tripInfo = this._staticCache.getTripInfo(resolvedTripId);
      const routeId   = tripInfo?.route_id   ?? rtRouteId ?? this._state.routeId;
      const serviceId = tripInfo?.service_id ?? this._state.serviceId;
      const stopCode  = this._staticCache.getStopCode(stopId);

      this._state = {
        tripId:    resolvedTripId,
        routeId,
        serviceId,
        stopId,
        stopCode,
        lat:       gps.latitude,
        lon:       gps.longitude,
        updatedAt: Date.now(),
      };

      if (rtTripId) {
        log(`[GTFS-RT] Poll: bus=${busStr}, trip=${resolvedTripId}, route=${routeId}, service=${serviceId}, stop=${stopId}, gps=(${gps.latitude},${gps.longitude})`);
      } else {
        log(`[GTFS-RT] Poll: bus ${busStr} not found in feeds — retaining previous trip ${this._state.tripId ?? 'none'}`);
      }
    } catch (e) {
      log(`[GTFS-RT] Poll error: ${e.message}`);
    } finally {
      this._polling = false;
    }
  }

  // Scans the queue for 'no match: connectivity' taps and attempts to resolve them
  // against the current trip's scheduled window and stop list.
  _backfillConnectivityTaps() {
    if (!this._tapQueue) return;
    const tripId   = this._gtfsRtTripId;
    const tripInfo = this._staticCache.getTripInfo(tripId);
    const tripStops = this._currentTripStops;

    if (!tripId || !tripInfo || !tripStops?.length) {
      log('[GTFS-RT] Back-fill skipped — trip info or stop list not available');
      return;
    }
    if (tripInfo.startSecs == null || tripInfo.endSecs == null) {
      log('[GTFS-RT] Back-fill skipped — scheduled trip times not available in static data');
      return;
    }

    const { startSecs, endSecs, route_id, service_id } = tripInfo;
    const buffer = CONFIG.backfillWindowSecs;

    const count = this._tapQueue.backfill((tap) => {
      if (tap.gtfs !== 'no match: connectivity') return null;

      // Check timestamp falls within this trip's scheduled window ±15 minutes
      const tapSecs = utcTimestampToLocalSecs(tap.timestamp_utc, CONFIG.gtfsTimezone);
      if (tapSecs == null) return null;
      if (tapSecs < startSecs - buffer || tapSecs > endSecs + buffer) return null;

      // GPS-match to nearest stop on current trip
      const nearest = this._findNearestStop(tripStops, tap.latitude, tap.longitude);
      if (!nearest || nearest.distance > CONFIG.stopProximityMeters) return null;

      return {
        ...tap,
        gtfs:       'match: backfilled',
        route_id,
        trip_id:    tripId,
        service_id,
        stop_id:    nearest.stopId,
        stop_code:  this._staticCache.getStopCode(nearest.stopId),
      };
    });

    log(`[GTFS-RT] Back-fill complete: ${count} tap(s) resolved to trip ${tripId}`);
  }

  // Determine the stop the bus is at or about to arrive at.
  // currentStatus: 0=INCOMING_AT, 1=STOPPED_AT, 2=IN_TRANSIT_TO
  // STOPPED_AT (1)    → use this stop (bus is here)
  // INCOMING_AT (0)   → use this stop (bus is arriving — passengers are boarding for this trip/stop)
  // IN_TRANSIT_TO (2) → use previous stop (seq - 1), bus has already departed it
  //   IN_TRANSIT_TO seq 1 → targetSeq 0 won't exist → use last stop of previous trip
  // Returns {stopId, sourceTripId} — sourceTripId may be the previous trip at boundaries.
  _resolveStop(currentStopSeq, currentStatus, lat, lon, currentTripId) {
    // IN_TRANSIT_TO: bus has left seq-1 and is heading to seq → use seq-1
    // STOPPED_AT / INCOMING_AT: bus is at or arriving at this stop → use seq
    const targetSeq = currentStatus === 2 ? currentStopSeq - 1 : currentStopSeq;

    let stop        = this._currentTripStops?.find((s) => s.stopSequence === targetSeq) ?? null;
    let sourceTripId = currentTripId;

    // Trip boundary: IN_TRANSIT_TO seq 1 gives targetSeq 0 which won't exist — use last stop of previous trip
    if (!stop && this._previousTripStops?.length > 0) {
      const firstSeq = this._currentTripStops?.[0]?.stopSequence ?? Infinity;
      if (targetSeq < firstSeq) {
        stop         = this._previousTripStops[this._previousTripStops.length - 1];
        sourceTripId = this._previousTripId;
        log(`[GTFS-RT] Trip boundary: using last stop of previous trip → ${stop.stopId}`);
      }
    }

    if (!stop) return null;

    // GPS validation: if we have coordinates for both the stop and the bus, verify proximity
    if (stop.lat != null && lat != null) {
      const dist = haversineMeters(lat, lon, stop.lat, stop.lon);
      if (dist > CONFIG.stopProximityMeters) {
        log(`[GTFS-RT] GTFS-RT stop ${stop.stopId} is ${dist.toFixed(0)}m away — checking GPS for override`);
        const nearest = this._findNearestStop(this._currentTripStops, lat, lon);
        if (nearest && nearest.distance < CONFIG.stopProximityMeters) {
          log(`[GTFS-RT] GPS override: ${nearest.stopId} (${nearest.distance.toFixed(0)}m) instead of ${stop.stopId} (${dist.toFixed(0)}m)`);
          return { stopId: nearest.stopId, sourceTripId: currentTripId };
        }
        log(`[GTFS-RT] No nearby stop found via GPS — keeping GTFS-RT stop ${stop.stopId}`);
      }
    }

    return { stopId: stop.stopId, sourceTripId };
  }

  // Find the stop on a trip closest to the given GPS coordinates.
  _findNearestStop(tripStops, lat, lon) {
    if (!tripStops?.length || lat == null || lon == null) return null;
    let best = null;
    for (const stop of tripStops) {
      if (stop.lat == null) continue;
      const dist = haversineMeters(lat, lon, stop.lat, stop.lon);
      if (!best || dist < best.distance) {
        best = { stopId: stop.stopId, stopSequence: stop.stopSequence, distance: dist };
      }
    }
    return best;
  }

  // Returns cached GTFS info for the bus. Called at tap time — no async fetch needed.
  getGtfsInfo() {
    if (this._atLastStop) return { gtfs: 'no match: connectivity' };
    const s = this._state;
    if (!s.tripId) return { gtfs: 'no match' };
    return { gtfs: 'match', route_id: s.routeId, trip_id: s.tripId, service_id: s.serviceId, stop_id: s.stopId, stop_code: s.stopCode };
  }
}

const gtfsStaticCache = new GtfsStaticCache(CONFIG.gtfsStaticUrl);
const gtfsCache = new GtfsRtCache(
  CONFIG.gtfsRtVehiclesUrl,
  CONFIG.gtfsRtTripsUrl,
  CONFIG.gtfsRtPollIntervalMs,
  gtfsStaticCache,
);

// --- Card Validation Lists ---------------------------------------------------

function fetchText(urlStr, redirectsLeft = 5, headers = {}) {
  return new Promise((resolve, reject) => {
    if (redirectsLeft <= 0) return reject(new Error('Too many redirects'));
    const url = new URL(urlStr);
    const lib = url.protocol === 'https:' ? https : http;
    const chunks = [];
    const req = lib.request({
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'GET',
      headers: { 'User-Agent': 'piTaps/1.0', ...headers },
      timeout: 30_000,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        resolve(fetchText(res.headers.location, redirectsLeft - 1, headers));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timed out')); });
    req.end();
  });
}

async function fetchJson(urlStr, headers = {}) {
  return JSON.parse(await fetchText(urlStr, 5, headers));
}

// Downloads and caches card validation lists. checkCard() returns the list name
// the card was found in (string), false if no lists matched, or null if no lists
// are configured (validation disabled — all cards pass through).
class CardValidationCache {
  constructor() {
    this._lists = new Map();  // listName → Set<string>
    this._configured = false;
  }

  async load(cardLists) {
    this._configured = true;
    const entries = Object.entries(cardLists);
    if (entries.length === 0) return;

    const results = await Promise.allSettled(
      entries.map(async ([name, url]) => {
        let text;
        if (/^https?:\/\//i.test(url)) {
          text = await fetchText(url);
        } else {
          const resolved = path.resolve(url);
          if (resolved !== url || url.includes('..')) throw new Error(`Card list path must be absolute with no traversal: ${url}`);
          text = fs.readFileSync(resolved, 'utf8');
        }
        const cards = text.split('\n')
          .map((line) => line.trim())
          .filter((line) => line && !line.startsWith('#'));
        this._lists.set(name, new Set(cards));
        log(`[CardLists] Loaded ${cards.length} ${name} cards from ${url}`);
      })
    );

    for (const r of results) {
      if (r.status === 'rejected') {
        log(`[CardLists] WARNING - Failed to load a list: ${r.reason?.message}`);
      }
    }
  }

  // Atomically swaps in a new card set for a list (a Map.set of a fully built
  // Set — tap checking never sees a half-applied list). `authoritative` marks
  // the list as server-backed: until at least one list is authoritative,
  // checkCard() stays in pass-through mode.
  setList(name, cards, authoritative = true) {
    this._lists.set(name, cards);
    if (authoritative) this._configured = true;
  }

  // Returns list name if card is valid, false if explicitly invalid,
  // null if no lists are configured (pass-through mode).
  checkCard(cardNumber) {
    if (!this._configured || this._lists.size === 0) return null;
    for (const [name, cards] of this._lists) {
      if (cards.has(cardNumber)) return name;
    }
    return false;
  }
}

const cardValidationCache = new CardValidationCache();

// --- Card List Sync ------------------------------------------------------------
//
// Keeps local copies of the youth/student/staff card lists in sync with the
// taps API (same API key as tap batches):
//   GET /lists/{type}                    → full list + token + checksum
//   GET /lists/{type}/changes?since=<t>  → 'current' | 'delta' | 'resync'
// The server checksum is the correctness backstop: it is verified after every
// full pull and delta application, and verified state (list + token +
// checksum) is persisted atomically so a restart resumes from the last good
// token. Sync failures never touch the tap path — the previous list stays in
// effect and the next cycle retries.

const CARD_LIST_TYPES = ['youth', 'student', 'staff'];
const CARD_SYNC_INITIAL_RETRY_MS = 5_000;

// Canonical list checksum — must match the backend byte-for-byte:
// trim, drop empties, uppercase, de-duplicate, sort ascending, join with LF
// (no trailing newline), UTF-8, SHA-256 lowercase hex.
function listChecksum(cardNumbers) {
  const normalized = [...new Set(
    [...cardNumbers].map((c) => String(c).trim().toUpperCase()).filter(Boolean)
  )].sort();
  return crypto.createHash('sha256').update(normalized.join('\n'), 'utf8').digest('hex');
}

class CardListSyncClient {
  constructor({ baseUrl, apiKey, persistDir, intervalMs, cache, fetchJsonFn = fetchJson }) {
    this._baseUrl = String(baseUrl).replace(/\/+$/, '');
    this._apiKey = apiKey;
    this._persistDir = persistDir;
    this._intervalMs = intervalMs;
    this._cache = cache;
    this._fetchJson = fetchJsonFn;
    this._state = new Map();   // type → {token, checksum, cards: Set}
    this._timers = new Map();  // type → setTimeout handle
    this._retryMs = new Map(); // type → boot backoff delay (present until first successful sync)
    this._stopped = false;
  }

  _statePath(type) {
    return path.join(this._persistDir, `card_list_${type}.json`);
  }

  // Loads state persisted by a previous run and swaps it into the cache
  // immediately — a day-old list beats no list while the first sync retries.
  // State that is malformed or fails its checksum is ignored, which forces a
  // full pull on the first cycle.
  loadPersisted() {
    for (const type of CARD_LIST_TYPES) {
      const p = this._statePath(type);
      try {
        if (!fs.existsSync(p)) continue;
        const data = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (!Number.isInteger(data.token) || !Array.isArray(data.cards)) {
          log(`[CardSync] WARNING - ${type}: persisted state malformed — ignoring, will full-pull`);
          continue;
        }
        if (data.checksum != null && listChecksum(data.cards) !== data.checksum) {
          log(`[CardSync] WARNING - ${type}: persisted state failed checksum — ignoring, will full-pull`);
          continue;
        }
        this._commit(type, data.token, data.checksum ?? null, new Set(data.cards), { persist: false });
        log(`[CardSync] ${type}: recovered ${data.cards.length} cards from disk (token ${data.token})`);
      } catch (e) {
        log(`[CardSync] WARNING - ${type}: failed to load persisted state: ${e.message}`);
      }
    }
  }

  // Starts the per-type sync loops: first cycle immediately, then every
  // intervalMs. Until a type's first successful sync, failures retry with
  // backoff (5s → 10s → … capped at intervalMs) so a Pi that boots before
  // the network is up catches up quickly.
  start() {
    log(`[CardSync] Syncing [${CARD_LIST_TYPES.join(', ')}] from ${this._baseUrl} every ${this._intervalMs / 1000}s`);
    for (const type of CARD_LIST_TYPES) {
      this._retryMs.set(type, CARD_SYNC_INITIAL_RETRY_MS);
      this._runCycle(type);
    }
  }

  stop() {
    this._stopped = true;
    for (const timer of this._timers.values()) clearTimeout(timer);
    this._timers.clear();
  }

  async _runCycle(type) {
    let ok = false;
    try {
      ok = await this._syncType(type);
    } catch (e) {
      log(`[CardSync] WARNING - ${type}: sync failed: ${e.message}`);
    }
    if (this._stopped) return;
    let delay = this._intervalMs;
    if (ok) {
      this._retryMs.delete(type);
    } else if (this._retryMs.has(type)) {
      delay = Math.min(this._retryMs.get(type), this._intervalMs);
      this._retryMs.set(type, delay * 2);
    }
    this._timers.set(type, setTimeout(() => this._runCycle(type), delay));
  }

  // One sync cycle for one type. Returns true when the server was reached and
  // verified state was committed (or confirmed current), false otherwise.
  async _syncType(type) {
    const st = this._state.get(type);
    if (!st) return this._fullPull(type);
    return this._deltaSync(type, st);
  }

  _get(apiPath) {
    return this._fetchJson(`${this._baseUrl}${apiPath}`, { 'x-api-key': this._apiKey });
  }

  async _fullPull(type) {
    const resp = await this._get(`/lists/${type}`);
    const cards = new Set(
      (resp.cards ?? []).map((c) => String(c).trim().toUpperCase()).filter(Boolean)
    );
    // checksum null means the university has never uploaded this type — an
    // empty list is a legitimate state, committed as non-authoritative.
    if (resp.checksum != null && listChecksum(cards) !== resp.checksum) {
      log(`[CardSync] ERROR - ${type}: full pull failed checksum verification — will retry next cycle`);
      return false;
    }
    this._commit(type, resp.token, resp.checksum ?? null, cards);
    log(`[CardSync] ${type}: full pull → ${cards.size} cards (token ${resp.token})`);
    return true;
  }

  async _deltaSync(type, st) {
    const resp = await this._get(`/lists/${type}/changes?since=${st.token}`);

    if (resp.status === 'current') {
      if (resp.checksum !== st.checksum) {
        log(`[CardSync] WARNING - ${type}: server says current but checksums differ — doing full pull`);
        return this._fullPull(type);
      }
      log(`[CardSync] ${type}: current (token ${st.token})`);
      return true;
    }

    if (resp.status === 'resync') {
      log(`[CardSync] ${type}: RESYNC requested by server — doing full pull`);
      return this._fullPull(type);
    }

    if (resp.status !== 'delta') {
      log(`[CardSync] WARNING - ${type}: unexpected status "${resp.status}" — will retry next cycle`);
      return false;
    }

    // puts/deletes are pre-collapsed to the net effect per card, so apply
    // order doesn't matter. Work on a copy — the live set is only swapped
    // after the checksum verifies.
    const cards = new Set(st.cards);
    const deletes = resp.deletes ?? [];
    const puts = resp.puts ?? [];
    for (const c of deletes) cards.delete(String(c).trim().toUpperCase());
    for (const c of puts) {
      const n = String(c).trim().toUpperCase();
      if (n) cards.add(n);
    }
    if (resp.checksum == null || listChecksum(cards) !== resp.checksum) {
      log(`[CardSync] WARNING - ${type}: checksum mismatch after applying delta — falling back to full pull`);
      return this._fullPull(type);
    }
    this._commit(type, resp.token, resp.checksum, cards);
    log(`[CardSync] ${type}: delta applied +${puts.length}/-${deletes.length} → ${cards.size} cards (token ${resp.token})`);
    return true;
  }

  // Swaps verified state into memory + the validation cache, then persists it
  // atomically (write-temp-then-rename — a power cut mid-write must not
  // corrupt the list).
  _commit(type, token, checksum, cards, { persist = true } = {}) {
    this._state.set(type, { token, checksum, cards });
    this._cache.setList(type, cards, checksum != null);
    if (!persist) return;
    try {
      const p = this._statePath(type);
      const tmp = p + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ list_type: type, token, checksum, cards: [...cards].sort() }));
      fs.renameSync(tmp, p);
    } catch (e) {
      log(`[CardSync] WARNING - ${type}: failed to persist state: ${e.message}`);
    }
  }
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

// Returns a feedback byte for the Elatec reader (FEEDBACK.VALID / FEEDBACK.INVALID),
// or null if no feedback should be sent (duplicates — reader already signalled).
async function processCard(cardNumber, devicePath, tapQueue, busNumber) {
  log(`[Process] Card from ${devicePath}: "${cardNumber}"`);

  const { valid, reason } = validateCardNumber(cardNumber);
  if (!valid) {
    log(`[Process] REJECTED - ${reason}`);
    return FEEDBACK.INVALID;
  }

  // Cooldown: ignore re-reads of the same card within the cooldown window.
  const now = Date.now();
  const lastSeen = recentCards.get(cardNumber) ?? 0;
  if (now - lastSeen < CONFIG.cardCooldownMs) {
    log(`[Process] DUPLICATE - ${cardNumber} seen ${now - lastSeen}ms ago, ignoring`);
    return null;
  }
  recentCards.set(cardNumber, now);
  // Prune entries older than the cooldown so the map doesn't grow unbounded.
  for (const [card, ts] of recentCards) {
    if (now - ts > CONFIG.cardCooldownMs) recentCards.delete(card);
  }

  log(`[Process] ACCEPTED - ${cardNumber} (${reason})`);

  const { latitude, longitude } = await fetchGps();
  const gtfsInfo = gtfsCache.getGtfsInfo();
  log(`[Process] GPS: lat=${latitude}, lon=${longitude}`);
  log(`[Process] GTFS: ${JSON.stringify(gtfsInfo)}`);

  // Check card against validation lists.
  // null = lists not configured (pass-through); false = not in any list; string = list name
  const listMatch = cardValidationCache.checkCard(cardNumber);
  const listName = typeof listMatch === 'string' ? listMatch : undefined;
  log(`[Process] Card list: ${listMatch === null ? 'validation not configured' : listMatch === false ? 'not in any list' : `found in "${listMatch}"`}`);

  tapQueue.enqueue({
    card_number: cardNumber,
    timestamp_utc: new Date().toISOString().slice(0, 19) + 'Z',
    latitude,
    longitude,
    bus_number: busNumber,
    ...(listName !== undefined ? { list_name: listName } : {}),
    ...gtfsInfo,
  });

  log(`[Process] Tap enqueued: card=${cardNumber}, bus=${busNumber}, gps=(${latitude},${longitude}), gtfs=${gtfsInfo.gtfs}${listName ? `, list=${listName}` : ''}`);

  // listMatch === false → not in any list → reject; null or string → accept
  return listMatch === false ? FEEDBACK.INVALID : FEEDBACK.VALID;
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
        if (!cardNumber) return;
        log(`>>> Card tap on ${this._devicePath}: "${cardNumber}" <<<`);
        processCard(cardNumber, this._devicePath, this._tapQueue, this._busNumber)
          .then((feedbackByte) => {
            if (feedbackByte !== null && this._port?.isOpen) {
              this._port.write(Buffer.from([feedbackByte]), (err) => {
                if (err) log(`[Serial] Feedback write error on ${this._devicePath}: ${err.message}`);
              });
            }
          })
          .catch((e) => log(`[Process] Error: ${e.message}`));
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

  const remoteConfig = await loadRemoteConfig();
  if (remoteConfig?.SERVER_URL) CONFIG.serverUrl = remoteConfig.SERVER_URL;
  if (remoteConfig?.API_KEY)    CONFIG.apiKey    = remoteConfig.API_KEY;
  if (remoteConfig?.CARD_LIST_SYNC_URL !== undefined) CONFIG.cardListSyncUrl = remoteConfig.CARD_LIST_SYNC_URL;

  if (!CONFIG.serverUrl || !CONFIG.apiKey) {
    log('FATAL: SERVER_URL and API_KEY not available — check S3 config or add them to .env');
    process.exit(1);
  }

  const cardLists = remoteConfig?.CARD_LISTS ?? (() => {
    // Fall back to CARD_LIST_<NAME> env vars (e.g. CARD_LIST_YOUTH, CARD_LIST_STUDENT)
    const lists = {};
    for (const [key, val] of Object.entries(process.env)) {
      if (key.startsWith('CARD_LIST_') && val) {
        lists[key.slice('CARD_LIST_'.length).toLowerCase()] = val;
      }
    }
    return Object.keys(lists).length > 0 ? lists : null;
  })();

  let cardListSync = null;
  if (cardLists) {
    // Legacy static-URL lists (CARD_LISTS / CARD_LIST_*) take precedence when
    // explicitly configured — remove them from the fleet config to use sync.
    log('[CardLists] Loading card validation lists...');
    await cardValidationCache.load(cardLists);
  } else if (CONFIG.cardListSyncUrl && String(CONFIG.cardListSyncUrl).toLowerCase() !== 'off') {
    cardListSync = new CardListSyncClient({
      baseUrl: CONFIG.cardListSyncUrl,
      apiKey: CONFIG.apiKey,
      persistDir: APP_DIR,
      intervalMs: CONFIG.cardListSyncIntervalMs,
      cache: cardValidationCache,
    });
    cardListSync.loadPersisted();
    cardListSync.start();
  } else {
    log('[CardLists] No card lists configured — running in pass-through mode (all valid cards accepted)');
  }

  log(`Config: server=${CONFIG.serverUrl}, baud=${CONFIG.serialBaud}, batch_interval=${CONFIG.batchIntervalMs / 1000}s`);

  // Start static GTFS download in the background — enriches stop data for trip tracking.
  gtfsStaticCache.ensureLoaded();

  const busNumber = await fetchVehicleId();

  const persistPath = path.join(APP_DIR, 'tap_queue.json');
  const tapQueue = new TapQueue(CONFIG.maxQueueSize, persistPath);

  // Start proactive GTFS-RT polling so stop info is ready before any tap occurs.
  gtfsCache.startPolling(busNumber, tapQueue);

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
    gtfsCache.stopPolling();
    cardListSync?.stop();
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

  log('=== piTaps App Running ===');
}

module.exports = {
  listChecksum,
  CardListSyncClient,
  CardValidationCache,
  CARD_LIST_TYPES,
};

if (require.main === module) {
  main().catch((err) => {
    log(`FATAL: ${err.message}`);
    process.exit(1);
  });
}
