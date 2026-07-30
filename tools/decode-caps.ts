// Decode the capability reply out of a capture file, including from appliances whose frames
// decodePacket() will not touch.
//
// LOCAL TOOL — not for upstream.
//
// Why it exists: util/packet-codec only recognises kind 0x87 for fromDevice, so a frame marked
// 0xa7 (PAC_910604_WW, and per the measured distribution 0xa7 is that appliance's normal state
// kind) is stored as protocol:'unknown' with the hex intact. This parses the TLV payload straight
// out of the raw frame, which is also how the 2026-07-30 re-verification was done:
//
//   [0,1] prefix | [2..6] 04 00 00 00 <kind> | [7] byte5 | [8] byte6 | [9] byte7 | [10] len
//   payload = buf[11 .. 11+len)   then 2 CRC bytes
//
// Usage:
//   tsx tools/decode-caps.ts <capture.jsonl> [more.jsonl ...]

import * as fs from 'node:fs'
import * as TLV from '@/util/tlv'

const TAG_CAPS_KEY = 0x2da
const INTERESTING = [0x2c1, 0x2c2, 0x2d7, TAG_CAPS_KEY, 0x2e1, 0x2e2, 0x2e3, 0x2e4, 0x2e5, 0x2ec, 0x2f1]
const BITMASKS = [0x2c1, 0x2c2]

function parseFrame(hex: string) {
    const buf = Buffer.from(hex, 'hex')
    const len = buf[10]
    let tlv: TLV.TLV[] = []
    let err: string | undefined
    try {
        tlv = TLV.parse(buf.subarray(11, 11 + len))
    } catch (e) {
        err = e instanceof Error ? e.message : String(e)
    }
    return { kind: buf[6], declared: 11 + len + 2, actual: buf.length, tlv, err }
}

const files = process.argv.slice(2)
if (!files.length) {
    console.error('Usage: tsx tools/decode-caps.ts <capture.jsonl> [more.jsonl ...]')
    process.exit(1)
}

for (const file of files) {
    console.log(`\n=========== ${file} ===========`)
    const records = fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as { k?: string; dir?: string; hex?: string; injected?: boolean })

    const fromDevice = records.filter((r) => r.k === 'wire' && r.dir === 'fromDevice' && typeof r.hex === 'string')
    const caps = fromDevice
        .map((r) => ({ hex: r.hex as string, injected: r.injected, ...parseFrame(r.hex as string) }))
        .filter((f) => f.tlv.some((x) => x.t === TAG_CAPS_KEY))

    console.log(`fromDevice frames: ${fromDevice.length} | replies containing 0x2da: ${caps.length}`)
    if (!caps.length) continue

    const distinct = new Set(caps.map((f) => JSON.stringify(f.tlv.map((x) => [x.t, x.v]))))
    console.log(`distinct payloads: ${distinct.size} (repeats are the same read answered again)`)

    const f = caps[0]
    const lengthOk = f.declared === f.actual
    console.log(
        `frame: ${f.actual} bytes, kind=0x${f.kind.toString(16)}, TLVs=${f.tlv.length}, ` +
            `length check ${lengthOk ? 'OK' : `FAILED (declares ${f.declared}) — TRUNCATED, do not use`}` +
            (f.err ? `, parse error: ${f.err}` : ''),
    )

    for (const t of INTERESTING) {
        const hits = f.tlv.filter((x) => x.t === t)
        if (!hits.length) continue
        const bits = BITMASKS.includes(t)
            ? '   bits: ' +
              hits
                  .map((h) =>
                      Array.from({ length: 32 }, (_, b) => b)
                          .filter((b) => (h.v >>> b) & 1)
                          .join(','),
                  )
                  .join(' | ')
            : ''
        console.log(`  0x${t.toString(16)} = ${hits.map((h) => h.v).join(' | ')}${bits}`)
    }

    const rest = f.tlv.filter((x) => !INTERESTING.includes(x.t)).map((x) => `0x${x.t.toString(16)}=${x.v}`)
    console.log(`  other tags: ${rest.join('  ')}`)
}
