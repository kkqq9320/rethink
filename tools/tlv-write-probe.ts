// Send ONE single-TLV write to an appliance and record the appliance's own answer.
//
// LOCAL TOOL — not for upstream, and not a general packet cannon.
//
// Why it exists: tools/caps-probe.ts deliberately refuses anything but a read, and
// tools/packet-sender.ts goes over MQTT and writes no capture file. To test a *settable*
// value that the app cannot reach (e.g. a mode the appliance lists in its own
// (0x2d7,0x2d8,0x2d9) table but does not offer in the UI), the write and the recording
// have to happen on ONE management WebSocket: management/index.ts keeps `injectFlag` per
// connection, so a second socket's frames would be logged as injected:false — dishonest.
//
// Discipline, borrowed from caps-probe.ts:
//   * --reference <hex> is a frame captured byte-for-byte from a real session. The tool
//     re-encodes it from its own decoded (tag,value) and REFUSES TO SEND unless the
//     rebuild matches the reference exactly. That proves the encoder path before any
//     novel value goes out on the wire.
//   * --confirm-write is mandatory. Without it the tool prints the frame and exits.
//   * --restore <value> sends a second write after --settle seconds, so an experiment
//     that moves the appliance puts it back where it was.
//
// Usage:
//   tsx tools/tlv-write-probe.ts --tag 0x1f9 --value 22 --reference 01010400000065020100037e505681c8 \
//       [--restore 86] [--settle 20] [--seconds 60] [--confirm-write] <mgmt-host[:port]> <uuid> <out.jsonl>
//
// --tag/--value (and --restore) may be repeated to put SEVERAL TLVs in ONE frame:
//   --tag 0x3e0 --value 4 --tag 0x21e --value 1   ->  one frame carrying both

import WebSocket from 'ws'
import * as fs from 'node:fs'
import * as TLV from '@/util/tlv'
import crc16 from '@/util/crc16'

const tags: number[] = []
const values: number[] = []
const restores: number[] = []
let reference: string | undefined
let settle = 20
let seconds = 60
let confirmed = false
const positionals: string[] = []
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--tag') tags.push(Number(argv[++i]))
    else if (a === '--value') values.push(Number(argv[++i]))
    else if (a === '--restore') restores.push(Number(argv[++i]))
    else if (a === '--reference') reference = argv[++i]
    else if (a === '--settle') settle = Number(argv[++i])
    else if (a === '--seconds') seconds = Number(argv[++i])
    else if (a === '--confirm-write') confirmed = true
    else positionals.push(a)
}
const [hostArg, deviceId, outArg] = positionals
if (!tags.length || tags.length !== values.length || !hostArg || !deviceId || !outArg) {
    console.error(
        'Usage: tsx tools/tlv-write-probe.ts --tag 0xNNN --value N [--restore N] [--reference <hex>]\n' +
            '           [--settle 20] [--seconds 60] [--confirm-write] <mgmt-host[:port]> <uuid> <out.jsonl>',
    )
    process.exit(1)
}

// The write envelope, taken from frames the LG app itself sent to this appliance:
//   01 01 | 04 00 00 00 | 65 | 02 | 01 | 00 | len | <tlv> | crc16
const PREFIX = [0x01, 0x01]
const ENVELOPE = [0x04, 0x00, 0x00, 0x00, 0x65, 0x02, 0x01, 0x00]

/*
 * One frame, however many TLVs. --tag/--value may be repeated, which is how the "does this
 * appliance accept a multi-TLV write at all?" question gets asked: RAC_056905_WW's
 * write_attach produces that shape routinely, but a given appliance may never have been sent
 * one.
 */
function buildWrite(pairs: Array<{ t: number; v: number }>): Buffer {
    const tlv = TLV.build(pairs)
    const body = ENVELOPE.concat([tlv.length], tlv)
    const crc = crc16(body)
    return Buffer.from(PREFIX.concat(body, [crc >> 8, crc & 0xff]))
}

// --- encoder self-check against a real captured frame -------------------------------
if (reference) {
    const ref = Buffer.from(reference, 'hex')
    const refTlv = TLV.parse(ref.subarray(11, 11 + ref[10]))
    if (refTlv.length !== 1) {
        console.error(`reference must be a single-TLV write frame; it decodes to ${refTlv.length} TLVs`)
        process.exit(1)
    }
    const rebuilt = buildWrite([{ t: refTlv[0].t, v: refTlv[0].v }])
    const ok = rebuilt.toString('hex') === ref.toString('hex')
    console.error(
        `reference : ${ref.toString('hex')}  (0x${refTlv[0].t.toString(16)}=${refTlv[0].v})\n` +
            `rebuilt   : ${rebuilt.toString('hex')}  ${ok ? 'MATCH ✓' : 'MISMATCH ✗'}`,
    )
    if (!ok) {
        console.error('encoder does not reproduce the reference frame — refusing to send anything')
        process.exit(1)
    }
} else {
    console.error('WARNING: no --reference given, so the encoder path is unverified for this appliance.')
}

const describe = (vals: number[]) => tags.map((t, i) => `0x${t.toString(16)}=${vals[i]}`).join(' ')
const frame = buildWrite(tags.map((t, i) => ({ t, v: values[i] })))
console.error(`frame to send: ${frame.toString('hex')}   (${describe(values)}, ${tags.length} TLV)`)
if (restores.length === tags.length) {
    const restoreFrame = buildWrite(tags.map((t, i) => ({ t, v: restores[i] })))
    console.error(`restore frame: ${restoreFrame.toString('hex')}   (${describe(restores)})`)
}
if (!confirmed) {
    console.error('\n--confirm-write not given: nothing was sent. Re-run with --confirm-write to transmit.')
    process.exit(0)
}

// --- one socket: send and record ----------------------------------------------------
const host = hostArg.includes(':') ? hostArg : `${hostArg}:44401`
const stream = fs.createWriteStream(outArg, { flags: 'a' })
const emit = (event: object) => stream.write(JSON.stringify({ ts: Date.now(), ...event }) + '\n')
emit({ k: 'session', v: 1, deviceId, tool: 'tlv-write-probe/0.2', tags, values, restores, reference })

const ws = new WebSocket(`ws://${host}/device?id=${encodeURIComponent(deviceId)}`)

function send(buf: Buffer, label: string) {
    // management/index.ts expects a BINARY frame whose payload is JSON: {"sendToDevice":"<hex>"}
    ws.send(Buffer.from(JSON.stringify({ sendToDevice: buf.toString('hex') })))
    emit({ k: 'note', author: 'tool', text: `injected ${label}: ${buf.toString('hex')}` })
    console.error(`sent ${label}: ${buf.toString('hex')}`)
}

ws.on('open', () => {
    emit({ k: 'marker', phase: 'connected' })
    setTimeout(() => send(frame, 'probe'), 1500)
    if (restores.length === tags.length) {
        const restoreFrame = buildWrite(tags.map((t, i) => ({ t, v: restores[i] })))
        setTimeout(() => send(restoreFrame, 'restore'), 1500 + settle * 1000)
    }
    setTimeout(() => {
        emit({ k: 'marker', phase: 'stopped' })
        stream.end(() => process.exit(0))
    }, seconds * 1000)
})

ws.on('message', (data: WebSocket.RawData) => {
    let msg: any
    try {
        msg = JSON.parse(data.toString())
    } catch {
        return
    }
    if (typeof msg.rx === 'string') emit({ k: 'wire', dir: 'fromDevice', injected: !!msg.injected, hex: msg.rx })
    else if (typeof msg.tx === 'string') emit({ k: 'wire', dir: 'toDevice', injected: !!msg.injected, hex: msg.tx })
    else if (msg.status) emit({ k: 'marker', phase: msg.status, meta: msg.meta })
})

ws.on('error', (err) => {
    console.error(`WebSocket error: ${err.message}`)
    process.exit(1)
})
