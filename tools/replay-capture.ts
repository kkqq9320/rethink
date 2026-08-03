// Replay a capture file through a real device handler and print everything it would have published.
//
// LOCAL TOOL — not for upstream.
//
// Why it exists: unit tests only cover the cases a fixture happens to contain. Feeding a whole capture
// through the handler covers every frame the appliance actually sent, and it caught a defect the FX___S
// tests had missed - twelve records carrying a zero course byte, which were being registered as a
// selectable "#0" course. Worth running after writing or changing any device profile.
//
// It also answers the question that matters before reading any new frame family: "frames sent" must stay
// at 0 for a read-only replay. A handler that answers the appliance shows up here as a non-zero count.
//
// Usage:
//   tsx tools/replay-capture.ts <capture.jsonl> [more.jsonl ...]
//
// The model is taken from the capture's own `status: online` line (the capture tool records the metadata
// there), so no argument is needed. Handlers have to be listed below - this is deliberately explicit
// rather than resolved out of ha_bridge, which does not export its registry.

import * as fs from 'node:fs'
import { setFilter } from '@/util/logging'
import { MockHAConnection, MockThinq2Device } from '@/tests/helpers/mocks'
import type { Metadata } from '@/cloud/thinq'
import FX___S from '@/cloud/devices/FX___S'
import PAC_910604_WW from '@/cloud/devices/PAC_910604_WW'
import RAC_056905_WW from '@/cloud/devices/RAC_056905_WW'
import DHUM_231006_WW from '@/cloud/devices/DHUM_231006_WW'

// Importing the test mocks silences device logging as a side effect; a replay is exactly when those
// lines are wanted, so put them back.
setFilter(() => true)

const HANDLERS: Record<string, new (HA: never, thinq: never, meta: Metadata) => object> = {
    FX___S,
    PAC_910604_WW,
    RAC_056905_WW,
    DHUM_231006_WW,
} as unknown as Record<string, new (HA: never, thinq: never, meta: Metadata) => object>

const ID = 'replay'

/*
 * Two capture schemas exist and both are on disk:
 *   the older one, one line per frame:      {status, meta, rx|tx}
 *   tools/rethink-capture.ts's:             {k:'wire', dir:'fromDevice'|'toDevice', hex}
 *                                           {k:'marker', phase:'online', meta}
 * normalise() flattens the second onto the first so the replay below only sees one shape.
 */
type Line = {
    t?: string
    status?: string
    meta?: Metadata
    rx?: string
    tx?: string
    k?: string
    dir?: string
    hex?: string
    phase?: string
}

function normalise(line: Line): Line {
    if (line.k !== 'wire') return line
    return line.dir === 'toDevice' ? { tx: line.hex } : { rx: line.hex }
}

/*
 * Some handlers do not build their config synchronously. RAC_056905_WW waits 500 ms after the
 * values response and then probes the filter over the private channel, giving that up to 5 s
 * before publishing anything - so a replay that reads HA.devices the instant the last frame is
 * fed sees nothing at all, for every RAC-family handler, ours and upstream's alike. Feeding the
 * frames and then letting real timers run for a moment is what makes those profiles replayable.
 */
const SETTLE_MS = 6500
const settle = () => new Promise((resolve) => setTimeout(resolve, SETTLE_MS))

async function replay(file: string) {
    const lines: Line[] = fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => normalise(JSON.parse(l) as Line))

    const meta = lines.find((l) => l.meta)?.meta
    if (!meta) return console.log(`${file}: no metadata line - cannot tell which handler to use`)
    const Handler = HANDLERS[meta.modelId]
    if (!Handler) return console.log(`${file}: no handler listed for ${meta.modelId} (add it to this file)`)

    const HA = new MockHAConnection()
    const thinq = new MockThinq2Device(ID, meta)
    let republishes = 0
    const publishConfig = HA.publishConfig.bind(HA)
    HA.publishConfig = (id, config) => {
        republishes++
        publishConfig(id, config)
    }
    new Handler(HA.asConnection() as never, thinq as never, meta)
    // The constructor's own discovery publish is not a republish.
    republishes = 0

    let frames = 0
    for (const line of lines) {
        if (!line.rx) continue
        frames++
        thinq.emit('data', Buffer.from(line.rx, 'hex'))
    }

    await settle()

    const device = HA.devices[ID]
    console.log(`\n=== ${file}`)
    console.log(`    model ${meta.modelId} sw ${meta.swVersion} | ${frames} frames replayed`)
    if (!device) {
        console.log(`    NO DISCOVERY CONFIG PUBLISHED after ${SETTLE_MS} ms`)
        console.log(`    frames the handler sent: ${thinq.outbox.length}`)
        thinq.outbox.forEach((b) => console.log(`      tx ${b.toString('hex')}`))
        return
    }
    console.log(
        `    frames the handler sent: ${thinq.outbox.length}${thinq.outbox.length ? ' <-- NOT a read-only replay' : ''}`,
    )
    thinq.outbox.forEach((b) => console.log(`      tx ${b.toString('hex')}`))
    console.log(`    discovery republished: ${republishes}`)

    for (const [name, component] of Object.entries(device.config?.components ?? {})) {
        const options = (component as { options?: string[] }).options
        if (options) console.log(`    ${name} options: ${options.join(' | ')}`)
    }
    console.log('    final published state:')
    for (const [prop, value] of Object.entries(device.properties).sort()) {
        console.log(`      ${prop.padEnd(24)} ${value}`)
    }
}

const files = process.argv.slice(2)
if (!files.length) console.log('usage: tsx tools/replay-capture.ts <capture.jsonl> [more.jsonl ...]')
for (const file of files) await replay(file)

/*
 * A TLVDevice keeps a capability-retry interval and a refresh timer running, which hold the
 * event loop open forever after the replay is finished. Nothing is pending at this point, so
 * exit rather than hang.
 */
process.exit(0)
