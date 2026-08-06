import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { DeviceDiscovery, type Connection } from '../homeassistant'
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
// 100A DOOR NOTIFICATION - the 42-byte extended frame, which resolves all five panels
// individually. The cloud API cannot do this: refState carries only atLeastOneDoorOpen.
// Offsets below are into the processAABB slice; add 2 for the frame offsets used in patches.md.
//   [10] 0x25 = a fridge-side door moved, 0x26 = a freezer-side door moved
//   [21] any fridge-side door open      [22] any freezer-side door open
//   [23] fridge left   [24] fridge right   [26] front (door-in-door)
//   [27] freezer left  [28] freezer right
// A frame with every slot clear means every door is closed - the message carries the whole
// door state, not a delta.
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

const DOORS: Record<string, number> = {
    door_fridge_left: 23,
    door_fridge_right: 24,
    door_front: 26,
    door_freezer_left: 27,
    door_freezer_right: 28,
}

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
                    door_fridge_left: {
                        platform: 'binary_sensor',
                        device_class: 'door',
                        unique_id: '$deviceid-door_fridge_left',
                        state_topic: '$this/door_fridge_left',
                        name: 'Fridge door (left)',
                    },
                    door_fridge_right: {
                        platform: 'binary_sensor',
                        device_class: 'door',
                        unique_id: '$deviceid-door_fridge_right',
                        state_topic: '$this/door_fridge_right',
                        name: 'Fridge door (right)',
                    },
                    door_front: {
                        platform: 'binary_sensor',
                        device_class: 'door',
                        unique_id: '$deviceid-door_front',
                        state_topic: '$this/door_front',
                        name: 'Front door',
                    },
                    door_freezer_left: {
                        platform: 'binary_sensor',
                        device_class: 'door',
                        unique_id: '$deviceid-door_freezer_left',
                        state_topic: '$this/door_freezer_left',
                        name: 'Freezer door (left)',
                    },
                    door_freezer_right: {
                        platform: 'binary_sensor',
                        device_class: 'door',
                        unique_id: '$deviceid-door_freezer_right',
                        state_topic: '$this/door_freezer_right',
                        name: 'Freezer door (right)',
                    },
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
        this.publishProperty('smart_care', status[17] === 1 ? 'ON' : 'OFF')
        this.publishProperty('beep', status[40] === 1 ? 'ON' : 'OFF')
    }

    // `notify` is the processAABB slice, NOT the whole frame: notify[i] === frame[i + 2].
    processDoors(notify: Buffer) {
        // Only notifications that announce a compartment carry door state. Every one of the 22
        // captured 42-byte frames had one of these two values here.
        if (notify[10] !== DOOR_COMPARTMENT_FRIDGE && notify[10] !== DOOR_COMPARTMENT_FREEZER) return

        for (const [prop, offset] of Object.entries(DOORS)) {
            this.publishProperty(prop, notify[offset] === 1 ? 'ON' : 'OFF')
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
