import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { DeviceDiscovery, type ComponentInfo, type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'
import { convertFreezerTemperature, convertFridgeTemperature, freezerRange, fridgeRange } from './fridge_common'

// 2REFO1DBN3__U - LG ThinQ refrigerator, Korean domestic (sales model T875MEE111.CKOR).
// deviceType 101. Every value below was measured on the owner's appliance on 2026-08-06 and
// labelled by them as they operated it; see patches.md "냉장고 2REFO1DBN3__U" for the evidence.
//
// TWO WIRE FRAMINGS
//   short:     AA <len:8>  <payload> <cksum> BB      - 10EC status, F017 writes
//   extended:  AA FF <type:16> <len:16> <payload> <trailer> BB
// AABBDevice.processData() slices by the ACTUAL buffer length, so both arrive at processAABB()
// intact; the extended frame simply carries its type and length inside the slice. Only the short
// framing matches AABBDevice.send()'s checksum (measured 67/67; the extended trailer is unsolved
// at 1/68 and looks like two bytes). We only ever send short frames, so send() is safe here.
//
// 10EC STATUS - 65 bytes, sent as a [previous][current] pair. The head of the block follows
// fridge_common.STATUS_FIELDS, and it diverges from index 10 onwards (status[10] reads 1 while
// the cloud reports displayLock UNLOCK), so nothing past index 9 is assumed - only measured
// fields are published.
//   [1]  fridge setpoint raw   -> 8 - raw   (1..7 C)      owner-verified against the panel
//   [2]  freezer setpoint raw  -> -14 - raw (-15..-23 C)  owner-verified against the panel
//   [3]  express freeze: 1=off 2=on
//   [7]  any door open: 0=closed 1=open  - LG's own model JSON calls this field "global";
//        it does NOT identify which door, and a short open can be missed entirely when the
//        open and the close fall between two status reports.
//   [17] smart care+ : 0=off 1=on   (fridge_common calls index 17 smartCare - independent agreement)
//   [40] beep / product button sound: 0=off 1=on
//
// 100A DOOR NOTIFICATION - the 42-byte extended frame. It names which panel moved, which the
// cloud API cannot do (refState carries only atLeastOneDoorOpen, and LG's own model JSON calls
// that field "global"). Offsets below are into the processAABB slice; add 2 for the frame
// offsets used in patches.md.
//   [10] 0x25 = the fridge side is speaking, 0x26 = the freezer side is
//   [21] fridge-side open flag           [22] freezer-side open flag
//   [23] fridge left   [24] fridge right   [26] front (door-in-door)
//   [27] freezer left  [28] freezer right
//
// It fires on a compartment's first open and its last close, and NOT while that compartment
// stays open - so [23]..[28] name a door, they do not track one. See COMPARTMENTS below.
//
// F017 WRITE - 118 payload bytes, 0xFF meaning "leave unchanged". The base message below is the
// one LG's own cloud sent this appliance, and it is byte-for-byte identical to the one upstream
// hardcodes in 2REF11EBIVPC4. Write offsets equal status offsets, and every write echoes back in
// a 10EC within ~1.2 s. Writing a value the appliance already holds produces NO echo, because
// 10EC only reports changes - silence after a write is not failure.
//   [1] fridge raw + [8]=1     [2] freezer raw + [8]=1     [3] express freeze
//   [17] smart care+           [40] beep
// The [8] zone selector accompanies temperature writes only; it was absent from every captured
// express-freeze, beep and smart-care write.
//
// NOT published, deliberately: status[42] (something wrote it twice during the capture and
// neither we nor the owner know what it is), status[64]=120 (matches the cloud's
// doorOpenAlarmTime but was never exercised), and the whole of [10]..[64] besides [17] and [40].

const STATUS_LENGTH = 65
const DOOR_FRAME_LENGTH = 38 // the 42-byte extended frame, less AA <b1> and <trailer> BB
const DOOR_COMPARTMENT_FRIDGE = 0x25
const DOOR_COMPARTMENT_FREEZER = 0x26

/*
 * The notification fires on a compartment's FIRST open - naming the door that opened it - and on
 * its LAST close. Nothing in between. The owner walked it through step by step on the appliance:
 *
 *   open fridge LEFT   -> notification, names Left
 *   open fridge RIGHT  -> nothing (the compartment was already open)
 *   close fridge LEFT  -> nothing (the compartment is still open)
 *   close fridge RIGHT -> notification, every slot clear
 *
 * That rule makes per-door state impossible - through the middle two steps the appliance says
 * nothing, so no code can know the second door moved - and makes COMPARTMENT state exactly right:
 * the fridge side reads open, open, open, closed, which is true at all four steps. The two
 * compartments are independent, each announced by its own value at [10].
 */
const COMPARTMENTS = {
    [DOOR_COMPARTMENT_FRIDGE]: {
        open: 'door_fridge',
        lastDoor: 'last_door_fridge',
        flag: 21, // slice offset of the fridge-side open flag
        doors: { 23: 'Left', 24: 'Right', 26: 'Front' },
    },
    [DOOR_COMPARTMENT_FREEZER]: {
        open: 'door_freezer',
        lastDoor: 'last_door_freezer',
        flag: 22,
        doors: { 27: 'Left', 28: 'Right' },
    },
} as const

/*
 * WITHDRAWN, both rounds on 2026-08-06/07, and both because of what the notification turned out
 * to be rather than where its bytes are:
 *
 *   the five per-door binary sensors - impossible, see COMPARTMENTS above. Two doors of one
 *     compartment open and the appliance reports nothing, so the second one cannot be known.
 *   `last_door` - a single global "last door reported", replaced by one per compartment so a
 *     freezer movement stops overwriting what the fridge side last said.
 *
 * Removal stubs carry `platform` and NOTHING else: mqtt/discovery.py pops the platform and treats
 * what remains, if empty, as a removal. Adding unique_id - or any other key - silently turns the
 * removal back into a registration. Omitting the key entirely is worse still: it only stops a
 * fresh install creating the entity and leaves existing ones live forever. Both rounds were
 * deployed, so both need stubs.
 * Safe to delete once every installation has run this version once.
 */
const WITHDRAWN_COMPONENTS: [string, string][] = [
    ['door_fridge_left', 'binary_sensor'],
    ['door_fridge_right', 'binary_sensor'],
    ['door_front', 'binary_sensor'],
    ['door_freezer_left', 'binary_sensor'],
    ['door_freezer_right', 'binary_sensor'],
    ['last_door', 'sensor'],
]

// Captured from this appliance (2026-08-06): AA 7C F0 17 <118 bytes> <cksum> BB.
const F017_BASE =
    'F017' +
    'FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF' +
    '000000FFFF00FFFFFFFF00FFFFFFFFFFFFFFFFFF00FFFFFF1E' +
    'FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0A' +
    'FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF00' +
    'FFFFFFFFFFFFFFFFFFFFFFFFFFFFFF'

export default class Device extends AABBDevice {
    readonly deviceConfig: DeviceDiscovery

    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq)
        this.deviceConfig = HADevice.config(meta, { name: 'LG Fridge' })

        // This unit reports status[8]=1 (Celsius) and its panel is in Celsius, so the config is
        // published immediately rather than waiting for a status frame. Switching the appliance
        // to Fahrenheit has never been exercised; processStatus() warns if that byte ever changes.
        this.setConfig(
            allowExtendedType({
                ...this.deviceConfig,
                components: {
                    fridge_setpoint: {
                        platform: 'number',
                        device_class: 'temperature',
                        unique_id: '$deviceid-fridge_setpoint',
                        state_topic: '$this/fridge_setpoint',
                        command_topic: '$this/fridge_setpoint/set',
                        name: 'Fridge temperature',
                        step: 1,
                        ...fridgeRange('C'),
                    },
                    freezer_setpoint: {
                        platform: 'number',
                        device_class: 'temperature',
                        unique_id: '$deviceid-freezer_setpoint',
                        state_topic: '$this/freezer_setpoint',
                        command_topic: '$this/freezer_setpoint/set',
                        name: 'Freezer temperature',
                        step: 1,
                        ...freezerRange('C'),
                    },
                    express_freeze: {
                        platform: 'switch',
                        icon: 'mdi:snowflake',
                        unique_id: '$deviceid-express_freeze',
                        state_topic: '$this/express_freeze',
                        command_topic: '$this/express_freeze/set',
                        name: 'Express Freeze',
                    },
                    beep: {
                        platform: 'switch',
                        icon: 'mdi:volume-high',
                        unique_id: '$deviceid-beep',
                        state_topic: '$this/beep',
                        command_topic: '$this/beep/set',
                        name: 'Beep Sound',
                        entity_category: 'config',
                    },
                    smart_care: {
                        platform: 'switch',
                        icon: 'mdi:stethoscope',
                        unique_id: '$deviceid-smart_care',
                        state_topic: '$this/smart_care',
                        command_topic: '$this/smart_care/set',
                        name: 'Smart Care+',
                        entity_category: 'config',
                    },
                    door: {
                        platform: 'binary_sensor',
                        device_class: 'door',
                        unique_id: '$deviceid-door',
                        state_topic: '$this/door',
                        name: 'Door',
                    },
                    door_fridge: {
                        platform: 'binary_sensor',
                        device_class: 'door',
                        unique_id: '$deviceid-door_fridge',
                        state_topic: '$this/door_fridge',
                        name: 'Fridge compartment',
                    },
                    door_freezer: {
                        platform: 'binary_sensor',
                        device_class: 'door',
                        unique_id: '$deviceid-door_freezer',
                        state_topic: '$this/door_freezer',
                        name: 'Freezer compartment',
                    },
                    // Which panel last opened its compartment. Diagnostic, and NOT a state: the
                    // notification is silent while a compartment stays open, so this can name a
                    // door that has since been shut. The two sensors above answer "open?".
                    last_door_fridge: {
                        platform: 'sensor',
                        icon: 'mdi:door-open',
                        unique_id: '$deviceid-last_door_fridge',
                        state_topic: '$this/last_door_fridge',
                        name: 'Last fridge door',
                        entity_category: 'diagnostic',
                    },
                    last_door_freezer: {
                        platform: 'sensor',
                        icon: 'mdi:door-open',
                        unique_id: '$deviceid-last_door_freezer',
                        state_topic: '$this/last_door_freezer',
                        name: 'Last freezer door',
                        entity_category: 'diagnostic',
                    },
                    ...Object.fromEntries(
                        WITHDRAWN_COMPONENTS.map(([name, platform]) => [name, { platform } as ComponentInfo]),
                    ),
                },
            }),
        )
    }

    start() {
        // Deliberately silent. This appliance reports a 10EC on every state change and an
        // unprompted one every hour (measured 2026-08-06: 18:07:37 and 19:07:37, no change in
        // either), so nothing has to be asked for. Upstream's other fridges open with
        // F0ED1211010000010400; sending an unverified "query" to an appliance is exactly how
        // FX___S was made to chirp at a switched-off machine - see patches.md.
    }

    processAABB(buf: Buffer) {
        if (buf.length === 2 + STATUS_LENGTH * 2 && buf[0] === 0x10 && buf[1] === 0xec) {
            // 10EC: [previous status][current status]
            this.processStatus(buf.subarray(2 + STATUS_LENGTH, 2 + STATUS_LENGTH * 2))
        }

        if (buf.length === DOOR_FRAME_LENGTH && buf[0] === 0x10 && buf[1] === 0x0a) {
            this.processDoors(buf)
        }
    }

    processStatus(status: Buffer) {
        if (status[8] !== 1) {
            // Every measurement on this unit had Celsius here, and the published min/max were
            // built for it. Rather than silently mis-scale, say so.
            console.warn(`2REFO1DBN3__U: status[8]=${status[8]}, expected 1 (Celsius) - setpoints may be wrong`)
        }

        this.publishProperty('fridge_setpoint', convertFridgeTemperature('C', status[1]))
        this.publishProperty('freezer_setpoint', convertFreezerTemperature('C', status[2]))
        this.publishProperty('express_freeze', status[3] === 2 ? 'ON' : 'OFF')
        this.publishProperty('door', status[7] === 1 ? 'ON' : 'OFF')

        // Backstop for the compartment sensors. status[7] is LG's own "at least one door open",
        // so zero means every panel is shut - a definition, not an inference. It recovers both
        // compartments if a release notification is ever missed, which was measured happening
        // when doors are worked in rapid succession. At 1 it says nothing about WHICH side, so
        // it must not touch them.
        if (status[7] === 0) {
            for (const c of Object.values(COMPARTMENTS)) this.publishProperty(c.open, 'OFF')
        }

        this.publishProperty('smart_care', status[17] === 1 ? 'ON' : 'OFF')
        this.publishProperty('beep', status[40] === 1 ? 'ON' : 'OFF')
    }

    // `notify` is the processAABB slice, NOT the whole frame: notify[i] === frame[i + 2].
    processDoors(notify: Buffer) {
        // Every captured 42-byte frame announced one compartment here, and it only ever speaks
        // for that one. Touching the other compartment's sensor from this frame would clear a
        // door that is genuinely still open.
        const compartment = COMPARTMENTS[notify[10] as keyof typeof COMPARTMENTS]
        if (!compartment) return

        const open = notify[compartment.flag] === 1
        this.publishProperty(compartment.open, open ? 'ON' : 'OFF')

        if (!open) return // a release names nothing; leave the last name standing
        for (const [offset, name] of Object.entries(compartment.doors)) {
            if (notify[Number(offset)] === 1) {
                this.publishProperty(compartment.lastDoor, name)
                return
            }
        }
    }

    sendSetting(mutate: (payload: Buffer) => void) {
        const message = Buffer.from(F017_BASE, 'hex')
        mutate(message.subarray(2)) // hand over the payload, so offsets match the status block
        this.send(message)
    }

    setProperty(prop: string, mqttValue: string) {
        if (prop === 'fridge_setpoint') {
            this.sendSetting((p) => {
                p[1] = convertFridgeTemperature('C', Number(mqttValue))
                p[8] = 1 // zone selector, required alongside a temperature
            })
        } else if (prop === 'freezer_setpoint') {
            this.sendSetting((p) => {
                p[2] = convertFreezerTemperature('C', Number(mqttValue))
                p[8] = 1
            })
        } else if (prop === 'express_freeze') {
            this.sendSetting((p) => {
                p[3] = mqttValue === 'ON' ? 2 : 1
            })
        } else if (prop === 'smart_care') {
            this.sendSetting((p) => {
                p[17] = mqttValue === 'ON' ? 1 : 0
            })
        } else if (prop === 'beep') {
            this.sendSetting((p) => {
                p[40] = mqttValue === 'ON' ? 1 : 0
            })
        } else {
            console.warn(`Unknown property ${prop}`)
        }
    }
}
