// Join an appliance's own capability reply (TLV tags, from a capture) against the ThinQ
// model JSON's `support.*` dictionary, and report which TLV tag carries which capability.
//
// LOCAL TOOL — not for upstream.
//
// Why it exists: issue #105 asks where capability bit meanings come from. The two sources are
// independent — the appliance answers a bitmask over the wire, and LG publishes a per-model
// JSON (fetch it with tools/thinq-modeljson.ts) that names each bit. Neither names the other:
// the model JSON has no TLV tag numbers, and the wire has no labels. This matches them by
// their only shared structure, the set of bits.
//
// The indexing convention, established by 0x2c1/0x2c2 agreeing on two different models:
//
//     bit b of the TLV mask  <->  support.* key (b + 1)        key 0 is the "none" sentinel
//
// A tag and a support key are reported as EXACT when those two sets are equal. Exactness is
// the point: it means the model JSON is a per-model answer rather than a family-wide
// dictionary, which is also the check against the "ThinQ failed to probe the device" failure
// mode (a failed probe leaves nearly every capability set, so the sets would not be equal).
// SUBSET matches are printed separately and are NOT evidence on their own — with few bits set,
// several dictionaries can contain them by chance.
//
// Usage:
//   tsx tools/caps-vs-modeljson.ts <capture.jsonl> <model.json>

import * as fs from 'node:fs'
import * as TLV from '@/util/tlv'

const TAG_CAPS_KEY = 0x2da

const [captureFile, modelFile] = process.argv.slice(2)
if (!captureFile || !modelFile) {
    console.error('Usage: tsx tools/caps-vs-modeljson.ts <capture.jsonl> <model.json>')
    process.exit(1)
}

// same framing as tools/decode-caps.ts: kind at [6] is 0x87 or 0xa7 by model, so read the
// payload straight out of the raw frame rather than through decodePacket().
function parseFrame(hex: string) {
    const buf = Buffer.from(hex, 'hex')
    const len = buf[10]
    try {
        return { kind: buf[6], declared: 11 + len + 2, actual: buf.length, tlv: TLV.parse(buf.subarray(11, 11 + len)) }
    } catch {
        return { kind: buf[6], declared: 11 + len + 2, actual: buf.length, tlv: [] as TLV.TLV[] }
    }
}

function bitsOf(v: number): number[] {
    return Array.from({ length: 32 }, (_, b) => b).filter((b) => (v >>> b) & 1)
}

const eq = (a: number[], b: number[]) => a.length === b.length && a.every((x, i) => x === b[i])

// ---- the appliance's answer ------------------------------------------------------------
const frames = fs
    .readFileSync(captureFile, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as { k?: string; dir?: string; hex?: string })
    .filter((r) => r.k === 'wire' && r.dir === 'fromDevice' && typeof r.hex === 'string')
    .map((r) => parseFrame(r.hex as string))
    .filter((f) => f.tlv.some((x) => x.t === TAG_CAPS_KEY))

if (!frames.length) {
    console.error(`No capability reply (a frame carrying 0x2da) in ${captureFile}`)
    process.exit(1)
}
const caps = frames[0]
if (caps.declared !== caps.actual) {
    console.error(`Capability frame is truncated (declares ${caps.declared}, got ${caps.actual}) — refusing to match`)
    process.exit(1)
}

// ---- LG's answer ----------------------------------------------------------------------
const model = JSON.parse(fs.readFileSync(modelFile, 'utf8')) as {
    Info?: { modelType?: string; version?: string }
    Value: Record<string, { data_type?: string; value_mapping?: Record<string, unknown> }>
}

const support: { key: string; bits: number[]; labels: Record<number, string> }[] = []
for (const [k, v] of Object.entries(model.Value)) {
    if (!k.startsWith('support.') || !v.value_mapping) continue
    const idx = Object.keys(v.value_mapping)
        .map(Number)
        .filter((n) => Number.isFinite(n))
    const labels: Record<number, string> = {}
    for (const i of idx) labels[i] = String(v.value_mapping[String(i)]).replace(/^@/, '')
    support.push({
        key: k,
        bits: idx
            .filter((i) => i >= 1)
            .map((i) => i - 1)
            .sort((a, b) => a - b),
        labels,
    })
}

console.log(`capture: ${captureFile}`)
console.log(`model:   ${modelFile}  (${model.Info?.modelType}, version ${model.Info?.version})`)
console.log(`frame:   kind=0x${caps.kind.toString(16)}, ${caps.tlv.length} TLVs, length OK\n`)

// ---- the join --------------------------------------------------------------------------
const seen = new Set<number>()
const unmatched: { tag: number; value: number }[] = []

for (const tlv of caps.tlv) {
    if (seen.has(tlv.t)) continue // 0x2d7/0x2d8/0x2d9 repeat as a per-mode triplet
    seen.add(tlv.t)

    const bits = bitsOf(tlv.v)
    const exact = support.filter((s) => eq(s.bits, bits) && bits.length > 0)
    const subset = support.filter((s) => !exact.includes(s) && bits.length > 0 && bits.every((b) => s.bits.includes(b)))

    if (!exact.length) {
        unmatched.push({ tag: tlv.t, value: tlv.v })
        if (subset.length) {
            console.log(`0x${tlv.t.toString(16)} = ${tlv.v}   bits ${bits.join(',')}`)
            console.log(`    (no exact match; subset of: ${subset.map((s) => s.key).join(', ')})`)
        }
        continue
    }

    console.log(`0x${tlv.t.toString(16)} = ${tlv.v}   bits ${bits.join(',')}`)
    for (const s of exact) {
        console.log(`  == ${s.key}`)
        for (const b of bits) console.log(`       bit ${String(b).padStart(2)} -> ${s.labels[b + 1]}`)
    }
    if (subset.length) console.log(`     (also a subset of: ${subset.map((s) => s.key).join(', ')})`)
    console.log()
}

// ---- value lists, not bitmasks ---------------------------------------------------------
// support.coolLowLimit & friends map an index to itself (0=0, 18=18): a temperature in °C,
// which the wire carries doubled, the same /2 temperatureRange() already applies.
console.log('--- temperature limits (value lists, matched as value == 2 x limit) ---')
for (const s of support) {
    const vals = Object.entries(s.labels)
        .map(([i, l]) => [Number(i), l] as const)
        .filter(([i, l]) => i > 0 && l === String(i))
    if (!vals.length || !/Limit$/.test(s.key)) continue
    for (const [v] of vals) {
        const hits = caps.tlv.filter((t) => t.v === v * 2)
        console.log(
            `${s.key} = ${v}°C  ->  ${hits.length ? hits.map((h) => `0x${h.t.toString(16)}=${h.v}`).join(' | ') : '(no tag with value ' + v * 2 + ')'}`,
        )
    }
}

const empty = support.filter((s) => s.bits.length === 0).map((s) => s.key)
console.log(`\n--- declared but empty in the model JSON (${empty.length}) ---`)
console.log(empty.join(', ') || '(none)')

console.log(`\n--- TLV tags with no exact support.* match (${unmatched.length}) ---`)
console.log(unmatched.map((u) => `0x${u.tag.toString(16)}=${u.value}`).join('  '))
