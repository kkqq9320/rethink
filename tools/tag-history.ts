// Report every value a given set of TLV tags ever took across a set of captures, with the
// per-file breakdown and whether the value ever moved.
//
// LOCAL TOOL — not for upstream.
//
// Why it exists: the project's recurring mistake is reading "I did not see it" as "it is not
// there" (patches.md §일곱 번 틀렸습니다, #5). When a tag acquires a name — e.g. from the model
// JSON's `_tlv_` labels, see tools/modeljson-tlv-map.ts — the captures already on disk deserve
// a second pass with that name in hand, before anyone touches the appliance.
//
// The distinction it is built to make:
//   ABSENT   the tag never appeared - no evidence either way, an experiment is needed
//   CONSTANT it appeared but never moved - "constant is not unused"; it may simply never have
//            been exercised, which is exactly how the dehumidifier's water-tank light hid
//   VARIES   it moved - the captures already contain the evidence, no appliance needed
//
// Usage:
//   tsx tools/tag-history.ts --tags 0xc8,0x151,0x17c <capture.jsonl> [more.jsonl ...]

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as TLV from '@/util/tlv'

const argv = process.argv.slice(2)
const ti = argv.indexOf('--tags')
if (ti < 0 || !argv[ti + 1]) {
    console.error('Usage: tsx tools/tag-history.ts --tags 0xc8,0x151 <capture.jsonl> [...]')
    process.exit(1)
}
const tags = argv[ti + 1].split(',').map((s) => parseInt(s.trim(), 16))
const files = argv.filter((_, i) => i !== ti && i !== ti + 1)
if (!files.length) {
    console.error('No capture files given')
    process.exit(1)
}

type Obs = { file: string; value: number; dir: string }
const obs = new Map<number, Obs[]>(tags.map((t) => [t, []]))

for (const file of files) {
    let lines: string[]
    try {
        lines = fs
            .readFileSync(file, 'utf8')
            .split('\n')
            .filter((l) => l.trim())
    } catch {
        console.error(`skip (unreadable): ${file}`)
        continue
    }
    for (const line of lines) {
        let r: { k?: string; dir?: string; hex?: string }
        try {
            r = JSON.parse(line)
        } catch {
            continue
        }
        if (r.k !== 'wire' || !r.hex) continue
        const buf = Buffer.from(r.hex, 'hex')
        if (buf.length < 12) continue
        let tlv: TLV.TLV[]
        try {
            tlv = TLV.parse(buf.subarray(11, 11 + buf[10]))
        } catch {
            continue
        }
        for (const t of tlv) {
            const bucket = obs.get(t.t)
            if (bucket) bucket.push({ file: path.basename(file), value: t.v, dir: r.dir ?? '?' })
        }
    }
}

const hex = (t: number) => `0x${t.toString(16).padStart(3, '0')}`

console.log(`scanned ${files.length} capture(s) for ${tags.length} tag(s)\n`)

for (const t of tags) {
    const all = obs.get(t)!
    if (!all.length) {
        console.log(`${hex(t)}  ABSENT — never appeared in any capture. No evidence either way.`)
        continue
    }
    const values = [...new Set(all.map((o) => o.value))].sort((a, b) => a - b)
    const verdict = values.length > 1 ? 'VARIES' : 'CONSTANT'
    console.log(`${hex(t)}  ${verdict} — ${all.length} occurrence(s), value(s): ${values.join(', ')}`)

    // where, and in which direction
    const byFile = new Map<string, { vals: Set<number>; n: number; dirs: Set<string> }>()
    for (const o of all) {
        const e = byFile.get(o.file) ?? { vals: new Set<number>(), n: 0, dirs: new Set<string>() }
        e.vals.add(o.value)
        e.dirs.add(o.dir)
        e.n++
        byFile.set(o.file, e)
    }
    for (const [f, e] of byFile)
        console.log(`        ${f}: ${e.n}x  ${[...e.vals].join('/')}  (${[...e.dirs].join(',')})`)
    if (verdict === 'CONSTANT') console.log(`        note: constant is not unused — it may never have been exercised.`)
    console.log()
}
