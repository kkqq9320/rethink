// Extract the TLV tag numbers LG embeds in a model JSON's `label` / `_comment` fields, and
// diff them against the tags a device handler actually references.
//
// LOCAL TOOL — not for upstream.
//
// Why it exists: some model JSONs name their wire tags outright. `DHUM_231006_WW` carries
// strings like "humidityDesired_state_tlv_595" and "FuncSync_humidityControl_tlv_758" —
// decimal 595 = 0x253, 758 = 0x2f6 — which turns the model JSON from a capability dictionary
// into a direct tag->semantics map for that appliance. Not every model has them: of the five
// appliances fetched on 2026-08-03 only the dehumidifier did, so treat a zero count as normal
// rather than as a fetch failure.
//
// The handler side is deliberately a dumb regex over `0x___` literals. It answers "is this tag
// mentioned anywhere in the file", not "is it mentioned correctly" — good enough to sort tags
// into known/unknown, and it never silently claims agreement about meaning.
//
// Usage:
//   tsx tools/modeljson-tlv-map.ts <model.json> [handler.ts]

import * as fs from 'node:fs'

const [modelFile, handlerFile] = process.argv.slice(2)
if (!modelFile) {
    console.error('Usage: tsx tools/modeljson-tlv-map.ts <model.json> [handler.ts]')
    process.exit(1)
}

type Named = { tag: number; key: string; label: string; type?: string; detail: string }

const model = JSON.parse(fs.readFileSync(modelFile, 'utf8')) as Record<string, any>
const named: Named[] = []

function walk(node: unknown, path: string) {
    if (node === null || typeof node !== 'object') return
    const rec = node as Record<string, unknown>
    for (const [k, v] of Object.entries(rec)) {
        if ((k === 'label' || k === '_comment') && typeof v === 'string') {
            const m = v.match(/_tlv_(\d+)/)
            if (m)
                named.push({
                    tag: Number(m[1]),
                    key: path,
                    label: v,
                    type: typeof rec.data_type === 'string' ? rec.data_type : undefined,
                    detail: rec.value_validation
                        ? JSON.stringify(rec.value_validation)
                        : rec.value_mapping
                          ? Object.entries(rec.value_mapping as Record<string, unknown>)
                                .map(([i, l]) => `${i}=${String(l).replace(/^@/, '')}`)
                                .join(' | ')
                          : '',
                })
        }
        if (v && typeof v === 'object') walk(v, path ? `${path}.${k}` : k)
    }
}

for (const [section, body] of Object.entries(model)) {
    if (section === 'Info' || section === 'Module') continue
    if (section === 'Value') for (const [k, v] of Object.entries(body as Record<string, unknown>)) walk(v, k)
    else walk(body, section)
}

named.sort((a, b) => a.tag - b.tag || a.key.localeCompare(b.key))
const hex = (t: number) => `0x${t.toString(16).padStart(3, '0')}`

if (!named.length) {
    console.log(`${modelFile}: no _tlv_ labels — this model does not name its wire tags.`)
    process.exit(0)
}

// state tags vs capability tags: support.* are the bitmasks, the rest are live values
const isSupport = (n: Named) => n.key.startsWith('support.')

if (!handlerFile) {
    console.log(`${named.length} tags named in ${modelFile}\n`)
    for (const n of named) console.log(`${hex(n.tag)}  ${n.key.padEnd(46)} ${(n.type ?? '').padEnd(6)} ${n.detail}`)
    process.exit(0)
}

// ---- diff against the handler ----------------------------------------------------------
const src = fs.readFileSync(handlerFile, 'utf8')
const used = new Set((src.match(/0x[0-9a-fA-F]{3}\b/g) ?? []).map((s) => parseInt(s, 16)))

const namedTags = new Set(named.map((n) => n.tag))
const covered = named.filter((n) => used.has(n.tag))
const missing = named.filter((n) => !used.has(n.tag))
const unnamed = [...used].filter((t) => !namedTags.has(t)).sort((a, b) => a - b)

console.log(`model:   ${modelFile}  (${named.length} tags named)`)
console.log(`handler: ${handlerFile}  (${used.size} tags referenced)\n`)

console.log(`=========== named AND used by the handler (${covered.length}) ===========`)
for (const n of covered) console.log(`${hex(n.tag)}  ${n.key}`)

const missState = missing.filter((n) => !isSupport(n))
const missSupport = missing.filter(isSupport)

console.log(`\n=========== named, NOT referenced — state tags (${missState.length}) ===========`)
console.log('these are live values the appliance can report and the handler ignores:')
for (const n of missState) console.log(`${hex(n.tag)}  ${n.key.padEnd(46)} ${(n.type ?? '').padEnd(6)} ${n.detail}`)

console.log(`\n=========== named, NOT referenced — capability masks (${missSupport.length}) ===========`)
console.log('expected: a handler reads these only if it derives config from caps')
console.log(missSupport.map((n) => `${hex(n.tag)} ${n.key.replace(/^support\./, '')}`).join('\n'))

console.log(`\n=========== used by the handler, NOT named by LG (${unnamed.length}) ===========`)
console.log('reverse-engineered only — the model JSON says nothing about these:')
console.log(unnamed.map(hex).join('  '))
