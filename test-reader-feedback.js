'use strict';

/**
 * Elatec reader LED/buzzer feedback probe
 *
 * Run on the Pi: node test-reader-feedback.js [/dev/ttyACM0]
 *
 * Tap a card when prompted. After each tap, this script fires several
 * candidate command sequences and logs every byte received in response.
 * Observe the reader physically — any LED change or beep tells us which
 * sequence the firmware accepts.
 *
 * Add your own sequences to CANDIDATES if you have the DevPack docs.
 */

const { SerialPort } = require('serialport');

const devicePath = process.argv[2] || '/dev/ttyACM0';
const BAUD = 9600;

// ---------------------------------------------------------------------------
// Candidate command sequences to probe
//
// Each entry has:
//   name  – human-readable label shown in output
//   bytes – Buffer to write to the serial port
//
// Sources / basis:
//   - Elatec.NET open-source .NET wrapper (github.com/c3rebro/Elatec.NET)
//   - elatec-twn4-simple Rust crate (github.com/thenewwazoo/elatec-twn4-simple)
//   - Elatec TWN3/TWN4 manuals (manualslib)
//
// NOTE: Without the official Elatec DevPack documentation the exact bytes
// for your firmware version are not confirmed. Treat these as starting
// points — any that work physically are the right ones; the rest are
// inert/ignored by the reader.
// ---------------------------------------------------------------------------

const CANDIDATES = [
  // --- ASCII attempts ---------------------------------------------------
  // Some Elatec firmwares accept simple ASCII token commands.
  { name: 'ASCII: "BEEP\\r"',       bytes: Buffer.from('BEEP\r') },
  { name: 'ASCII: "LED_GREEN\\r"',  bytes: Buffer.from('LED_GREEN\r') },
  { name: 'ASCII: "LED_RED\\r"',    bytes: Buffer.from('LED_RED\r') },

  // --- SimpleProtocol binary attempts ----------------------------------
  // TWN4 SimpleProtocol framing (inferred from Elatec.NET source):
  //   [STX=0x02] [length] [cmd_id] [...params] [ETX=0x03]
  //   or just [cmd_id][param_byte] with no framing in some firmware builds.
  //
  // Beep  (success tone — short beep):
  { name: 'SP: beep cmd 0x01',    bytes: Buffer.from([0x01, 0x01]) },
  // Beep  (error tone — double/long):
  { name: 'SP: beep cmd 0x01 x2', bytes: Buffer.from([0x01, 0x02]) },
  // LED green on:
  { name: 'SP: LED green 0x10',   bytes: Buffer.from([0x10, 0x01]) },
  // LED red on:
  { name: 'SP: LED red 0x11',     bytes: Buffer.from([0x11, 0x01]) },
  // LED off:
  { name: 'SP: LED off 0x10/00',  bytes: Buffer.from([0x10, 0x00]) },

  // --- STX-framed attempts (alternative framing) ----------------------
  // [0x02][cmd][data...][0x03]
  { name: 'STX green+beep',
    bytes: Buffer.from([0x02, 0x06, 0x00, 0x01, 0x03]) },
  { name: 'STX red+beep',
    bytes: Buffer.from([0x02, 0x06, 0x00, 0x02, 0x03]) },

  // --- Null / reset ---------------------------------------------------
  { name: 'Single 0x00',          bytes: Buffer.from([0x00]) },
  { name: 'Single CR (0x0D)',     bytes: Buffer.from([0x0D]) },
];

const DELAY_BETWEEN_MS = 1_200; // pause between sequences so you can observe each one

// ---------------------------------------------------------------------------

const port = new SerialPort({ path: devicePath, baudRate: BAUD, autoOpen: false });

port.on('data', (chunk) => {
  const hex = chunk.toString('hex').replace(/(..)/g, '$1 ').trim();
  const asc = chunk.toString('ascii').replace(/[^\x20-\x7e]/g, '.');
  console.log(`  [RX] hex: ${hex}   ascii: "${asc}"`);
});

port.on('error', (e) => console.error(`[ERROR] ${e.message}`));

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

async function runSequences() {
  console.log(`\n--- Starting probe (${CANDIDATES.length} sequences, ${DELAY_BETWEEN_MS}ms apart) ---\n`);
  for (const { name, bytes } of CANDIDATES) {
    const hex = bytes.toString('hex').replace(/(..)/g, '$1 ').trim();
    process.stdout.write(`[TX] ${name.padEnd(30)} hex: ${hex.padEnd(20)} — `);
    await new Promise((res, rej) => port.write(bytes, (err) => (err ? rej(err) : res())));
    await sleep(DELAY_BETWEEN_MS);
    console.log(); // newline after any RX that printed on same "line"
  }
  console.log('\n--- Probe complete. Check above for [RX] lines and physical reader response. ---');
  console.log('Waiting for another card tap to probe again (Ctrl-C to exit)...\n');
}

// Parse incoming bytes looking for a card-tap line (CR-terminated)
let lineBuffer = '';
let probing = false;

port.on('data', (chunk) => {
  lineBuffer += chunk.toString('ascii');
  let cr;
  while ((cr = lineBuffer.indexOf('\r')) !== -1) {
    const line = lineBuffer.slice(0, cr).trim();
    lineBuffer = lineBuffer.slice(cr + 1);
    if (line) {
      console.log(`\n>>> Card tap detected: "${line}" <<<`);
      if (!probing) {
        probing = true;
        runSequences().catch((e) => console.error(`[ERROR] ${e.message}`)).finally(() => { probing = false; });
      }
    }
  }
});

port.open((err) => {
  if (err) {
    console.error(`Failed to open ${devicePath}: ${err.message}`);
    console.error('Make sure the reader is connected and no other process has the port open.');
    console.error(`Usage: node test-reader-feedback.js [/dev/ttyACM0]`);
    process.exit(1);
  }
  console.log(`Opened ${devicePath} at ${BAUD} baud`);
  console.log('Tap a card on the reader to begin the probe sequence.');
  console.log('All received bytes will be shown as [RX] lines.');
  console.log('Observe the reader LED and buzzer for each [TX] line.\n');
});

process.on('SIGINT', () => {
  console.log('\nExiting.');
  port.close();
  process.exit(0);
});
