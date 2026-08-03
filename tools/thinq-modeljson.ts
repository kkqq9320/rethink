// Fetch this account's ThinQ device records and download each appliance's model JSON
// (`modelJsonUri`) and app PWA controller bundle (`appModuleUri`).
//
// LOCAL TOOL — not for upstream.
//
// Why it exists: issue #105 (comment 5151524529) points at the ThinQ API's model JSON as the
// authoritative source for capability bit meanings, instead of inferring them from captures.
// That comment recommends `wideq`, which needs a patched x-client-id; this repo's own
// bridge/thinqApi.ts already randomises that header (line 134), so the same query is three
// calls against code that is here.
//
// READ-ONLY. It calls auth / listDevices / getDeviceStatus and GETs two public URLs.
// It never writes to the cloud or to an appliance, and never touches the bridge's own
// state directory.
//
// It deliberately does NOT use util/lgcloud/monitor's connect(): that path shells out to
// openssl and `bash -c` to build an MQTT subscription, which is both unnecessary here and a
// Windows landmine.
//
// Two notes on output:
//   - Everything raw lands in files. stdout stays a short summary, because apiFetch()
//     (bridge/thinqApi.ts:44) console.logs the full request options — including x-emp-token —
//     on any non-0000 result, and auth() prints the LG account id. Both are intercepted here
//     and written, redacted, to <out>/_api.log.
//   - The dumps are SECRETS: deviceId, certificates and account identifiers. Treat <out> the
//     way the runbook treats data/state.
//
// Usage:
//   tsx tools/thinq-modeljson.ts [--out <dir>] [--state <oauth.json>]
//
// First run is interactive (browser sign-in, paste the post-login URL) and saves the refresh
// token to --state. Later runs are non-interactive.

import * as fs from 'node:fs'
import * as path from 'node:path'
import fetch from 'node-fetch'
import { Client } from '@/bridge/thinqApi'
import { login } from '@/util/lgcloud/monitor'
import { loadState, saveState } from '@/util/lgcloud/state'

function arg(name: string, fallback: string): string {
    const i = process.argv.indexOf(`--${name}`)
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const outDir = arg('out', 'thinq-model')
const statePath = arg('state', 'oauth.json')

// ---- console interception -------------------------------------------------------------
// apiFetch and auth log request options and the account id. Capture rather than print.
const SENSITIVE = /^(x-emp-token|x-user-no|x-client-id|x-message-id|authorization|refreshToken|accessToken)$/i
const apiLog: string[] = []

function redact(value: unknown): string {
    let text: string
    try {
        text = JSON.stringify(value, (k, v) => (SENSITIVE.test(k) ? '<redacted>' : v))
    } catch {
        text = String(value)
    }
    if (text === undefined) text = String(value)
    // anything else long and opaque (JWTs, hex blobs) that slipped through
    return text.replace(/[A-Za-z0-9_-]{60,}/g, '<redacted>')
}

const realLog = console.log.bind(console)
console.log = (...args: unknown[]) => {
    apiLog.push(args.map(redact).join(' '))
}
const say = realLog

// ---- recursive URI discovery ----------------------------------------------------------
// HomeResponse (bridge/thinqApi.ts:86) declares six fields; the live objects carry far more,
// and the key is modelJsonUri in most regions but modelJsonUrl in some. Search, don't index.
type Found = { key: string; url: string; at: string }

function findUris(node: unknown, want: RegExp, at = ''): Found[] {
    const out: Found[] = []
    if (node === null || typeof node !== 'object') return out
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        const where = at ? `${at}.${k}` : k
        if (want.test(k) && typeof v === 'string' && /^https?:\/\//.test(v)) out.push({ key: k, url: v, at: where })
        else out.push(...findUris(v, want, where))
    }
    return out
}

function safeName(s: string): string {
    return s.replace(/[^A-Za-z0-9._-]/g, '_')
}

async function download(url: string, dest: string): Promise<string> {
    const resp = await fetch(url)
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    const body = Buffer.from(await resp.arrayBuffer())
    fs.writeFileSync(dest, body)
    return `${body.length} bytes`
}

async function run() {
    fs.mkdirSync(outDir, { recursive: true })

    let state = loadState(statePath)
    if (!state) {
        say(`No ${statePath} — signing in. (Interactive: run this from a real terminal.)`)
        console.log = realLog // the login prompts must be visible
        state = await login()
        console.log = (...args: unknown[]) => void apiLog.push(args.map(redact).join(' '))
        saveState(state, statePath)
        say(`Saved refresh token to ${statePath} — this file is a secret.`)
    }

    const client = new Client({ countryCode: state.countryCode })
    await client.auth(state.refreshToken)
    say(`Authenticated (country ${state.countryCode}, home ${client.homeId ? 'found' : 'MISSING'}).`)

    const devices = (await client.listDevices()) as unknown as Record<string, unknown>[]
    fs.writeFileSync(path.join(outDir, 'devices.json'), JSON.stringify(devices, null, 2))
    say(`\n${devices.length} device(s) in this home. Full records -> ${path.join(outDir, 'devices.json')}\n`)

    for (const dev of devices) {
        const modelName = String(dev.modelName ?? 'unknown')
        const alias = String(dev.alias ?? '?')
        const deviceId = String(dev.deviceId ?? '')
        const tag = safeName(modelName)

        say(`--- ${alias} | ${modelName} | deviceType=${dev.deviceType} | online=${dev.online}`)

        // the per-device record is often richer than the home listing
        let status: unknown = null
        try {
            status = await client.getDeviceStatus(deviceId)
            fs.writeFileSync(path.join(outDir, `device_${tag}.json`), JSON.stringify(status, null, 2))
        } catch (err) {
            say(`    getDeviceStatus failed: ${err instanceof Error ? err.message : String(err)}`)
        }

        const model = [...findUris(dev, /^modelJson(Uri|Url)$/i), ...findUris(status, /^modelJson(Uri|Url)$/i)]
        const appmod = [...findUris(dev, /^appModule(Uri|Url)$/i), ...findUris(status, /^appModule(Uri|Url)$/i)]

        for (const [label, hits, ext] of [
            ['model JSON', model, 'model.json'],
            ['app module', appmod, 'appmodule.js'],
        ] as const) {
            const hit = hits[0]
            if (!hit) {
                say(`    ${label}: NOT PRESENT in the device record`)
                continue
            }
            const dest = path.join(outDir, `${tag}.${ext}`)
            try {
                say(`    ${label}: ${hit.key} -> ${await download(hit.url, dest)} -> ${dest}`)
            } catch (err) {
                say(`    ${label}: download failed (${err instanceof Error ? err.message : String(err)}) ${hit.url}`)
            }
        }
    }

    fs.writeFileSync(path.join(outDir, '_api.log'), apiLog.join('\n'))
    say(`\nRedacted API chatter -> ${path.join(outDir, '_api.log')}`)
}

run().catch((err) => {
    fs.mkdirSync(outDir, { recursive: true })
    fs.writeFileSync(path.join(outDir, '_api.log'), apiLog.join('\n'))
    say(`FAILED: ${err instanceof Error ? err.message : String(err)}`)
    say(`See ${path.join(outDir, '_api.log')}`)
    process.exit(1)
})
