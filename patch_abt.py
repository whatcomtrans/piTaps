"""
Patches the embedded C source in TWN4_xCx507_STD207_Multi_CDC_Standard.abt.

The .abt stores C source at byte offset 765970. AppBlaster reads exactly 4178
bytes from that offset, so the replacement must be EXACTLY 4178 bytes. We
remove ornamental comment blocks to free space for the new host-response code.

Modification: main() sends the card number to the host, waits up to 1500ms
for 'G' (green/valid) or 'R' (red/invalid), then shows the appropriate LED
and plays the appropriate beep. Variable declarations placed at block start
for C89 compatibility.

Usage:
    python patch_abt.py [--dry-run]
"""

import sys
import os
import shutil

ABT = os.path.join(os.path.dirname(__file__),
                   "DevPack", "TWN4DevPack507", "Templates",
                   "TWN4_xCx507_STD207_Multi_CDC_Standard.abt")

C_SOURCE_OFFSET = 765970
C_SOURCE_LENGTH = 4178   # AppBlaster reads exactly this many bytes

# Complete modified C source (LF line endings — converted to CRLF below).
# Ornamental comment blocks removed to make room for the host-response code.
# 'resp' declared at start of its block for C89 compatibility.
MODIFIED_C_LF = """\
#include "twn4.sys.h"
#include "apptools.h"

#if APPEXTCONFIG

#include "appconfig.h"

#else

//#define LFTAGTYPES      (TAGMASK(LFTAG_EM4102) | TAGMASK(LFTAG_HITAG1S))
//#define HFTAGTYPES      (TAGMASK(HFTAG_MIFARE))

#ifndef CONFIGENABLED
  #define CONFIGENABLED         SUPPORT_CONFIGCARD_OFF
#endif

#define CARDTIMEOUT\t\t\t\t2000UL
#define MAXCARDIDLEN            32
#define MAXCARDSTRINGLEN\t\t128

bool ReadCardData(int TagType,const byte* ID,int IDBitCnt,char *CardString,int MaxCardStringLen)
{
\tbyte CardData[32];
\tint CardDataBitCnt;
    CardDataBitCnt = MIN(IDBitCnt,sizeof(CardData)*8);
    CopyBits(CardData,0,ID,0,CardDataBitCnt);
    ConvertBinaryToString(CardData,0,CardDataBitCnt,CardString,16,(CardDataBitCnt+7)/8*2,MaxCardStringLen);
    return true;
}

void OnStartup(void)
{
    LEDInit(REDLED | GREENLED);
    LEDOn(GREENLED);
    LEDOff(REDLED);
    SetVolume(30);
    BeepLow();
    BeepHigh();
#if defined(SUPPORT_HIDMOBILE)
    unsigned int LFTagTypes, HFTagTypes;
    GetSupportedTagTypes(&LFTagTypes, &HFTagTypes);
    if (HFTagTypes & (TAGMASK(HFTAG_BLE)))
    {
        SetTagTypes(NOTAG, TAGMASK(HFTAG_HIDICLASS) | TAGMASK(HFTAG_BLE));
        if (!BLEInit(BLE_MODE_HID_MOBILE_ACCESS))
        {
            BeepLow();
            BeepLow();
        }
    }
    else
    {
        SetTagTypes(NOTAG, TAGMASK(HFTAG_HIDICLASS));
    }
#endif
}

void OnNewCardFound(const char *CardString)
{
    HostWriteString(CardString);
    HostWriteString("\\r");
    LEDOff(GREENLED);
    LEDOn(REDLED);
    LEDBlink(REDLED,500,500);
    SetVolume(100);
    BeepHigh();
}

void OnCardTimeout(const char *CardString)
{
    LEDOn(GREENLED);
    LEDOff(REDLED);
}

void OnCardDone(void)
{
}

#endif

int main(void)
{
\tOnStartup();

\tconst byte Params[] = { SUPPORT_CONFIGCARD, 1, CONFIGENABLED, TLV_END };
\tSetParameters(Params,sizeof(Params));

#if defined(LFTAGTYPES) && defined(HFTAGTYPES)
\tSetTagTypes(LFTAGTYPES,HFTAGTYPES);
#endif

#if defined(SUPPORT_HIDMOBILE)
\tconst byte ParamsHIDMobile[] = { CUSTOM_OPT_1, 1, CUSTOM_OPT_1_ON, ICLASS_READMODE, 1, ICLASS_READMODE_PAC, TLV_END };
\tSetParameters(ParamsHIDMobile,sizeof(ParamsHIDMobile));
#endif

\tchar OldCardString[MAXCARDSTRINGLEN+1];
    OldCardString[0] = 0;

    while (true)
    {
\t\tint TagType;
\t\tint IDBitCnt;
\t\tbyte ID[32];

\t    if (SearchTag(&TagType,&IDBitCnt,ID,sizeof(ID)))
\t    {
\t\t\tchar NewCardString[MAXCARDSTRINGLEN+1];
\t\t\tif (ReadCardData(TagType,ID,IDBitCnt,NewCardString,sizeof(NewCardString)-1))
\t\t\t{
\t\t\t\tif (strcmp(NewCardString,OldCardString) != 0)
\t\t\t\t{
\t\t\t\t\tbyte resp = 0;
\t\t\t\t\tstrcpy(OldCardString,NewCardString);
\t\t\t\t\tHostWriteString(NewCardString);
\t\t\t\t\tHostWriteString("\\r");
\t\t\t\t\tStartTimer(1500UL);
\t\t\t\t\twhile (!TestTimer())
\t\t\t\t\t{
\t\t\t\t\t\tif (HostTestByte())
\t\t\t\t\t\t{
\t\t\t\t\t\t\tresp = HostReadByte();
\t\t\t\t\t\t\tbreak;
\t\t\t\t\t\t}
\t\t\t\t\t}
\t\t\t\t\tif (resp == 'G')
\t\t\t\t\t{
\t\t\t\t\t\tLEDOff(REDLED);
\t\t\t\t\t\tLEDOn(GREENLED);
\t\t\t\t\t\tSetVolume(100);
\t\t\t\t\t\tBeepHigh();
\t\t\t\t\t}
\t\t\t\t\telse if (resp == 'R')
\t\t\t\t\t{
\t\t\t\t\t\tLEDOff(GREENLED);
\t\t\t\t\t\tLEDOn(REDLED);
\t\t\t\t\t\tLEDBlink(REDLED,200,200);
\t\t\t\t\t\tSetVolume(100);
\t\t\t\t\t\tBeepLow();
\t\t\t\t\t\tBeepLow();
\t\t\t\t\t}
\t\t\t\t\telse
\t\t\t\t\t{
\t\t\t\t\t\tLEDOff(GREENLED);
\t\t\t\t\t\tLEDOn(REDLED);
\t\t\t\t\t\tLEDBlink(REDLED,500,500);
\t\t\t\t\t\tSetVolume(100);
\t\t\t\t\t\tBeepHigh();
\t\t\t\t\t}
\t\t\t\t}
\t\t\t   \tStartTimer(CARDTIMEOUT);
\t\t\t}
\t\t\tOnCardDone();
\t    }

        if (TestTimer())
        {
\t\t    OnCardTimeout(OldCardString);
\t\t    OldCardString[0] = 0;
        }
    }
}
"""

DRY_RUN = "--dry-run" in sys.argv

# Convert to CRLF bytes (matching the original .abt encoding)
c_bytes = MODIFIED_C_LF.replace("\r\n", "\n").replace("\n", "\r\n").encode("ascii")

print(f"Modified C source: {len(c_bytes)} bytes (target: {C_SOURCE_LENGTH})")

if len(c_bytes) > C_SOURCE_LENGTH:
    print(f"ERROR: Modified C source is {len(c_bytes) - C_SOURCE_LENGTH} bytes too large.")
    print("Remove more comments or whitespace to fit within 4178 bytes.")
    sys.exit(1)

# Pad to exactly 4178 bytes by appending a blank line of spaces.
# The source already ends with \r\n; we add (pad-2) spaces + \r\n as a trailing line.
pad = C_SOURCE_LENGTH - len(c_bytes)
if pad > 0:
    if pad < 2:
        print(f"ERROR: only {pad} bytes of headroom — need at least 2 for a trailing \\r\\n.")
        sys.exit(1)
    c_bytes = c_bytes + b" " * (pad - 2) + b"\r\n"
    print(f"Padded with a {pad}-byte trailing line to reach exactly {C_SOURCE_LENGTH} bytes.")

assert len(c_bytes) == C_SOURCE_LENGTH, f"BUG: length is {len(c_bytes)}, expected {C_SOURCE_LENGTH}"

if DRY_RUN:
    print("\nDry run — no files written.")
    print("\n--- Modified C source ---")
    print(c_bytes.decode("ascii", errors="replace"))
    sys.exit(0)

# Read the original .abt (use the .bak if it exists, otherwise the current file)
bak = ABT + ".bak"
src = bak if os.path.exists(bak) else ABT
data = open(src, "rb").read()

print(f"\nReading from: {src} ({len(data)} bytes)")

if not os.path.exists(bak):
    shutil.copy2(ABT, bak)
    print(f"Backup written: {bak}")

patched = data[:C_SOURCE_OFFSET] + c_bytes + data[C_SOURCE_OFFSET + C_SOURCE_LENGTH:]
assert len(patched) == len(data), f"BUG: patched size {len(patched)} != original {len(data)}"

with open(ABT, "wb") as f:
    f.write(patched)

print(f"Patched file written: {ABT} ({len(patched)} bytes)")
print("\nDone. Open AppBlaster, load the .abt, set your Transact config, and Create Image.")
