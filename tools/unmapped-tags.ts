// List the TLV tags an appliance actually reports that its handler never mentions.
//
// LOCAL TOOL — not for upstream.
//
// Why it exists: before operating an appliance to hunt for a feature's tag, it is worth knowing
// which tags it is already volunteering and nobody is reading. That list turns a blind sweep
// into a short list to watch.
//
// Two buckets, because they mean different things:
//   STATE  tags from the values dump - live values, the candidates
//   CAPS   tags from the capability reply itself - declarations, not values. A handler reads
//          these only to decide what to publish, so "unmapped" here is usually correct.
//
// ONLY TLV-BEARING FRAMES ARE PARSED, and that is the whole difficulty. A device sends several
// frame families and most of them are not TLV: the 0xa8 telemetry record is a fixed byte layout,
// and acks carry no payload at all. Running TLV.parse over those yields plausible-looking
// low-numbered tags with high occurrence counts - the first draft of this tool reported 0x000
// 2456 times - which is noise dressed as discovery. The families are told apart by byte 8:
// 0x01 is the capability reply and 0x04 is the values dump, both under kind 0x87/0xa7.
// Everything else is counted and reported as skipped rather than silently dropped.
//
// The handler side is a regex over `0x___` literals, same as tools/modeljson-tlv-map.ts: it
// answers "is this tag mentioned anywhere in the file", not "is it handled correctly". That
// direction is the safe one - it never calls a tag unmapped when the file does mention it.
//
// Usage:
//   tsx tools/unmapped-tags.ts <handler.ts> <capture.jsonl> [more.jsonl ...]

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as TLV from '@/util/tlv'

const TAG_CAPS_KEY = 0x2da

const [handlerFile, ...captures] = process.argv.slice(2)
if (!handlerFile || !captures.length) {
    console.error('Usage: tsx tools/unmapped-tags.ts <handler.ts> <capture.jsonl> [...]')
    process.exit(1)
}

const src = fs.readFileSync(handlerFile, 'utf8')
const mentioned = new Set((src.match(/0x[0-9a-fA-F]{2,3}\b/g) ?? []).map((s) => parseInt(s, 16)))

type Seen = { values: Set<number>; frames: number; files: Set<string> }
const state = new Map<number, Seen>()
const caps = new Map<number, Seen>()
const skipped = new Map<string, number>()

function note(map: Map<number, Seen>, tag: number, value: number, file: string) {
    const e = map.get(tag) ?? { values: new Set<number>(), frames: 0, files: new Set<string>() }
    e.values.add(value)
    e.frames++
    e.files.add(file)
    map.set(tag, e)
}

for (const file of captures) {
    const base = path.basename(file)
    for (const line of fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter((l) => l.trim())) {
        let r: { k?: string; dir?: string; hex?: string }
        try {
            r = JSON.parse(line)
        } catch {
            continue
        }
        if (r.k !== 'wire' || r.dir !== 'fromDevice' || !r.hex) continue
        const buf = Buffer.from(r.hex, 'hex')
        if (buf.length < 12) continue

        // kind is 0x87 or 0xa7 by model; byte 8 selects the family
        const family = `kind=0x${buf[6].toString(16)} [7]=0x${buf[7].toString(16)} [8]=0x${buf[8].toString(16)}`
        if ((buf[6] !== 0x87 && buf[6] !== 0xa7) || (buf[8] !== 0x01 && buf[8] !== 0x04)) {
            skipped.set(family, (skipped.get(family) ?? 0) + 1)
            continue
        }

        let tlv: TLV.TLV[]
        try {
            tlv = TLV.parse(buf.subarray(11, 11 + buf[10]))
        } catch {
            skipped.set(family + ' (parse failed)', (skipped.get(family + ' (parse failed)') ?? 0) + 1)
            continue
        }
        const isCaps = buf[8] === 0x01 || tlv.some((t) => t.t === TAG_CAPS_KEY)
        for (const t of tlv) note(isCaps ? caps : state, t.t, t.v, base)
    }
}

const hex = (t: number) => `0x${t.toString(16).padStart(3, '0')}`

function report(label: string, map: Map<number, Seen>) {
    const rows = [...map.entries()].filter(([t]) => !mentioned.has(t)).sort((a, b) => a[0] - b[0])
    console.log(`\n=========== ${label}: reported but never mentioned by the handler (${rows.length}) ===========`)
    if (!rows.length) {
        console.log('(none)')
        return
    }
    for (const [tag, e] of rows) {
        const vals = [...e.values].sort((a, b) => a - b)
        const shown = vals.length > 8 ? `${vals.slice(0, 8).join(', ')} … (${vals.length} distinct)` : vals.join(', ')
        const moves = vals.length > 1 ? 'VARIES ' : 'constant'
        console.log(`${hex(tag)}  ${moves}  ${String(e.frames).padStart(3)}x   values: ${shown}`)
    }
}

console.log(`handler:  ${handlerFile}  (${mentioned.size} distinct 0x literals)`)
console.log(`captures: ${captures.length} file(s)`)
console.log(`tags seen: ${state.size} in the values dump, ${caps.size} in the capability reply`)
console.log(`skipped (not TLV): ${[...skipped.entries()].map(([k, n]) => `${n}x ${k}`).join('  |  ') || 'none'}`)

report('STATE', state)
report('CAPS', caps)
