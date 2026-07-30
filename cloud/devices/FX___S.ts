import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'

// LG front-load washer sold in Korea, self-reports modelId "FX___S" (sw 2.11.246).
//
// This model does NOT share a layout with any of the existing washer handlers: F3L2CYU__/T1789EFH_F
// discriminate on buf[1]==0xEC with 25/27-byte records, the EU F_V*/Y_V* handlers parse a flat 80/53-byte
// frame. FX___S wraps everything in a second envelope and carries a 66-byte record. Everything below was
// derived from live captures (washer-capture-20260730.jsonl, washer-cycle-20260730.jsonl) taken while the
// owner drove the appliance and the LG app, naming each action as they made it; every value here is
// backed by an operation whose label was written down before the bytes were read.
//
// FRAMING. AABBDevice strips "AA <len8>" and "<cksum> BB", so buf[0] is the direction byte (0x20 from
// the appliance) and buf[1] is the message type. When the original length byte was 0xFF the real length
// is a 16-bit field that follows the type, which is how we tell the two forms apart:
//
//   short:     20 <type> <payload...>
//   extended:  20 <type> <len16> <payload...>          len16 == buf.length + 4
//
// Message types seen from the appliance: 0x0A (tunnel, see below), 0xE6 (reply to a settings write),
// 0xC3/0x00/0x19/0x72/0x7F (short acks and handshake bytes, not decoded).
//
// TUNNEL (0x0A). payload = 00 <id16> 00 01 <flag> <inner> <innerlen16> 00 <data>
//   inner 0x03  6 or 17 bytes  heartbeat, ~1.5 s, only while powered on
//   inner 0xEC  134 bytes      state: <record 66B = previous> 00 <record 66B = current> <trailing byte>
//   inner 0x86/0x87            the app browsing the course table; read-only, not decoded
//   inner 0x02  78 bytes       ~5 min telemetry (temperature/water-level shaped), not decoded. Keeps
//                              arriving after 0xEC stops, so it is the better liveness signal.
//
// The stacked-record layout is not an assumption: across consecutive 0xEC frames the current record of
// frame N is byte-identical to the previous record of frame N+1.
//
// SETTINGS REPLY (0xE6). payload = 00 02 01 FF <n> [<key> <status>]*n 00 <record 66B>
// The per-key status is 0x00 when that key was actually applied and 0x11 when it already held the value.
// This is how we caught the LG app silently re-sending a stale payload twice and never delivering a
// water-temperature change the owner believed they had made.

const FROM_DEVICE = 0x20
const MSG_TUNNEL = 0x0a
const MSG_SETTINGS_REPLY = 0xe6
const INNER_STATE = 0xec

const RECORD_LEN = 66
// data = <record> <1 byte separator> <record>; the current state is the second one.
const CURRENT_RECORD_OFFSET = RECORD_LEN + 1

// ---------------------------------------------------------------------------------------------------
// Record offsets. The four option bytes are the appliance's REMAINING WORK, not the selected settings:
// while idle they equal what was selected, and during a cycle each drops to 0 as its stage completes.
// That is what identified the phase codes - o0 cleared entering phase 12, o2 counted 2->1->0 during it,
// o3 cleared entering 42. Re-verified on a second course (Rinse+Spin started with o0 already 0 and
// skipped the wash phases entirely).
const OFF_WASH = 0 // key 0x1E
const OFF_WATER_TEMP = 1 // key 0x1F
const OFF_RINSE = 2 // key 0x20, duplicated at offset 26
const OFF_SPIN = 3 // key 0x21
const OFF_COURSE = 4 // key 0x0A (0xFF = extended, real course at offset 22)
const OFF_REMAIN_H = 12
const OFF_REMAIN_M = 13
const OFF_TOTAL_H = 14
const OFF_TOTAL_M = 15
const OFF_COURSE_EXT = 22 // key 0x0B
const OFF_PHASE = 20
const OFF_PHASE_PREV = 21
const OFF_CYCLES = 27
const OFF_BEEP = 28
const OFF_FLAGS = 36

const FLAG_CYCLE_ACTIVE = 0x10 // set from start until the cycle ends
// Set only while the drum is actually turning. It clears on pause, but it ALSO clears and re-sets on its
// own mid-cycle (measured twice, with no command in between and the remaining time still counting down),
// so it must not be used to mean "paused" - that is PHASE_PAUSED and nothing else.
const FLAG_DRUM_ACTIVE = 0x80

const PHASE_OFF = 0
const PHASE_STANDBY = 1
const PHASE_PAUSED = 2
const PHASE_DONE = 42
const PHASE_CARE = 47

// Phase codes. 11/40 alternate through the wash stage and 3/37 lead into it; the four confirmed stages
// were each pinned by watching which option byte had just cleared. 3 and 37 were never isolated to a
// named stage, so they stay generic rather than being guessed into "Sensing"/"Filling".
const STATUS: Record<number, string> = {
    [PHASE_OFF]: 'Off',
    [PHASE_STANDBY]: 'Standby',
    [PHASE_PAUSED]: 'Paused',
    3: 'Starting',
    37: 'Starting',
    11: 'Washing',
    40: 'Washing',
    12: 'Rinsing',
    14: 'Spinning',
    [PHASE_DONE]: 'Complete',
    [PHASE_CARE]: 'Laundry care',
}
const STATUS_OPTIONS = [...new Set(Object.values(STATUS))].concat('Unknown')

// Remaining/total time only mean anything while a wash is under way. At PHASE_DONE the counter stops at
// 1 minute rather than reaching 0, and Laundry care leaves the previous cycle's values untouched - both
// would otherwise show a permanent "1 minute left" in Home Assistant.
const TIMED_PHASES = new Set([3, 37, 11, 40, 12, 14, PHASE_PAUSED])

// ---------------------------------------------------------------------------------------------------
// Settings keys, all confirmed by single-variable writes made from the LG app.
const KEY_COURSE = 0x0a
const KEY_COURSE_EXT = 0x0b
const KEY_POWER = 0x02
const KEY_OPERATION = 0x03
const KEY_BEEP = 0x13
const KEY_WASH = 0x1e
const KEY_WATER_TEMP = 0x1f
const KEY_RINSE = 0x20
const KEY_SPIN = 0x21
const KEY_TURBOWASH = 0x35
const KEY_STEAM = 0x3e
const KEY_LAUNDRY_CARE = 0x57

const OP_START = 0x01
const OP_PAUSE = 0x02
const OP_RESUME = 0x03

const COURSE_EXTENDED = 0xff

// Only the courses the owner actually ran are named. An unnamed one leaves the select untouched and
// shows up in the `options_raw` diagnostic instead, where it can be identified and added here.
const COURSE: Record<number, string> = {
    0x72: 'AI Wash',
    0x55: 'Tub Clean',
    0x37: 'Rinse + Spin',
}
const COURSE_EXT: Record<number, string> = {
    0xf6: 'Towels 1',
}

const WASH: Record<number, string> = { 0x00: 'Off', 0x03: 'Normal', 0x07: 'Soak' }
const WATER_TEMP: Record<number, string> = { 0x00: 'Off', 0x03: 'Default', 0x05: '40' }
const SPIN: Record<number, string> = { 0x04: 'Medium', 0x06: 'High', 0x08: 'Dry fit' }
const BEEP: Record<number, string> = { 0: 'Mute', 1: 'Low', 2: 'Medium', 3: 'High', 4: 'Very high' }
// Rinse is the count itself; 1-4 were each written and read back unchanged.
const RINSE = [1, 2, 3, 4]

function invert(map: Record<number, string>): Record<string, number> {
    return Object.fromEntries(Object.entries(map).map(([k, v]) => [v, Number(k)]))
}
const WASH_BY_NAME = invert(WASH)
const WATER_TEMP_BY_NAME = invert(WATER_TEMP)
const SPIN_BY_NAME = invert(SPIN)
const BEEP_BY_NAME = invert(BEEP)
const COURSE_BY_NAME = invert(COURSE)

export default class Device extends AABBDevice {
    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq)
        this.setConfig(
            allowExtendedType({
                ...HADevice.config(meta, { name: 'LG Washer' }),
                components: {
                    power: {
                        platform: 'switch',
                        unique_id: '$deviceid-power',
                        state_topic: '$this/power',
                        command_topic: '$this/power/set',
                        name: '',
                        icon: 'mdi:washing-machine',
                    },
                    status: {
                        platform: 'sensor',
                        unique_id: '$deviceid-status',
                        state_topic: '$this/status',
                        name: 'Status',
                        icon: 'mdi:state-machine',
                        device_class: 'enum',
                        options: STATUS_OPTIONS,
                    },
                    // The phase enum is incomplete (3/37 are not pinned to a named stage, and only four
                    // courses have been run). Exposing the raw byte lets an unnamed phase be identified
                    // from history instead of vanishing into "Unknown".
                    status_code: {
                        platform: 'sensor',
                        unique_id: '$deviceid-status-code',
                        state_topic: '$this/status_code',
                        name: 'Status code',
                        icon: 'mdi:numeric',
                        entity_category: 'diagnostic',
                    },
                    running: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-running',
                        state_topic: '$this/running',
                        name: 'Running',
                        device_class: 'running',
                    },
                    drum_active: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-drum-active',
                        state_topic: '$this/drum_active',
                        name: 'Drum turning',
                        icon: 'mdi:rotate-3d-variant',
                        entity_category: 'diagnostic',
                    },
                    remaining_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-remaining-time',
                        state_topic: '$this/remaining_time',
                        name: 'Remaining time',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                    },
                    total_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-total-time',
                        state_topic: '$this/total_time',
                        name: 'Total time',
                        device_class: 'duration',
                        unit_of_measurement: 'min',
                    },
                    // Counts down as the appliance works through the rinses, so it is genuinely useful
                    // while running - unlike the `rinse` select, which holds the selection.
                    rinse_remaining: {
                        platform: 'sensor',
                        unique_id: '$deviceid-rinse-remaining',
                        state_topic: '$this/rinse_remaining',
                        name: 'Rinses remaining',
                        icon: 'mdi:water-sync',
                    },
                    options_raw: {
                        platform: 'sensor',
                        unique_id: '$deviceid-options-raw',
                        state_topic: '$this/options_raw',
                        name: 'Selected options (raw)',
                        icon: 'mdi:code-braces',
                        entity_category: 'diagnostic',
                    },
                    cycles: {
                        platform: 'sensor',
                        unique_id: '$deviceid-cycles',
                        state_topic: '$this/cycles',
                        name: 'Cycles',
                        icon: 'mdi:counter',
                        state_class: 'total_increasing',
                        entity_category: 'diagnostic',
                    },
                    course: {
                        platform: 'select',
                        unique_id: '$deviceid-course',
                        state_topic: '$this/course',
                        command_topic: '$this/course/set',
                        name: 'Course',
                        icon: 'mdi:playlist-check',
                        // Extended courses are readable but cannot be written back (selecting one needs
                        // key 0x0B and no such write has been captured), so they are listed to keep the
                        // state valid; picking one is a no-op until that write is observed.
                        options: [...Object.values(COURSE), ...Object.values(COURSE_EXT)],
                    },
                    wash: {
                        platform: 'select',
                        unique_id: '$deviceid-wash',
                        state_topic: '$this/wash',
                        command_topic: '$this/wash/set',
                        name: 'Wash',
                        icon: 'mdi:washing-machine',
                        options: Object.values(WASH),
                    },
                    water_temp: {
                        platform: 'select',
                        unique_id: '$deviceid-water-temp',
                        state_topic: '$this/water_temp',
                        command_topic: '$this/water_temp/set',
                        name: 'Water temperature',
                        icon: 'mdi:thermometer-water',
                        options: Object.values(WATER_TEMP),
                    },
                    rinse: {
                        platform: 'select',
                        unique_id: '$deviceid-rinse',
                        state_topic: '$this/rinse',
                        command_topic: '$this/rinse/set',
                        name: 'Rinse',
                        icon: 'mdi:water',
                        options: RINSE.map(String),
                    },
                    spin: {
                        platform: 'select',
                        unique_id: '$deviceid-spin',
                        state_topic: '$this/spin',
                        command_topic: '$this/spin/set',
                        name: 'Spin',
                        icon: 'mdi:rotate-right',
                        options: Object.values(SPIN),
                    },
                    turbowash: {
                        platform: 'switch',
                        unique_id: '$deviceid-turbowash',
                        state_topic: '$this/turbowash',
                        command_topic: '$this/turbowash/set',
                        name: 'TurboShot',
                        icon: 'mdi:car-turbocharger',
                    },
                    steam: {
                        platform: 'switch',
                        unique_id: '$deviceid-steam',
                        state_topic: '$this/steam',
                        command_topic: '$this/steam/set',
                        name: 'Steam',
                        icon: 'mdi:kettle-steam',
                    },
                    beep: {
                        platform: 'select',
                        unique_id: '$deviceid-beep',
                        state_topic: '$this/beep',
                        command_topic: '$this/beep/set',
                        name: 'Beep volume',
                        icon: 'mdi:volume-high',
                        options: Object.values(BEEP),
                        entity_category: 'config',
                    },
                    start: {
                        platform: 'button',
                        unique_id: '$deviceid-start',
                        command_topic: '$this/start/set',
                        payload_press: '',
                        name: 'Start',
                        icon: 'mdi:play-circle-outline',
                    },
                    pause: {
                        platform: 'button',
                        unique_id: '$deviceid-pause',
                        command_topic: '$this/pause/set',
                        payload_press: '',
                        name: 'Pause',
                        icon: 'mdi:pause-circle-outline',
                    },
                    resume: {
                        platform: 'button',
                        unique_id: '$deviceid-resume',
                        command_topic: '$this/resume/set',
                        payload_press: '',
                        name: 'Resume',
                        icon: 'mdi:play-pause',
                    },
                    laundry_care: {
                        platform: 'button',
                        unique_id: '$deviceid-laundry-care',
                        command_topic: '$this/laundry_care/set',
                        payload_press: '',
                        name: 'Laundry care',
                        icon: 'mdi:tumble-dryer',
                    },
                },
            }),
        )
    }

    processAABB(buf: Buffer) {
        if (buf[0] !== FROM_DEVICE || buf.length < 4) return

        const type = buf[1]
        // The 0xFF "extended length" form carries a 16-bit total length after the type byte. AABBDevice
        // has already removed the 4 envelope bytes, hence the +4.
        const extended = buf.readUInt16BE(2) === buf.length + 4
        const payload = extended ? buf.subarray(4) : buf.subarray(2)

        if (type === MSG_TUNNEL) {
            if (payload.length < 10 || payload[6] !== INNER_STATE) return
            const data = payload.subarray(10)
            if (data.length < CURRENT_RECORD_OFFSET + RECORD_LEN) return
            this.processRecord(data.subarray(CURRENT_RECORD_OFFSET, CURRENT_RECORD_OFFSET + RECORD_LEN))
        } else if (type === MSG_SETTINGS_REPLY) {
            // 00 02 01 FF <n> [<key> <status>]*n 00 <record>
            if (payload.length < 5) return
            const start = 5 + payload[4] * 2 + 1
            if (payload.length < start + RECORD_LEN) return
            this.processRecord(payload.subarray(start, start + RECORD_LEN))
        }
    }

    processRecord(rec: Buffer) {
        const phase = rec[OFF_PHASE]
        const flags = rec[OFF_FLAGS]

        this.publishProperty('power', phase === PHASE_OFF ? 'OFF' : 'ON')
        this.publishProperty('status', STATUS[phase] ?? 'Unknown')
        this.publishProperty('status_code', phase)
        this.publishProperty('running', flags & FLAG_CYCLE_ACTIVE ? 'ON' : 'OFF')
        this.publishProperty('drum_active', flags & FLAG_DRUM_ACTIVE ? 'ON' : 'OFF')
        this.publishProperty('cycles', rec[OFF_CYCLES])
        this.publishProperty('beep', BEEP[rec[OFF_BEEP]] ?? 'Unknown')

        // Only the wash clock counts down, so everything else would show a stale figure - and at the end
        // of a cycle the remaining-minutes byte sticks at 1 rather than reaching 0. The total is the
        // selected course's estimate though, which is worth seeing before pressing start, so it is
        // published whenever the appliance is on.
        this.publishProperty('remaining_time', TIMED_PHASES.has(phase) ? rec[OFF_REMAIN_H] * 60 + rec[OFF_REMAIN_M] : 0)
        this.publishProperty('total_time', phase === PHASE_OFF ? 0 : rec[OFF_TOTAL_H] * 60 + rec[OFF_TOTAL_M])
        this.publishProperty('rinse_remaining', rec[OFF_RINSE])

        // Powering off zeroes the phase, the clock and the wash/water-temperature/rinse bytes (the
        // course, spin, cycle count and beep volume all survive), and during a cycle the option bytes
        // are being consumed rather than reporting the selection. In both cases republishing them would
        // overwrite the selects with meaningless values; Home Assistant keeps the last value published.
        if (phase === PHASE_OFF || flags & FLAG_CYCLE_ACTIVE) return

        const course = rec[OFF_COURSE]
        this.publishOption('course', course === COURSE_EXTENDED ? COURSE_EXT[rec[OFF_COURSE_EXT]] : COURSE[course])
        this.publishOption('wash', WASH[rec[OFF_WASH]])
        this.publishOption('water_temp', WATER_TEMP[rec[OFF_WATER_TEMP]])
        this.publishOption('rinse', RINSE.includes(rec[OFF_RINSE]) ? String(rec[OFF_RINSE]) : undefined)
        this.publishOption('spin', SPIN[rec[OFF_SPIN]])

        // Only four courses have been run on this appliance and the water-temperature/spin lists are
        // just as partial, so an unrecognised value is expected rather than exceptional. A select whose
        // state is not one of its own options is rejected by Home Assistant, so those are left holding
        // their previous value and the raw bytes are published here instead - the same escape hatch as
        // `status_code`, and the thing to read when naming a new course.
        this.publishProperty(
            'options_raw',
            `course=${course} ext=${rec[OFF_COURSE_EXT]} wash=${rec[OFF_WASH]} temp=${rec[OFF_WATER_TEMP]} rinse=${rec[OFF_RINSE]} spin=${rec[OFF_SPIN]}`,
        )
    }

    /** Publish a select's state only when the appliance's value is one of the options we declared. */
    publishOption(prop: string, value: string | undefined) {
        if (value !== undefined) this.publishProperty(prop, value)
    }

    // f0 e5 00 02 01 ff 01 <key> <value>  - AABBDevice.send() reproduces the appliance's own framing and
    // checksum exactly; all eleven captured commands were rebuilt from it byte for byte.
    setField(key: number, value: number) {
        this.send(Buffer.from([0xf0, 0xe5, 0x00, 0x02, 0x01, 0xff, 0x01, key, value]))
    }

    // Sent by the app immediately after an operation write, but only when the drum is actually about to
    // turn - a pause never carries it.
    trigger() {
        this.send(Buffer.from('f024100101', 'hex'))
    }

    setProperty(prop: string, mqttValue: string) {
        switch (prop) {
            case 'power':
                return this.setField(KEY_POWER, mqttValue === 'ON' ? 1 : 0)
            case 'start':
                this.setField(KEY_OPERATION, OP_START)
                return this.trigger()
            case 'pause':
                return this.setField(KEY_OPERATION, OP_PAUSE)
            case 'resume':
                this.setField(KEY_OPERATION, OP_RESUME)
                return this.trigger()
            case 'laundry_care':
                return this.setField(KEY_LAUNDRY_CARE, 1)
            case 'turbowash':
                return this.setField(KEY_TURBOWASH, mqttValue === 'ON' ? 1 : 0)
            case 'steam':
                return this.setField(KEY_STEAM, mqttValue === 'ON' ? 1 : 0)
            case 'rinse': {
                const count = Number(mqttValue)
                if (RINSE.includes(count)) this.setField(KEY_RINSE, count)
                return
            }
        }

        const selects: Record<string, [number, Record<string, number>]> = {
            course: [KEY_COURSE, COURSE_BY_NAME],
            wash: [KEY_WASH, WASH_BY_NAME],
            water_temp: [KEY_WATER_TEMP, WATER_TEMP_BY_NAME],
            spin: [KEY_SPIN, SPIN_BY_NAME],
            beep: [KEY_BEEP, BEEP_BY_NAME],
        }
        const select = selects[prop]
        if (!select) return
        const [key, byName] = select
        const value = byName[mqttValue]
        // Selecting an extended course needs a second key (0x0B) and none has been captured being
        // written, so those are read-only for now.
        if (value !== undefined) this.setField(key, value)
    }
}
