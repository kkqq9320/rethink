import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'
import log from '@/util/logging'

// LG front-load washer sold in Korea. Retail model FX25VSR.AKOR2; it reports modelId "FX___S" (sw
// 2.11.246), which is what we match on - the underscores are LG's family wildcard, the same shape as
// F_V8_Y___W.B_2QEUK and 2REF11EIDA__4, so sibling FX models may report the same id. Whether their
// frame layout is identical has not been checked, and the diagnostic sensors below exist partly so a
// mismatch shows up as an unnamed value rather than as silently wrong state.
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
// The per-key status is 0x00 when that key was actually applied and 0x11 when it already held the value,
// which is what makes a write verifiable rather than assumed.

const FROM_DEVICE = 0x20
const MSG_TUNNEL = 0x0a
const MSG_SETTINGS_REPLY = 0xe6
const INNER_STATE = 0xec
// The same record without a preceding "previous" one, sent once immediately after the appliance
// (re)connects - there is no prior state to diff against yet. Without it a restart leaves every entity
// unknown until the appliance next changes state, which on an idle washer can be a very long time.
const INNER_STATE_SINGLE = 0xeb

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
// Steam sits in its own byte rather than the flags one. Found by toggling steam on the Normal course
// and watching this bit follow it; it also matches the Towels 1 selection, which switches steam on.
const OFF_STEAM = 34
const STEAM_ON = 0x10

// Bit 0x10 was originally read as "a cycle is loaded", because it was set for the whole of a wash and
// stayed set after it finished. It is remote control: the owner had switched remote control on in order
// to start that wash from the app, and left it on. Toggling it by hand on the panel moves this bit and
// nothing else, and the door lock follows a few seconds later.
const FLAG_REMOTE_CONTROL = 0x10
const FLAG_CHILD_LOCK = 0x20
// Set only while the drum is actually turning. It clears on pause, but it ALSO clears and re-sets on its
// own mid-cycle (measured twice, with no command in between and the remaining time still counting down),
// so it must not be used to mean "paused" - that is PHASE_PAUSED and nothing else.
const FLAG_DRUM_ACTIVE = 0x80

// One byte each, found by toggling them on the panel one at a time with a pause in between - the run
// that finally separated them from each other after an earlier attempt did all of it inside 20 seconds
// and left five interleaved signals that could not be told apart.
const OFF_DOOR_LOCK = 37 // whole byte: 1 while locked. Follows remote control on its own.
const OFF_WRINKLE_CARE = 35
const WRINKLE_CARE_ON = 0x80
const OFF_TURBOSHOT = 33
const TURBOSHOT_ON = 0x20
// "Laundry care when the cycle ends". Toggling it from the app moves this bit, so key 0x57 is a setting
// rather than a one-shot action - pressing it while the appliance sits on Complete simply makes it act
// on the setting straight away, which is what it looked like the first time it was seen.
const OFF_LAUNDRY_CARE = 46
const LAUNDRY_CARE_ON = 0x08

const PHASE_OFF = 0
const PHASE_STANDBY = 1
const PHASE_PAUSED = 2
const PHASE_DONE = 42
const PHASE_CARE = 47

// Phase codes. 11/40 alternate through the wash stage and 3/37 lead into it; the four confirmed stages
// were each pinned by watching which option byte had just cleared. 3 and 37 were never isolated to a
// named stage, so they stay generic rather than being guessed into "Sensing"/"Filling".
const STATUS: Record<number, string> = {
    [PHASE_OFF]: 'off',
    [PHASE_STANDBY]: 'standby',
    [PHASE_PAUSED]: 'paused',
    3: 'starting',
    37: 'starting',
    11: 'washing',
    40: 'washing',
    12: 'rinsing',
    14: 'spinning',
    [PHASE_DONE]: 'complete',
    [PHASE_CARE]: 'laundry_care',
}
const STATUS_OPTIONS = [...new Set(Object.values(STATUS))].concat('unknown')

// Remaining/total time only mean anything while a wash is under way. At PHASE_DONE the counter stops at
// 1 minute rather than reaching 0, and Laundry care leaves the previous cycle's values untouched - both
// would otherwise show a permanent "1 minute left" in Home Assistant.
const TIMED_PHASES = new Set([3, 37, 11, 40, 12, 14, PHASE_PAUSED])

// Phases in which the appliance is actually working. Paused is deliberately excluded - `status` already
// says Paused, and a "Running" sensor that stays on through a pause is no use in an automation.
const ACTIVE_PHASES = new Set([3, 37, 11, 40, 12, 14, PHASE_CARE])

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

// ---------------------------------------------------------------------------------------------------
// Which controls a course actually lets you touch, and with which values.
//
// THIS IS OBSERVATION, NOT CAPABILITY DATA. The appliance never declares it. The 0x86 message the app
// exchanges while browsing courses turned out to be a device-wide feature list (length-prefixed ASCII
// keys like "201-2-1"), not a per-course mask, so unlike the air conditioners - which do answer with a
// capability bitmap - there is nothing here to read. Every row below comes from the owner working the
// panel and reporting which buttons did nothing.
//
// Deriving it from the traffic alone does not work, in either direction: a sweep that stops early
// under-reports, and side effects over-report - setting wash to none drags water temperature to none
// with it, which reads exactly like "temperature is selectable" if you only look at the bytes.
//
// `null` means the control is locked on that course. An absent key means the full range is available.
// Consequently this can be wrong, and it is advisory only: it drives a diagnostic sensor and nothing
// else. A write the appliance rejects simply leaves the record unchanged, which the raw options sensor
// makes visible.
type CourseLimits = {
    wash?: number[] | null
    water_temp?: number[] | null
    rinse?: number[] | null
    spin?: number[] | null
    steam?: false
}
const COURSE_LIMITS: Record<string, CourseLimits> = {
    114: { wash: [3, 7], steam: false }, // 인공지능세탁
    46: {}, // 표준 - the permissive one, everything on full range
    'ext:245': {}, // 표준1
    'ext:246': {}, // 타월1
    94: { wash: [0, 3], water_temp: null, spin: [0, 1, 2], steam: false }, // 울/섬세
    27: { wash: [0, 1, 3], water_temp: [2, 3, 8], spin: [0, 1, 2, 4], steam: false }, // 이불
    135: { wash: [0, 3], water_temp: null, steam: false }, // 쾌속스팀살균 - steam is driven by the
    // appliance here rather than by the user: its bit follows the wash stage on its own.
    55: { wash: null, water_temp: null, steam: false }, // 헹굼+탈수
    85: { wash: null, water_temp: null, rinse: null, spin: null, steam: false }, // 통살균 - nothing
    134: { wash: null, water_temp: null, rinse: null, spin: null, steam: false }, // 급속통헹굼 - nothing
}

// The whole dial, named by sweeping it one position at a time through a full revolution and writing the
// names down in order. The alignment is self-checking: the sweep started and ended on the same position
// and came back to the same value, and three of the courses had already been identified independently
// (Towels 1 and Tub Clean from the app, Rinse + Spin from a cycle that was actually run) - all three
// landed where the sweep said they would.
//
// A course that is not listed here leaves the select untouched and shows up in `current_course` as its
// raw number, so a dial position that has not been swept is visible rather than silently missing.
const COURSE: Record<number, string> = {
    0x72: 'AI Wash', // 인공지능세탁, 36 min
    0x5e: 'Wool / Delicates', // 울/섬세, 53 min
    0x2e: 'Normal', // 표준, 35 min
    0x55: 'Tub Clean', // 통살균, 124 min
    0x1b: 'Bedding', // 이불, 98 min
    0x87: 'Quick Steam Sanitize', // 쾌속스팀살균, 64 min
    0x37: 'Rinse + Spin', // 헹굼+탈수, 25 min
    0x86: 'Quick Tub Rinse', // 급속통헹굼, 12 min
}

// Reached through the 0xFF escape, with the real identifier in the second key. These two are read-only:
// selecting one needs a write carrying both keys at once, and the only capture of that shape also
// carried all eight option keys, so the two-key form on its own has never been seen on the wire.
const COURSE_EXT: Record<number, string> = {
    0xf5: 'Normal 1', // 표준1, 68 min
    0xf6: 'Towels 1', // 타월1, 82 min
}

// All four option scales were read off the panel by stepping each control through a full cycle on
// several courses and writing the displayed names down in order, with the sweep returning to its
// starting value so the alignment checks itself.
//
// Water temperature took two corrections. The capture session's notes had 0x05 as 40 degrees; it is 60.
// Then 0x00 was taken for the cold setting; it is not - cold is 0x08, and 0x00 means the stage is not
// used at all, which is why it appears exactly when the wash stage is set to none. There is a 30-degree
// setting after all.
const WATER_TEMP: Record<number, string> = { 0x00: 'none', 0x02: '30', 0x03: '40', 0x05: '60', 0x08: 'cold' }

// 0x02 and 0x04 have never appeared on any course swept so far.
const WASH: Record<number, string> = {
    0x00: 'none',
    0x01: 'light_soil',
    0x03: 'normal',
    0x05: 'intensive',
    0x06: 'pre_wash',
    0x07: 'soak',
}

// The gaps (0x03, 0x05, 0x07) are unused rather than unobserved - the dial steps straight over them.
const SPIN: Record<number, string> = {
    0x00: 'none',
    0x01: 'delicate',
    0x02: 'low',
    0x04: 'medium',
    0x06: 'high',
    0x08: 'dry_fit',
}
const BEEP: Record<number, string> = { 0: 'mute', 1: 'low', 2: 'medium', 3: 'high', 4: 'very_high' }
// Rinse is the count itself, and 0 means the stage is skipped. 0-5 were all stepped through.
const RINSE = [0, 1, 2, 3, 4, 5]

function invert(map: Record<number, string>): Record<string, number> {
    return Object.fromEntries(Object.entries(map).map(([k, v]) => [v, Number(k)]))
}
const WASH_BY_NAME = invert(WASH)
const WATER_TEMP_BY_NAME = invert(WATER_TEMP)
const SPIN_BY_NAME = invert(SPIN)
const BEEP_BY_NAME = invert(BEEP)
const COURSE_BY_NAME = invert(COURSE)

export default class Device extends AABBDevice {
    /** Last published remaining minutes, so the finish timestamp is only recomputed when it moves. */
    lastRemaining: number | undefined

    /**
     * Remote control is the gate for every command, not just some of them: with it switched off the
     * appliance accepts nothing and says nothing about why. It can only be switched on at the appliance
     * itself - which is the point of it - so there is no way to fix that from here, and refusing to
     * send would be worse than sending. All this does is leave a line in the log explaining a command
     * that appeared to do nothing.
     */
    remoteControl = false

    /** Last state record seen, so an extended-course write can carry the options along with it. */
    lastRecord: Buffer | undefined

    /**
     * Courses the select currently offers. Ten were named by sweeping the dial, but a dial position
     * that was missed - or a course on a sibling model reporting the same modelId - would otherwise be
     * unselectable forever. An unrecognised one is added here under its number and the discovery config
     * is republished, so it becomes selectable without waiting for the table to be updated.
     *
     * Nothing is ever removed. A course that has been seen once stays on the list: dropping it would
     * break any automation referring to it, and courses do not disappear from a dial.
     */
    courseOptions = [...Object.values(COURSE), ...Object.values(COURSE_EXT)]

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
                    remote_control: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-remote-control',
                        state_topic: '$this/remote_control',
                        name: 'Remote control',
                        icon: 'mdi:cellphone-wireless',
                    },
                    door_lock: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-door-lock',
                        state_topic: '$this/door_lock',
                        name: 'Door lock',
                        device_class: 'lock',
                    },
                    child_lock: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-child-lock',
                        state_topic: '$this/child_lock',
                        name: 'Child lock',
                        icon: 'mdi:account-lock',
                    },
                    wrinkle_care: {
                        platform: 'binary_sensor',
                        unique_id: '$deviceid-wrinkle-care',
                        state_topic: '$this/wrinkle_care',
                        name: 'Wrinkle care',
                        icon: 'mdi:tshirt-crew',
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
                    // The select can only ever hold one of the courses we have names for, and this
                    // washer's dial has many more than the four that have been run. This always shows
                    // something - the name when we know it, `#114` when we do not - so the course is
                    // visible even before its number has been identified.
                    current_course: {
                        platform: 'sensor',
                        unique_id: '$deviceid-current-course',
                        state_topic: '$this/current_course',
                        name: 'Current course',
                        icon: 'mdi:playlist-check',
                    },
                    end_time: {
                        platform: 'sensor',
                        unique_id: '$deviceid-end-time',
                        state_topic: '$this/end_time',
                        name: 'Finishes at',
                        device_class: 'timestamp',
                    },
                    available_options: {
                        platform: 'sensor',
                        unique_id: '$deviceid-available-options',
                        state_topic: '$this/available_options',
                        json_attributes_topic: '$this/available_options_attrs',
                        name: 'Adjustable options',
                        icon: 'mdi:tune-variant',
                        entity_category: 'diagnostic',
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
                        platform: 'switch',
                        unique_id: '$deviceid-laundry-care',
                        state_topic: '$this/laundry_care',
                        command_topic: '$this/laundry_care/set',
                        name: 'Laundry care when done',
                        icon: 'mdi:tumble-dryer',
                    },
                },
            }),
        )
    }

    /**
     * Switching the appliance off at the panel makes it drop its connection, so rethink drops the
     * device and every entity would go unavailable - which reads as "the washer has fallen off the
     * network" when it has simply been switched off, and hides the perfectly good state we already
     * hold. If the last thing it told us was that it was off, keep that on screen instead.
     *
     * The cost is deliberate: a washer that is switched off and then loses power or Wi-Fi keeps
     * reading "off" rather than going unavailable, because from here the two are indistinguishable.
     * A drop from any other state is still an unexpected one and is reported. rethink's own LWT
     * (`$rethink/availability`, combined with `availability_mode: 'all'`) still takes every entity
     * unavailable if the server itself goes away, so this only suppresses the per-device signal.
     */
    override drop() {
        if (this.lastRecord?.[OFF_PHASE] === PHASE_OFF) return
        super.drop()
    }

    processAABB(buf: Buffer) {
        if (buf[0] !== FROM_DEVICE || buf.length < 4) return

        const type = buf[1]
        // The 0xFF "extended length" form carries a 16-bit total length after the type byte. AABBDevice
        // has already removed the 4 envelope bytes, hence the +4.
        const extended = buf.readUInt16BE(2) === buf.length + 4
        const payload = extended ? buf.subarray(4) : buf.subarray(2)

        if (type === MSG_TUNNEL) {
            if (payload.length < 10) return

            const data = payload.subarray(10)
            // 0xEC stacks the previous record ahead of the current one; 0xEB carries the current one
            // alone. Same 66-byte layout either way.
            const offset =
                payload[6] === INNER_STATE ? CURRENT_RECORD_OFFSET : payload[6] === INNER_STATE_SINGLE ? 0 : -1
            if (offset < 0 || data.length < offset + RECORD_LEN) return
            this.processRecord(data.subarray(offset, offset + RECORD_LEN))
        } else if (type === MSG_SETTINGS_REPLY) {
            // 00 02 01 FF <n> [<key> <status>]*n 00 <record>
            if (payload.length < 5) return
            const start = 5 + payload[4] * 2 + 1
            if (payload.length < start + RECORD_LEN) return
            this.processRecord(payload.subarray(start, start + RECORD_LEN))
        }
    }

    processRecord(rec: Buffer) {
        this.lastRecord = rec
        const phase = rec[OFF_PHASE]
        const flags = rec[OFF_FLAGS]

        this.publishProperty('power', phase === PHASE_OFF ? 'OFF' : 'ON')
        this.publishProperty('status', STATUS[phase] ?? 'Unknown')
        this.publishProperty('status_code', phase)
        this.publishProperty('running', ACTIVE_PHASES.has(phase) ? 'ON' : 'OFF')
        this.publishProperty('drum_active', flags & FLAG_DRUM_ACTIVE ? 'ON' : 'OFF')
        this.remoteControl = (flags & FLAG_REMOTE_CONTROL) !== 0
        this.publishProperty('remote_control', this.remoteControl ? 'ON' : 'OFF')
        this.publishProperty('child_lock', flags & FLAG_CHILD_LOCK ? 'ON' : 'OFF')
        // device_class 'lock' is inverted by Home Assistant's convention: on means unlocked.
        this.publishProperty('door_lock', rec[OFF_DOOR_LOCK] ? 'OFF' : 'ON')
        this.publishProperty('wrinkle_care', rec[OFF_WRINKLE_CARE] & WRINKLE_CARE_ON ? 'ON' : 'OFF')
        this.publishProperty('turbowash', rec[OFF_TURBOSHOT] & TURBOSHOT_ON ? 'ON' : 'OFF')
        this.publishProperty('laundry_care', rec[OFF_LAUNDRY_CARE] & LAUNDRY_CARE_ON ? 'ON' : 'OFF')
        this.publishProperty('cycles', String(rec[OFF_CYCLES]))
        this.publishProperty('beep', BEEP[rec[OFF_BEEP]] ?? 'unknown')
        this.publishProperty('steam', rec[OFF_STEAM] & STEAM_ON ? 'ON' : 'OFF')

        // Only the wash clock counts down, so everything else would show a stale figure - and at the end
        // of a cycle the remaining-minutes byte sticks at 1 rather than reaching 0. The total is the
        // selected course's estimate though, which is worth seeing before pressing start, so it is
        // published whenever the appliance is on.
        const remaining = TIMED_PHASES.has(phase) ? rec[OFF_REMAIN_H] * 60 + rec[OFF_REMAIN_M] : 0
        this.publishProperty('remaining_time', remaining)

        // Recomputed only when the minute count actually moves. Doing it on every frame would push a
        // slightly different timestamp several times a second and fill the recorder with noise.
        if (remaining !== this.lastRemaining) {
            this.lastRemaining = remaining
            this.publishProperty(
                'end_time',
                remaining > 0 ? new Date(Date.now() + remaining * 60_000).toISOString() : 'None',
            )
        }
        this.publishProperty('total_time', phase === PHASE_OFF ? 0 : rec[OFF_TOTAL_H] * 60 + rec[OFF_TOTAL_M])
        this.publishProperty('rinse_remaining', rec[OFF_RINSE])

        // The course byte is not consumed - it survives the cycle, the finished state and even powering
        // off - so it is always worth publishing.
        const course = rec[OFF_COURSE]
        const label = this.courseLabel(course, rec[OFF_COURSE_EXT])
        this.registerCourse(label)
        this.publishProperty('course', label)
        this.publishProperty('current_course', label)
        // Depends only on which course is selected, so it is published in every phase, not just standby.
        this.publishLimits(course, rec[OFF_COURSE_EXT])

        // The rest are consumed as the appliance works through them and read 0 from the first stage
        // onwards, so they only report the selection while it sits at standby. Anywhere else,
        // republishing would overwrite the selects with meaningless values; Home Assistant keeps the
        // last value published. Gating this on the 0x10 flag instead was wrong - it stays set after a
        // cycle finishes, so the selects went unpublished for as long as the washer sat on Complete.
        if (phase !== PHASE_STANDBY) return

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
            `course=${course} ext=${rec[OFF_COURSE_EXT]} wash=${rec[OFF_WASH]} temp=${rec[OFF_WATER_TEMP]} rinse=${rec[OFF_RINSE]} spin=${rec[OFF_SPIN]} steam=${rec[OFF_STEAM]}`,
        )
    }

    courseLabel(course: number, ext: number) {
        if (course === COURSE_EXTENDED) return COURSE_EXT[ext] ?? `#ext${ext}`
        return COURSE[course] ?? `#${course}`
    }

    /** Add a course to the select and republish discovery, the once, when it is first seen. */
    registerCourse(label: string) {
        if (this.courseOptions.includes(label)) return
        this.courseOptions.push(label)
        const course = this.config?.components?.course as { options?: string[] } | undefined
        if (!course) return
        course.options = [...this.courseOptions]
        this.publishConfig()
    }

    /**
     * What the current course lets the user change. Advisory - see COURSE_LIMITS; the appliance does
     * not declare this, so it is a record of what was tried by hand rather than something authoritative.
     */
    publishLimits(course: number, ext?: number) {
        const limits = COURSE_LIMITS[course === COURSE_EXTENDED ? `ext:${ext}` : String(course)]
        if (!limits) {
            this.publishProperty('available_options', 'unknown')
            this.publishProperty('available_options_attrs', '{}')
            return
        }

        const named = (values: number[] | undefined | null, map: Record<number, string>) =>
            values === null ? null : (values ?? Object.keys(map).map(Number)).map((v) => map[v] ?? String(v))

        const attrs = {
            wash: named(limits.wash, WASH),
            water_temp: named(limits.water_temp, WATER_TEMP),
            rinse: limits.rinse === null ? null : (limits.rinse ?? RINSE).map(String),
            spin: named(limits.spin, SPIN),
            steam: limits.steam !== false,
        }
        const adjustable = Object.entries(attrs)
            .filter(([, v]) => (Array.isArray(v) ? v.length > 1 : v === true))
            .map(([k]) => k)

        this.publishProperty('available_options', adjustable.join(', ') || 'none')
        this.publishProperty('available_options_attrs', JSON.stringify(attrs))
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

    /**
     * Extended courses cannot be selected with the course key alone - the escape value needs the real
     * identifier alongside it, in one frame. The only capture of that shape is the app selecting Towels
     * 1, and it carried all eight option keys as well, so that is what is reproduced here rather than a
     * guessed two-pair frame. The options come from the last record, which is what the app was sending
     * too: its own idea of the current selection.
     */
    setExtendedCourse(id: number) {
        const rec = this.lastRecord
        if (!rec) return
        this.send(
            Buffer.from([
                0xf0,
                0xe5,
                0x00,
                0x02,
                0x01,
                0xff,
                0x0a,
                KEY_COURSE,
                COURSE_EXTENDED,
                KEY_COURSE_EXT,
                id,
                KEY_WASH,
                rec[OFF_WASH],
                KEY_RINSE,
                rec[OFF_RINSE],
                KEY_SPIN,
                rec[OFF_SPIN],
                KEY_WATER_TEMP,
                rec[OFF_WATER_TEMP],
                KEY_TURBOWASH,
                rec[OFF_TURBOSHOT] & TURBOSHOT_ON ? 1 : 0,
                KEY_STEAM,
                rec[OFF_STEAM] & STEAM_ON ? 1 : 0,
                0x43,
                0x00,
                0x7f,
                0x00,
                0x00,
            ]),
        )
    }

    // Sent by the app immediately after an operation write, but only when the drum is actually about to
    // turn - a pause never carries it.
    trigger() {
        this.send(Buffer.from('f024100101', 'hex'))
    }

    setProperty(prop: string, mqttValue: string) {
        // Settings writes are accepted with remote control off - measured, a hundred of them applied
        // that way, and the owner confirms the app's "send to washer" works without it. What needs it
        // is starting the machine remotely, so the warning is limited to that.
        if (!this.remoteControl && (prop === 'start' || prop === 'resume')) {
            log('status', `${this.id}: ${prop} sent while remote control is off - press start on the appliance instead`)
        }

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
                return this.setField(KEY_LAUNDRY_CARE, mqttValue === 'ON' ? 1 : 0)
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
        if (value !== undefined) return this.setField(key, value)

        if (prop !== 'course') return

        const ext = Object.entries(COURSE_EXT).find(([, name]) => name === mqttValue)
        if (ext) return this.setExtendedCourse(Number(ext[0]))

        // The auto-registered labels for courses we have no name for.
        const extNumber = /^#ext(\d+)$/.exec(mqttValue)
        if (extNumber) return this.setExtendedCourse(Number(extNumber[1]))
        const plain = /^#(\d+)$/.exec(mqttValue)
        if (plain) this.setField(KEY_COURSE, Number(plain[1]))
    }
}
