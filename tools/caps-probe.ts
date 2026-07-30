// Ask an appliance a read-only question and have the answer land in a capture file.
//
// LOCAL TOOL — not for upstream. It exists because neither existing path does the job:
//   - tools/rethink-capture.ts records but never sends.
//   - The monitor page's send1 box sends but writes no file.
//   - Doing both from two sockets is misleading: management/index.ts keeps `injectFlag`
//     per WebSocket connection, so frames caused by the OTHER socket are recorded as
//     injected:false. One socket doing both is the only honest arrangement.
//
// Only READ queries are allowed, and the frame is built with the repo's own encoder and
// compared against a known-good hex before anything is sent:
//   caps   {0x1f5: 1}  capabilities  — what TLVDevice sends in its constructor on every connect
//   values {0x1f5: 2}  values dump   — what TLVDevice.query() sends periodically
// Anything else is refused. Nothing here writes device state.
//
// Usage:
//   tsx tools/caps-probe.ts [--query caps|values] <mgmt-host[:port]> <device-uuid> <out.jsonl> [seconds]
//
// Note on reading the result: decodePacket() only accepts kind 0x87 for fromDevice, so
// appliances that mark frames 0xa7 (e.g. PAC_910604_WW) land as protocol:'unknown' with the
// hex intact — decode those with tools/decode-caps.ts.

import WebSocket from 'ws'
import * as fs from 'node:fs'
import { decodePacket, encodePacket } from '@/util/packet-codec'

// `reference` is a frame captured byte-for-byte from a real session; the encoder output must match
// it or we refuse to transmit. The values query has NO reference: `{0x1f5: 2}` appears zero times in
// the four capture files (only rethink itself sends it, on its own timer), so there is nothing to
// compare against — it is built by the same encoder path that reproduced the caps frame exactly,
// and the tool says so out loud instead of pretending it is verified.
const QUERIES = {
    caps: { tlv: [{ t: 0x1f5, v: 1 }], reference: '01010400000065020201027d416a0d' },
    values: { tlv: [{ t: 0x1f5, v: 2 }], reference: undefined },
} as const

let query: keyof typeof QUERIES = 'caps'
const positionals: string[] = []
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--query') query = argv[++i] as keyof typeof QUERIES
    else if (a.startsWith('--query=')) query = a.slice('--query='.length) as keyof typeof QUERIES
    else positionals.push(a)
}
const [hostArg, deviceId, outArg, secsArg] = positionals
if (!hostArg || !deviceId || !outArg || !QUERIES[query]) {
    console.error(
        'Usage: tsx tools/caps-probe.ts [--query caps|values] <mgmt-host[:port]> <device-uuid> <out.jsonl> [seconds]',
    )
    process.exit(1)
}
const host = hostArg.includes(':') ? hostArg : `${hostArg}:44401`
const seconds = Number(secsArg ?? 30)

const built = encodePacket({ protocol: 'tlv', direction: 'toDevice', a: 1, s: 1, tlv: [...QUERIES[query].tlv] })
const reference = QUERIES[query].reference
if (reference) {
    console.error(`${query} query built: ${built.hex} (matches captured reference: ${built.hex === reference})`)
    if (built.hex !== reference) {
        console.error('REFUSING TO SEND: encoder output differs from the captured frame — investigate first')
        process.exit(1)
    }
} else {
    console.error(`${query} query built: ${built.hex}`)
    console.error('WARNING: no captured reference frame exists for this query — encoder-built only, unverified')
}

const stream = fs.createWriteStream(outArg, { flags: 'a' })
function emit(event: object) {
    stream.write(JSON.stringify({ ts: Date.now(), ...event }) + '\n')
}

function record(dir: 'fromDevice' | 'toDevice', raw: string, injected: boolean) {
    if (!/^[0-9a-fA-F]*$/.test(raw)) return emit({ k: 'wire', dir, injected, raw })
    const d = decodePacket(raw)
    if (d.protocol === 'tlv')
        emit({ k: 'wire', dir, injected, hex: raw, protocol: 'tlv', crcOk: d.crcOk, frame: d.frame, tlv: d.tlv })
    else if (d.protocol === 'aabb')
        emit({ k: 'wire', dir, injected, hex: raw, protocol: 'aabb', checksumOk: d.checksumOk, body: d.body })
    else emit({ k: 'wire', dir, injected, hex: raw, protocol: 'unknown' })
}

emit({ k: 'session', v: 1, deviceId, tool: `caps-probe/0.2 (${query})` })

const ws = new WebSocket(`ws://${host}/device?id=${encodeURIComponent(deviceId)}`)
let sent = false
let answered = false

ws.on('open', () => emit({ k: 'marker', phase: 'connected' }))

ws.on('message', (data: WebSocket.RawData) => {
    let msg: { rx?: string; tx?: string; injected?: boolean; status?: string; meta?: unknown }
    try {
        msg = JSON.parse(data.toString())
    } catch {
        return
    }

    if (typeof msg.rx === 'string') {
        record('fromDevice', msg.rx, !!msg.injected)
        const d = decodePacket(msg.rx)
        if (d.protocol === 'tlv' && d.tlv.some((x) => x.t === 0x2da)) {
            answered = true
            console.error('caps response received (0x2da present)')
        }
        return
    }
    if (typeof msg.tx === 'string') return record('toDevice', msg.tx, !!msg.injected)

    if (msg.status) {
        emit({ k: 'marker', phase: msg.status, meta: msg.meta })
        if (msg.status !== 'online' || sent) return
        sent = true
        // The reply arrives on the device's 'data' event, after injectFlag has been reset, so the
        // server will label it injected:false. Say so in the file rather than letting a later
        // reader take that as "the device volunteered this".
        emit({
            k: 'note',
            author: 'caps-probe',
            text:
                `injected ${query} query ${built.hex} from THIS socket (read-only; identical to what ` +
                `TLVDevice sends itself). Any reply below is SOLICITED BY THIS INJECTION even though the ` +
                `server labels it injected:false — injectFlag is per-socket and resets before the reply lands.`,
        })
        // management/index.ts wants a BINARY frame whose payload is JSON. Sending the raw frame
        // bytes makes its JSON.parse throw and the injection is dropped with no error at all.
        ws.send(Buffer.from(JSON.stringify({ sendToDevice: built.hex })))
        console.error('query sent')
    }
})

ws.on('error', (err) => {
    console.error('WebSocket error:', err.message)
    emit({ k: 'marker', phase: 'ws-error', reason: err.message })
    stream.end(() => process.exit(1))
})

setTimeout(() => {
    emit({ k: 'marker', phase: 'stopped' })
    console.error(answered ? 'done: caps reply captured' : 'done: no caps reply seen (0x2da absent)')
    ws.close()
    stream.end(() => process.exit(answered ? 0 : 2))
}, seconds * 1000)
