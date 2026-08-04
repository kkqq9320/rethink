import TLVDevice, { FieldDefinition } from './tlv_device'
import { Device as Thinq2Device } from '../thinq2/device'
import { ClimateComponent, ComponentInfo, DeviceDiscovery, type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import * as TLV from '@/util/tlv'
import { racAirTemp, racPipeTemp } from '@/util/ac_tables'
import log from '@/util/logging'
import HADevice from './base'

type PowerModeChangeHook = () => void
type CheckMode = (arg: number) => boolean

// Operating modes by their 0x1f9 wire value, which is also their bit position in the 0x2c1
// capability mask. One table, read one way to build the mode list HA is offered and the other
// way to turn a selection back into a wire value - they cannot drift apart.
const clipOpModes: Record<number, string> = { 0: 'cool', 1: 'dry', 2: 'fan_only', 4: 'heat', 6: 'auto' }

/*
 * Fan levels, in the order the appliance's own UI lists them. Three columns because on this axis
 * the bit index and the wire value are NOT the same number: the five steps and nature happen to
 * line up, but super breeze is bit 22 of 0x2c2 and wire value 16, per LG's airState.windStrength
 * enum for this modelId. Reading bit 22 as wire 22 would be wrong.
 *
 * Names confirmed against the appliance by its owner: the app lists 초미풍 first, then 1..5, and
 * offers 자연풍 separately. There is NO 'auto' on this model - LG's enum for it does not contain
 * one, and what the handler used to call auto is 자연풍. It is listed here with the speeds rather
 * than split into a switch because the wire has one field: bit 8 lives in the windStrength
 * capability mask, so nature is a value of 0x1fa, and the app's toggle is presentation.
 *
 * The 'very low'..'very high' labels for the five steps are kept from before, so existing
 * automations that use them keep working; the appliance shows them as 1..5.
 */
const clipFanModes: { bit: number; clip: number; ha: string }[] = [
    { bit: 22, clip: 16, ha: 'super breeze' },
    { bit: 2, clip: 2, ha: 'very low' },
    { bit: 3, clip: 3, ha: 'low' },
    { bit: 4, clip: 4, ha: 'medium' },
    { bit: 5, clip: 5, ha: 'high' },
    { bit: 6, clip: 6, ha: 'very high' },
    { bit: 8, clip: 8, ha: 'nature' },
]

// LG's own names for the auto-dry strength axis, taken from this model's ThinQ model JSON
// (`support.airState.autoDry.windStrength`). The index is the bit position in the 0x192
// capability mask, which on this axis is also the value 0x1f2 carries: on PAC_910604_WW the five
// declared bits 2-6 line up with the levels 1..5 that appliance shows on its own panel.
const autoDryLevels: Record<number, string> = {
    2: 'low',
    3: 'low_mid',
    4: 'mid',
    5: 'mid_high',
    6: 'high',
}
export default class Device extends TLVDevice {
    meta: Metadata
    initialValuesReceived: boolean = false
    powerChangeHooks: PowerModeChangeHook[] = []
    powerStatePrev?: boolean
    modeChangeHooks: PowerModeChangeHook[] = []
    modePrev?: string
    airClean: boolean = false
    jetMode: boolean = false
    energySave: boolean = false
    tlvBlacklistDisableTimer: ReturnType<typeof setTimeout> | undefined
    increasedQueryIntervalTimeout: ReturnType<typeof setTimeout> | undefined
    filterUsedTime: number = 0
    filterLifeTime: number = 0
    filterChangedDate: number = 0
    filterInitialQueryTimeout: ReturnType<typeof setTimeout> | undefined
    filterQueryTimer: ReturnType<typeof setInterval> | undefined

    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq)
        this.meta = meta
    }

    drop() {
        if (this.tlvBlacklistDisableTimer != undefined) {
            clearTimeout(this.tlvBlacklistDisableTimer)
            this.tlvBlacklistDisableTimer = undefined
        }

        if (this.increasedQueryIntervalTimeout != undefined) {
            clearTimeout(this.increasedQueryIntervalTimeout)
            this.increasedQueryIntervalTimeout = undefined
        }

        if (this.filterInitialQueryTimeout != undefined) {
            clearTimeout(this.filterInitialQueryTimeout)
            this.filterInitialQueryTimeout = undefined
        }

        if (this.filterQueryTimer != undefined) {
            clearInterval(this.filterQueryTimer)
            this.filterQueryTimer = undefined
        }

        super.drop()
    }

    processPrivData(cmd: number, buf9: number, data: Buffer) {
        if (cmd == 0x02) this.processFilterData(buf9, data)
    }

    processPrivDataCmdResp(success: boolean, buf1: number, cmd: number, data: Buffer) {
        if (cmd == 0x2) this.processFilterCmdResp(success, data)
    }

    sendFilterQuery() {
        this.sendPrivCommand(0x02, 0x02)
    }

    sendFilterReset() {
        if (!this.filterLifeTime) throw new Error('Filter lifetime not known')

        const now = new Date()
        const date = now.getUTCFullYear() * 10000 + (now.getUTCMonth() + 1) * 100 + now.getUTCDate()

        const buf = Buffer.alloc(4 * 3)
        // yes, it's opposite endianness vs read cmd
        buf.writeUInt32BE(this.filterLifeTime, 1 * 4)
        buf.writeUInt32BE(date, 2 * 4)

        log('status', this.id, 'sending filter reset')
        this.sendPrivCommand(0x02, 0x01, buf)
    }

    isCapsResponse(tlvArray: TLV.TLV[]) {
        /* eeprom checksum */
        return tlvArray.some(({ t, v }) => t === 0x2da)
    }

    isValuesResponse(tlvArray: TLV.TLV[]) {
        /* power */
        return tlvArray.length >= 10 && tlvArray.some(({ t, v }) => t === 0x1f7)
    }

    valuesReceived() {
        if (this.initialValuesReceived) return
        this.initialValuesReceived = true

        // we want to be informed about all TLV changes - set an empty blacklist
        this.thinq.send('setMaskingInfo', 0, { blacklist_tlv: '1200' })

        // give modem some time to process the command before continuing
        this.tlvBlacklistDisableTimer = setTimeout(() => {
            this.tlvBlacklistDisableTimer = undefined

            if (!(this.raw_clip_state[0x2f1] & 1 || this.raw_clip_state[0x2f1] & 0x200)) {
                // no mFilter, check basic filter management support
                this.initProbeForFilter()
            } else {
                // unsupported mFilter management support
                this.initMakeSetConfig()
            }
        }, 500)
    }

    initProbeForFilter() {
        log('status', this.id, 'sending initial filter data query')
        this.sendFilterQuery()

        this.filterInitialQueryTimeout = setTimeout(() => {
            this.filterInitialQueryTimeout = undefined

            log('status', this.id, 'filter data query timeout, assuming no filter')
            this.initMakeSetConfig()
        }, 5 * 1000)
    }

    processFilterData(buf9: number, data: Buffer) {
        if (data.length < 1 + 3 * 4) {
            log('status', this.id, 'filter data too short:', data.length)
            return
        }

        this.filterUsedTime = data.readUInt32LE(1 + 0 * 4)
        this.filterLifeTime = data.readUInt32LE(1 + 1 * 4)
        this.filterChangedDate = data.readUInt32LE(1 + 2 * 4)

        // if this was the initial filter query the device config is ready now
        if (this.filterInitialQueryTimeout != undefined) {
            log('status', this.id, 'received initial filter data')

            clearTimeout(this.filterInitialQueryTimeout)
            this.filterInitialQueryTimeout = undefined

            this.initMakeSetConfig()
        } else {
            // if this was not the initial query just update the HA values
            this.publishFilterData()
        }
    }

    publishFilterData() {
        const changedDate =
            Math.floor(this.filterChangedDate / 10000)
                .toString()
                .padStart(4, '0') +
            '-' +
            (Math.floor(this.filterChangedDate / 100) % 100).toString().padStart(2, '0') +
            '-' +
            (this.filterChangedDate % 100).toString().padStart(2, '0')

        this.HA.publishProperty(this.id, 'filterused', this.filterUsedTime)
        this.HA.publishProperty(this.id, 'filterlife', this.filterLifeTime)
        this.HA.publishProperty(this.id, 'filterchangeddate', changedDate)
    }

    processFilterCmdResp(success: boolean, data: Buffer) {
        if (!success) {
            log('status', this.id, 'filter reset failed')
            return
        }

        log('status', this.id, 'filter reset okay, re-querying')
        this.sendFilterQuery()
    }

    updateClimateAction() {
        // also updates query interval
        const modeTLV = this.getModeTLV()

        let iduRunning = true
        const iduRunningTLVNum = this.getIDUActionRunningTLVNum()
        if (iduRunningTLVNum != null) {
            iduRunning = this.raw_clip_state[iduRunningTLVNum] !== 0
        }

        const modes2ha = ['cooling', 'drying', 'fan', undefined, 'heating']
        let action: string | undefined = undefined
        let increaseQueryInterval = false
        if (this.getPowerTLV() === 0) {
            action = 'off'
        } else if ((modeTLV === 0 || modeTLV === 1 || modeTLV === 4 || modeTLV === 6) && !iduRunning) {
            action = 'idle'
        } else if (modeTLV === 6) {
            // TODO: figure out how to detect the actual running mode in Auto
            // For now, clear the reported action.
            action = 'None'
            increaseQueryInterval = true // assume it is running
        } else {
            action = modes2ha[modeTLV]
            increaseQueryInterval = action != null && action !== 'fan'
        }

        if (action != null) this.HA.publishProperty(this.id, 'climate-action', action)
        this.updateQueryInterval(increaseQueryInterval)
    }

    updateQueryInterval(increaseQueryInterval: boolean) {
        if (increaseQueryInterval) {
            if (this.increasedQueryIntervalTimeout != undefined) {
                clearTimeout(this.increasedQueryIntervalTimeout)
                this.increasedQueryIntervalTimeout = undefined
            }

            /*
             * When in one of active modes update more frequently
             * since parameters can change rapidly:
             * every a bit less than half a minute.
             *
             * This matches the observed ODU parameter recalculation intervals:
             * compressor Hz - every 30 seconds,
             * EEV openings - every 30 seconds during transient periods.
             */
            this.setQueryInterval((30 - 2) * 1000)
        } else if (this.increasedQueryIntervalTimeout == null) {
            /*
             * Reset to the default interval after 15 minutes,
             * hopefully things returned to steady idle state by this time.
             */
            this.increasedQueryIntervalTimeout = setTimeout(
                () => {
                    this.increasedQueryIntervalTimeout = undefined
                    this.setQueryInterval()
                },
                15 * 60 * 1000,
            )
        }
    }

    getPowerTLV() {
        return this.raw_clip_state[0x1f7]
    }

    getModeTLV() {
        return this.raw_clip_state[0x1f9]
    }

    getIDUActionRunningTLVNum() {
        if (this.raw_clip_state[0x189] != null) {
            return 0x189 // IDUThermoOnOff
        }
        if (this.raw_clip_state[0x6c] != null) {
            return 0x6c
        }

        return undefined
    }

    initMakeSetConfig() {
        /*
         * Which operating modes this appliance actually has, from 0x2c1 - a bitmask whose bit
         * index is the value 0x1f9 carries. Three sources agree on the unit this was measured
         * on: the mask reads 7 (bits 0,1,2), the 0x2d7 mode list in the same capability reply
         * is 0,1,2, and LG's ThinQ model JSON declares support.airState.opMode as cool/dry/fan
         * for this modelId.
         *
         * It cannot be a per-model constant. A second, real RAC_056905_WW - the one the test
         * fixtures were taken from - reads 0x2c1 = 87, bits 0,1,2,4,6, and does have heat and
         * auto. One modelId, two different sets of modes.
         *
         * Left unset, HA falls back to its own default list and offers heat and auto on a unit
         * that has neither; selecting one is ACKed on the wire and never comes back in a state
         * frame, so the entity silently disagrees with the appliance. An appliance that does not
         * report 0x2c1 at all keeps that fallback rather than getting an empty list.
         */
        /*
         * Same treatment for the fan levels, 0x2c2. Left hardcoded, the wall unit offered an
         * 'auto' it does not have - that value is 자연풍 - and hid 초미풍 entirely, which the mask
         * declares at bit 22. An appliance that does not report 0x2c2 keeps the old fixed list.
         */
        const fanMask = this.raw_clip_state[0x2c2]
        const fanModes = fanMask ? clipFanModes.filter((m) => (fanMask >> m.bit) & 1).map((m) => m.ha) : undefined

        const opModeMask = this.raw_clip_state[0x2c1]
        const opModes = opModeMask
            ? [
                  'off',
                  ...Object.entries(clipOpModes)
                      .filter(([bit]) => (opModeMask >> Number(bit)) & 1)
                      .map(([, name]) => name),
              ]
            : undefined

        const config: DeviceDiscovery & { components: { climate: ClimateComponent } } = allowExtendedType({
            ...HADevice.config(this.meta, { name: 'LG Air Conditioner' }),
            components: {
                climate: {
                    platform: 'climate',
                    unique_id: '$deviceid-climate',
                    name: null,
                    action_topic: '$this/climate-action',
                    temperature_unit: 'C',
                    /* TODO: detect 0.5 C vs 1 C step */
                    temp_step: 0.5,
                    precision: 0.5,
                    /* TODO: some devices report these temp ranges via tags 0x2e1 - 0x2ec */
                    min_temp: 18,
                    max_temp: 30,
                    fan_modes: fanModes ?? ['auto', 'very low', 'low', 'medium', 'high', 'very high'],
                    ...(opModes ? { modes: opModes } : {}),
                } satisfies ClimateComponent,
            },
        })

        this.addField(config, {
            id: 0x1fd,
            name: 'current_temperature',
            comp: 'climate',
            state_topic: 'topic',
            writable: false,
            read_xform: (raw) => raw / 2,
        })
        this.addField(config, {
            id: 0x1f7,
            name: 'power',
            comp: 'climate',
            readable: false,
            write_xform: (val) => (val === 'ON' ? 1 : 0),
            /*  0x1f7 is not necessary for ON but does not seem to hurt either */
            write_attach: (raw) => (raw ? [0x1f9, 0x1fa, 0x1fe] : []),
            read_xform: (raw) => (raw ? 'ON' : 'OFF'),
            read_callback: (val) => {
                // update 'mode' instead
                this.processKeyValue(0x1f9, this.raw_clip_state[0x1f9])

                const powerState = val === 'ON'
                if (this.powerStatePrev !== powerState) for (const hook of this.powerChangeHooks) hook()
                this.powerStatePrev = powerState

                return false
            },
        })

        this.addField(config, {
            id: 0x1f9,
            name: 'mode',
            comp: 'climate',
            read_xform: (raw) => {
                const modes2ha = ['cool', 'dry', 'fan_only', undefined, 'heat', undefined, 'auto']
                if (this.getPowerTLV() === 0) return 'off'
                return modes2ha[raw]
            },
            read_callback: (val) => {
                if (typeof val !== 'string') return true
                if (this.modePrev !== val) for (const hook of this.modeChangeHooks) hook()
                this.modePrev = val
                return true
            },
            write_xform: (val) => {
                const modes2clip = Object.fromEntries(Object.entries(clipOpModes).map(([clip, ha]) => [ha, +clip]))
                if (val === 'off') {
                    // Call function power (0x1f7) with value OFF
                    this.setProperty('climate-power', 'OFF')
                    return null
                }
                return modes2clip[val]
            },
            write_attach: [0x1fa, 0x1fe],
        })

        this.addField(config, {
            id: 0x1fa,
            name: 'fan_mode',
            comp: 'climate',
            // Read against the whole table, not just the declared subset: a level the appliance
            // reports but did not advertise should still be named rather than blanking the entity.
            read_xform: (raw) => clipFanModes.find((m) => m.clip === raw)?.ha,
            write_xform: (val) => clipFanModes.find((m) => m.ha === val)?.clip,
            write_attach: [0x1f9, 0x1fe],
        })

        this.addField(config, {
            id: 0x1fe,
            name: 'temperature',
            comp: 'climate',
            read_xform: (raw) => raw / 2,
            write_xform: (val) => Math.round(Number(val) * 2),
            write_attach: [0x1f9, 0x1fa],
        })

        if (this.raw_clip_state[0x2cd] & 4) {
            /*
             * The appliance's app offers a '집중 회전' (focused swing) alongside the six fixed
             * positions and the full sweep, in three flavours the owner names upper / middle /
             * lower. They are VALUES OF THIS SAME TAG, measured 2026-08-04 by operating each one
             * from the LG app while recording (wall-swing-20260804.jsonl):
             *
             *      upper   0x321 = 14        middle  0x321 = 25        lower   0x321 = 36
             *
             * Each was captured twice, in two passes that agree, and every write is a lone
             * single-TLV frame - nothing else is written alongside - so the mutual exclusion with
             * 'on' and the fixed positions costs nothing here: writing 14 replaces 100 the way
             * writing 3 does. The same sweep re-sent 6 and 5 as positive controls and they came
             * back as 6 and 5, which is also what fixes the notes as trailing their actions.
             *
             * They are NOT named for a vane range, deliberately. 14 / 25 / 36 look like the
             * two-digit range encoding the horizontal axis uses below (13 = '1-3', 35 = '3-5'),
             * which would read as 1-4 / 2-5 / 3-6 - but the owner watched the middle one and
             * reported 2..4, not 2..5. The wire values are measured; the range reading is an
             * inference that one observation already disagrees with, so the labels say what the
             * app's control says and the range stays a note.
             *
             * Not gated on a capability bit. 0x2cd = 2097157 here = bits 0, 2 and 21; bit 2 is
             * this whole axis and bit 21 is unexplained and a candidate, but no unit WITHOUT the
             * focus control has been seen, so gating on it would be a guess. The surrounding
             * list is static in the same way.
             */
            config['components']['climate']['swing_modes'] = [
                '1',
                '2',
                '3',
                '4',
                '5',
                '6',
                'focus upper',
                'focus middle',
                'focus lower',
                'on',
                'off',
            ]
            this.addField(config, {
                id: 0x321,
                name: 'swing_mode',
                comp: 'climate',
                read_xform: (raw) => {
                    const modes2ha = ['off', '1', '2', '3', '4', '5', '6']
                    modes2ha[14] = 'focus upper'
                    modes2ha[25] = 'focus middle'
                    modes2ha[36] = 'focus lower'
                    modes2ha[100] = 'on'
                    return modes2ha[raw]
                },
                write_xform: (val) => {
                    const modes2clip: Record<string, number> = {
                        off: 0,
                        '1': 1,
                        '2': 2,
                        '3': 3,
                        '4': 4,
                        '5': 5,
                        '6': 6,
                        'focus upper': 14,
                        'focus middle': 25,
                        'focus lower': 36,
                        on: 100,
                    }
                    return modes2clip[val]
                },
            })
        }

        if (this.raw_clip_state[0x2cd] & 8) {
            config['components']['climate']['swing_horizontal_modes'] = [
                '1',
                '2',
                '3',
                '4',
                '5',
                '1-3',
                '3-5',
                'on',
                'off',
            ]
            this.addField(config, {
                id: 0x322,
                name: 'swing_horizontal_mode',
                comp: 'climate',
                read_xform: (raw) => {
                    const modes2ha = ['off', '1', '2', '3', '4', '5']
                    modes2ha[13] = '1-3'
                    modes2ha[35] = '3-5'
                    modes2ha[100] = 'on'
                    return modes2ha[raw]
                },
                write_xform: (val) => {
                    const modes2clip: Record<string, number> = {
                        off: 0,
                        '1': 1,
                        '2': 2,
                        '3': 3,
                        '4': 4,
                        '5': 5,
                        '1-3': 13,
                        '3-5': 35,
                        on: 100,
                    }
                    return modes2clip[val]
                },
            })
        }

        this.addOptionalSensorField(config, 0x221, 'error', 'Error code', 'mdi:alert')
        this.addOptionalSensorField(
            config,
            0x32e,
            'capacity',
            'Capacity nominal',
            undefined,
            {
                device_class: 'power',
                unit_of_measurement: 'kW',
                suggested_display_precision: 1,
            },
            (raw) => (raw !== 0 ? Math.round(raw * 0.293 * 10) / 10 : undefined),
        ) // raw is in kBTU / hour

        /*
         * Whether the IDU will report its EEV opening correctly during its
         * active operation is highly inconsistent between IDUs.
         * For example, from two Standard2 IDUs with 0x690409 software version
         * connected to common ODU one IDU works as expected while the other
         * one reports the EEV opening value of the other Standard2 IDU (?).
         * This may be an ODU firmware bug. On the other hand, another Deluxe
         * IDU connected to the same ODU always reports correct EEV values.
         * None of tested IDUs seem to usually notify by itself when this value changes.
         */
        this.addOptionalSensorField(config, 0x330, 'eev', 'EEV opening', 'mdi:valve', {
            state_class: 'measurement',
            suggested_display_precision: 0,
        })

        /*
         * IDUs send notifications about the updates of the temperatures below
         * at their own pace, sometimes in clusters with other attributes.
         * Deluxe IDUs send notifications noticeably more often than Standard2 IDUs.
         *
         * Pipe temps are sometimes reported as 0 (-100 C) for a moment after a shutdown.
         * Make sure to filter out such updates.
         */
        this.addOptionalSensorTempField(
            config,
            0x2f9,
            'pipeintemp',
            'Pipe liquid temperature',
            'mdi:pipe',
            (raw) => racPipeTemp[255 - raw],
        )
        this.addOptionalSensorTempField(
            config,
            0x2fa,
            'pipeouttemp',
            'Pipe gas temperature',
            'mdi:pipe',
            (raw) => racPipeTemp[255 - raw],
        )

        this.addOptionalSensorTempField(
            config,
            [0x7a, 0x32c],
            'oduhextemp',
            'ODU HEX temperature', // "HEX" = "heat exchanger"
            'mdi:heating-coil',
            (raw) => racPipeTemp[255 - raw],
        )
        this.addOptionalSensorTempField(
            config,
            0x332,
            'oduairtemp',
            'ODU air temperature',
            'mdi:thermometer-lines',
            (raw) => racAirTemp[255 - raw],
        )

        /*
         * [ 0x22a, 0x32f ] - ODU compressor Hz
         * Standard2 IDUs even notify about the former
         * tag changes.
         *
         * But the value seems to be capped at 15 Hz
         * regardless of the actual compressor speed,
         * which makes it of limited usability.
         */

        // 0x2fb is the target fan RPM, while this is the current RPM
        this.addOptionalSensorField(
            config,
            0x331,
            'fanrpm',
            'Fan RPM',
            'mdi:fan',
            {
                state_class: 'measurement',
                unit_of_measurement: 'rpm',
                suggested_display_precision: 0,
            },
            (raw) => raw * 10,
        )

        if (this.raw_clip_state[0x2cc] & 1) {
            this.addModeDependentConfigSwitchField(
                config,
                0x20f,
                'airclean',
                /* Same desc as in lg_thinq */
                'Air purify',
                'mdi:air-purifier',
                'airClean',
            )
        }

        const jetCool: boolean = !!(this.raw_clip_state[0x2cd] & 1)
        const jetHeat: boolean = !!(this.raw_clip_state[0x2cd] & 2)
        if (jetCool || jetHeat) {
            this.addJetField(config, 0x323, 'jet', 'Jet', 'mdi:wind-power', jetCool, jetHeat)
        }

        if (this.raw_clip_state[0x2d3] & 1) {
            // 15h - displayed in hex as "FH"
            this.addTimerField(config, 0x21a, 'sleeptimer', 'Sleep timer', 'mdi:bed-clock', 15)
        }

        if (this.raw_clip_state[0x2d3] & 4) {
            this.addTimerField(config, 0x21c, 'starttimer', 'Turn-on timer', 'mdi:timer-play', 24)
            this.addTimerField(config, 0x21b, 'stoptimer', 'Turn-off timer', 'mdi:timer-stop', 24)
        }

        if (this.raw_clip_state[0x2cc] & 2) {
            // Can be enabled only when running in the cooling mode
            this.addModeDependentConfigSwitchField(
                config,
                0x20d,
                'energysave',
                'Energy saving',
                'mdi:flower',
                'energySave',
                (mode) => mode === 0,
            )
        }

        if (this.raw_clip_state[0x2cc] & 4) {
            /*
             * Auto dry is a control on this appliance, not a readout. The owner operates both the
             * on/off and the strength from the official app, which is what settles it - a
             * read-only binary_sensor cannot express that and loses the control entirely.
             *
             * The wire encoding is inherited rather than measured HERE, and that distinction is
             * worth keeping: no write to 0x20e or 0x1f2 has ever been captured from a RAC. What
             * exists is PAC_910604_WW, same TLV protocol and same two tags, where both writes are
             * captured and deployed - 0x20e takes 255 and 0 and 0x1f2 takes 2..6 - and this unit
             * reads 0x20e = 255 and 0x1f2 = 6, inside both of those domains. If a write turns out
             * not to take, capture the app doing it and correct this; the appliance ACKs and
             * ignores what it does not accept, which is quiet rather than harmful.
             */
            const compADry = {
                platform: 'switch',
                unique_id: '$deviceid-autodry',
                name: 'Auto dry',
                icon: 'mdi:hair-dryer',
                entity_category: 'config',
            }
            /*
             * MINUTES - measured on THIS appliance on 2026-08-04 (wall-autodry-20260804.jsonl),
             * which is what the '%' this handler declared for years was always missing.
             *
             * The run: a cycle started at 12:07:17 KST with 0x225 = 8 while the official app
             * showed 8분, and the value stepped 8 -> 7 in 59 s before the cancel button below took
             * it to 0. Two readings that do not depend on each other - the appliance's own display
             * as the app renders it, and a decrement rate that a percentage of an unknown-length
             * cycle would not produce.
             *
             * The sibling units are why this was the expected answer rather than a surprise:
             * PAC_910604_WW's aidry-run.jsonl has ten values of 0x225 stepping once a minute
             * beside the operator transcribing the appliance display, and DHUM_231006_WW measured
             * the same. Those were an argument; the run above is the measurement.
             *
             * Note for anyone reading upstream: '%' is not just this handler's habit. #122's
             * ac_common keeps '%' for the 'binary' auto-dry style specifically - the style the
             * 0x2cc bit selects, i.e. this unit - and switches to 'min' only for 'select' and
             * 'switchLevel'. The measurement above says the split is wrong for this appliance.
             */
            const compADryRem = {
                platform: 'sensor',
                unique_id: '$deviceid-autodryremain',
                name: 'Auto dry remaining',
                icon: 'mdi:hair-dryer-outline',
                device_class: 'duration',
                unit_of_measurement: 'min',
                suggested_display_precision: 0,
                entity_category: 'diagnostic',
            }
            /*
             * Whether a cycle is running at all, derived from the same tag rather than published
             * from one of its own - PAC_910604_WW does exactly this. It is a separate question
             * from the 'autodry' switch above: that switch is the standing preference for the next
             * power-off and stays ON while a cycle is cancelled, and only this goes OFF.
             */
            const compADryRunning = {
                platform: 'binary_sensor',
                unique_id: '$deviceid-autodryrunning',
                state_topic: '$this/autodryrunning',
                name: 'Auto dry running',
                icon: 'mdi:hair-dryer',
                entity_category: 'diagnostic',
            }
            config['components']['autodry'] = compADry
            config['components']['autodryremain'] = compADryRem
            config['components']['autodryrunning'] = compADryRunning

            this.addField(config, {
                id: 0x20e,
                name: '',
                comp: 'autodry',
                // 255, not the 1 that addConfigSwitchField writes: that is the value this unit
                // reports for "on" and the value PAC_910604_WW's captured writes carry.
                write_xform: (val) => (val === 'ON' ? 255 : 0),
                read_xform: (raw) => (raw ? 'ON' : 'OFF'),
            })

            this.addField(config, {
                id: 0x225,
                name: '',
                comp: 'autodryremain',
                writable: false,
                // Returns true so the minutes sensor still publishes; the derived running flag
                // rides along. raw_clip_state is already updated by the time this runs.
                read_callback: () => {
                    this.publishAutoDryRunning()
                    return true
                },
            })

            /*
             * Stopping a run already in progress is a write of 0x225 = 0 - the remaining-minutes
             * tag set to zero. Not measured on this appliance: it is DHUM_231006_WW's captured
             * cancel (the app's write, an ACK, then the appliance's own 0x225 going 29 -> 0), and
             * PAC_910604_WW reaches the identical command from its own capture. Two appliances on
             * this protocol, same tag, same value.
             *
             * A BUTTON, not a switch, because there is no start to pair with it: the appliance
             * begins a run by itself when it is switched off with 0x20e set. The auto-dry SETTING
             * is untouched by this - the switch above is the standing preference for the next
             * power-off, and only the run in progress stops.
             *
             * No entity_category, deliberately, so it sits in the device page's Controls section
             * rather than among the settings: it is an action taken now, not a preference.
             *
             * Registered straight into fields_by_ha because addField() would take
             * fields_by_id[0x225] away from the remaining-minutes sensor above. The callback sends
             * the frame and returns false so nothing stamps a 0 into local state - the appliance's
             * own reply is what moves that sensor.
             */
            config['components']['autodry_cancel'] = {
                platform: 'button',
                unique_id: '$deviceid-autodry_cancel',
                command_topic: '$this/autodry_cancel/set',
                name: 'Stop auto dry',
                icon: 'mdi:hair-dryer-outline',
            } as ComponentInfo
            this.fields_by_ha['autodry_cancel'] = {
                name: '',
                comp: '',
                write_xform: (val) => (val === 'PRESS' ? 0 : null),
                write_callback: () => {
                    this.send([1, 1, 2, 1, 1], [{ t: 0x225, v: 0 }])
                    return false
                },
            }

            // The strength axis, 0x1f2. Which strengths exist is the appliance's own answer in
            // 0x192, not a per-model constant: this unit declares bits 2/4/6 - low/mid/high, three
            // of them - where PAC_910604_WW declares all five of 2-6 and offers 1단..5단. So the
            // options are built from the mask and a unit that does not report it gets no entity.
            //
            // PAC_910604_WW reaches the same axis through addSelectField with a contiguous rawBase,
            // which cannot express 2/4/6; hence the explicit mapping here.
            const declaredLevels = Object.keys(autoDryLevels)
                .map(Number)
                .filter((bit) => (this.raw_clip_state[0x192] >> bit) & 1)

            if (declaredLevels.length) {
                // Built as a const and then assigned, like compADry above: ComponentInfo does not
                // declare `icon`, and a direct object literal would trip the excess-property check.
                const compADryLevel = {
                    platform: 'select',
                    unique_id: '$deviceid-autodrylevel',
                    name: 'Auto dry level',
                    icon: 'mdi:hair-dryer',
                    options: declaredLevels.map((bit) => autoDryLevels[bit]),
                    entity_category: 'config',
                }
                config['components']['autodrylevel'] = compADryLevel

                this.addField(config, {
                    id: 0x1f2,
                    name: '',
                    comp: 'autodrylevel',
                    // A level outside the declared set shows as its raw number rather than
                    // vanishing - the same choice FX___S makes for a course it has no name for.
                    read_xform: (raw) => autoDryLevels[raw] ?? `#${raw}`,
                    write_xform: (val) => declaredLevels.find((bit) => autoDryLevels[bit] === val),
                })
            }
        }

        /*
         * Six controls the appliance had been reporting and nobody was reading, all decoded in
         * one capture session (`wall-features-20260803.jsonl`): the owner toggled each one in the
         * official app while rethink recorded, so every tag below is a MEASURED write with a
         * measured echo, not an inference from a sibling model.
         *
         * Note ordering in that capture: the notes were typed AFTER each action, not before. The
         * sound pair settles it - a note-before reading leaves "사운드 끄기" with no 0x3a0=0 after
         * it anywhere, and a note-after reading produces the inverted polarity that DHUM_231006_WW
         * and PAC_910604_WW had each measured independently. Worth stating because the whole
         * mapping flips on it.
         *
         *   0x3a0  버튼음        INVERTED - 0 is on, 1 is off. Same polarity as the other two.
         *   0x12d  굿슬립
         *   0x12f  굿슬립 시작 온도 자동 설정
         *   0x133  굿슬립 맞춤 온도 조절
         *   0x3a2  열교환기 세척  1 starts, 0 stops
         *   0x165  올클리닝      100 starts, 0 stops, and it READS BACK 2 while running
         *
         * Each is gated on the capability its own reply declares, so a unit without the feature
         * gets no entity. 스마트케어 is deliberately absent: 0x2ca declares SMARTCARE_2_0_COOL on
         * this unit but the app offers no such control, which is the appliance over-declaring -
         * the same shape as support.reserve over-declaring WEEKLY_SCHEDULE.
         */
        if (this.raw_clip_state[0x374] & 4) {
            this.addConfigSwitchField(config, 0x3a0, 'beep', 'Beep sound', 'mdi:volume-high', {
                onValue: 0,
                offValue: 1,
            })
        }

        if (this.raw_clip_state[0x2f0] & 8) {
            this.addConfigSwitchField(config, 0x12d, 'goodsleep', 'Good sleep', 'mdi:sleep')
            // Both are settings inside 굿슬립 in the app, and neither has a capability bit of its
            // own that has been identified - they ride on GOODSLEEP.
            this.addConfigSwitchField(
                config,
                0x12f,
                'goodsleepstarttemp',
                'Good sleep auto start temperature',
                'mdi:thermometer-auto',
            )
            this.addConfigSwitchField(
                config,
                0x133,
                'goodsleepcustomtemp',
                'Good sleep custom temperature',
                'mdi:thermometer-lines',
            )
        }

        if (this.raw_clip_state[0x350] & 8) {
            this.addConfigSwitchField(
                config,
                0x3a2,
                'heatexchangerclean',
                'Cleaning - Heat exchanger',
                'mdi:snowflake-melt',
                { category: 'diagnostic' },
            )
        }

        if (this.raw_clip_state[0x34f] & (1 << 17)) {
            this.addConfigSwitchField(config, 0x165, 'allclean', 'Cleaning - ALL', 'mdi:spray-bottle', {
                onValue: 100,
                category: 'diagnostic',
            })
        }

        if (this.getIDUActionRunningTLVNum() != null) {
            this.addField(
                config,
                {
                    id: this.getIDUActionRunningTLVNum(),
                    name: 'action',
                    comp: 'climate',
                    read_callback: (val) => {
                        this.updateClimateAction()
                        return false
                    },
                },
                false,
            )
        }

        this.powerChangeHooks.push(() => {
            this.updateClimateAction()
        })
        this.modeChangeHooks.push(() => {
            this.updateClimateAction()
        })

        // 0x21f - "display light" value is inverted in some devices,
        // but in some devices it is not - not shown in ThinQ app either

        const displayComp = {
            platform: 'switch',
            unique_id: '$deviceid-display',
            name: 'Display light',
            icon: 'mdi:led-on',
            entity_category: 'config',
        }
        config['components']['display'] = displayComp

        this.addField(config, {
            id: 0x21f,
            name: '',
            comp: 'display',
            write_xform: (val) => (val === 'ON' ? 0 : 1),
            read_xform: (raw) => (raw ? 'OFF' : 'ON'),
        })

        if (this.filterLifeTime) {
            const filterUsed = {
                platform: 'sensor',
                unique_id: '$deviceid-filterused',
                state_topic: '$this/filterused',
                name: 'Filter used time',
                icon: 'mdi:air-filter',
                device_class: 'duration',
                unit_of_measurement: 'h',
                state_class: 'total_increasing',
                entity_category: 'diagnostic',
            }
            config['components']['filterused'] = filterUsed
            const filterLife = {
                platform: 'sensor',
                unique_id: '$deviceid-filterlife',
                state_topic: '$this/filterlife',
                name: 'Filter life time',
                icon: 'mdi:air-filter',
                device_class: 'duration',
                unit_of_measurement: 'h',
                entity_category: 'diagnostic',
            }
            config['components']['filterlife'] = filterLife
            const filterChanged = {
                platform: 'sensor',
                unique_id: '$deviceid-filterchangeddate',
                state_topic: '$this/filterchangeddate',
                name: 'Filter usage last reset',
                icon: 'mdi:calendar-refresh-outline',
                device_class: 'date',
                entity_category: 'diagnostic',
            }
            config['components']['changeddate'] = filterChanged

            const filterReset = {
                platform: 'button',
                unique_id: '$deviceid-filterreset',
                command_topic: '$this/filterreset/set',
                name: 'Reset filter usage',
                icon: 'mdi:calendar-refresh-outline',
                entity_category: 'diagnostic',
            }
            config['components']['filterreset'] = filterReset
            this.fields_by_ha['filterreset'] = {
                name: '',
                comp: '',
                write_xform: (val) => (val === 'PRESS' ? 1 : 0),
                write_callback: (val) => {
                    if (val === 1) this.sendFilterReset()
                    return false
                },
            }
        }

        // this value is reported as zero by multi-split units
        if (this.raw_clip_state[0x2b3]) {
            const energyCurrent = {
                platform: 'sensor',
                unique_id: '$deviceid-energy_current',
                state_topic: '$this/energy_current',
                name: 'Power',
                device_class: 'power',
                unit_of_measurement: 'W',
                state_class: 'measurement',
                suggested_display_precision: 0,
            }

            config['components']['energy_current'] = energyCurrent

            // The measurements reported by AC appear to be Watts, but they are not accurate in several aspects:
            // - the value is biased by +50
            // - idle consumption (around 4W) and the 4-way valve is not included
            // - fan modes' consumption appears to be approximated
            //
            // The formula below is expected to be within +/-10% of the actual power consumption. The discrepancy may
            // be highest in fan-only modes.
            this.addField(config, {
                id: 0x2b3,
                name: '',
                comp: 'energy_current',
                writable: false,
                read_xform: (raw) => Math.max(5, raw - 60),
            })
        }

        this.setConfig(config)

        if (this.filterLifeTime) {
            this.publishFilterData()

            /*
             * Refresh only once a day since a query might do an EEPROM
             * write.
             */
            this.filterQueryTimer = setInterval(
                () => {
                    log('status', this.id, 'sending periodic filter data refresh query')
                    this.sendFilterQuery()
                },
                24 * 60 * 60 * 1000,
            )
        }

        this.query()
    }

    addTimerField(config: DeviceDiscovery, id: number, name: string, desc: string, icon: string, max: number) {
        const comp = {
            platform: 'number',
            unique_id: '$deviceid-' + name,
            name: desc,
            icon: icon,
            device_class: 'duration',
            unit_of_measurement: 'h',
            min: 0,
            max: max,
            step: 0.25,
            mode: 'slider',
        } as const
        config['components'][name] = comp

        /*
         * Upon setting this field the device starts counting down and
         * every minute sends the remaining time.
         */
        this.addField(config, {
            id: id,
            name: '',
            comp: name,
            read_xform: (raw) => Math.ceil(raw / 60 / 0.25) * 0.25,
            write_xform: (val) => Math.round(Number(val) * 60),
        })
    }

    addJetField(
        config: DeviceDiscovery,
        id: number,
        name: string,
        desc: string,
        icon: string,
        jetCool: boolean,
        jetHeat: boolean,
    ) {
        const descFull =
            desc + ' ' + (jetCool ? 'cool' : '') + (jetCool && jetHeat ? '/' : '') + (jetHeat ? 'heat' : '')

        const comp = {
            platform: 'switch',
            unique_id: '$deviceid-' + name,
            name: descFull,
            icon: icon,
            entity_category: 'config',
        }
        config['components'][name] = comp

        this.addField(config, {
            id: id,
            name: '',
            comp: name,
            write_xform: (val) => {
                this.jetMode = val === 'ON'
                if (!this.jetMode) return 0

                /* ON */
                if (jetCool && this.getModeTLV() === 0) return 1
                if (jetHeat && this.getModeTLV() === 4) return 2
                return 0
            },
            read_xform: (raw) => {
                if (jetCool && this.getModeTLV() === 0 && raw == 1) return 'ON'
                if (jetHeat && this.getModeTLV() === 4 && raw == 2) return 'ON'
                return 'OFF'
            },
            read_callback: (val) => {
                // The appliance reports 0 whenever it is off or in a mode that has no jet, and it
                // forgets the setting across power cycles anyway. Publish what it reports, so the
                // switch says what the appliance is actually doing rather than what was once asked.
                this.jetMode = val === 'ON'
                return true
            },
            write_callback: (val) => {
                /*
                 * Writing '1' in OFF state seem to immediately
                 * power on into the cooling mode, while writing
                 * '2' in the OFF state is ignored.
                 * Be consistent and only allow enabling Jet mode
                 * when running in the right mode.
                 */
                const writable =
                    this.getPowerTLV() !== 0 &&
                    ((jetCool && this.getModeTLV() === 0) || (jetHeat && this.getModeTLV() === 4))

                // Nothing reaches the appliance, so put the switch back where it was instead of
                // leaving it showing a change that never happened.
                if (!writable) this.HA.publishProperty(this.id, name + '-', this.jetMode ? 'ON' : 'OFF')

                return writable
            },
        })
    }

    addOptionalSensorField(
        config: DeviceDiscovery,
        ids: number | number[],
        name: string,
        desc: string,
        icon?: string,
        extra?: Record<string, unknown>,
        read_xform?: FieldDefinition['read_xform'],
    ) {
        if (typeof ids === 'number') {
            ids = [ids]
        }

        let id = ids.find(
            (val) =>
                this.raw_clip_state[val] != null &&
                (read_xform == null || read_xform(this.raw_clip_state[val]) != null),
        )
        if (id == null) return

        const comp = {
            icon: icon ?? undefined,
            platform: 'sensor',
            unique_id: '$deviceid-' + name,
            name: desc,
            entity_category: 'diagnostic',
            ...extra,
        }

        config['components'][name] = comp

        this.addField(config, {
            id: id,
            name: '',
            comp: name,
            writable: false,
            read_xform: read_xform,
        })
    }

    addOptionalSensorTempField(
        config: DeviceDiscovery,
        ids: number | number[],
        name: string,
        desc: string,
        icon?: string,
        read_xform?: FieldDefinition['read_xform'],
    ) {
        this.addOptionalSensorField(
            config,
            ids,
            name,
            desc,
            icon,
            {
                device_class: 'temperature',
                unit_of_measurement: '°C',
                state_class: 'measurement',
                suggested_display_precision: 2,
            },
            read_xform,
        )
    }

    /** A cycle is running when the remaining-minutes tag is above zero. Read out of
     *  raw_clip_state rather than from the callback argument so the rule stays written against
     *  the raw tag - same as PAC_910604_WW.publishAiDryRunning(). */
    publishAutoDryRunning() {
        this.HA.publishProperty(this.id, 'autodryrunning', this.raw_clip_state[0x225] > 0 ? 'ON' : 'OFF')
    }

    addConfigSwitchField(
        config: DeviceDiscovery,
        id: number,
        name: string,
        desc: string,
        icon: string,
        opts: { onValue?: number; offValue?: number; category?: 'config' | 'diagnostic' } = {},
    ) {
        const { onValue = 1, offValue = 0, category = 'config' } = opts
        const comp = {
            platform: 'switch',
            unique_id: '$deviceid-' + name,
            name: desc,
            icon: icon,
            entity_category: category,
        }
        config['components'][name] = comp

        this.addField(config, {
            id: id,
            name: '',
            comp: name,
            write_xform: (val) => (val === 'ON' ? onValue : offValue),
            // Compared against the OFF value rather than the ON value, because a tag need not
            // read back what was written: 0x165 takes 100 to start and then reports 2 while it
            // runs. With the default offValue of 0 this is the old `raw ? ON : OFF` exactly.
            read_xform: (raw) => (raw === offValue ? 'OFF' : 'ON'),
        })
    }

    addModeDependentConfigSwitchField(
        config: DeviceDiscovery,
        id: number,
        name: string,
        desc: string,
        icon: string,
        field_name: 'airClean' | 'jetMode' | 'energySave',
        check_mode?: CheckMode,
    ) {
        const comp = {
            platform: 'switch',
            unique_id: '$deviceid-' + name,
            name: desc,
            icon: icon,
            entity_category: 'config',
        }
        config['components'][name] = comp

        this.addField(config, {
            id: id,
            name: '',
            comp: name,
            write_xform: (val) => (val === 'ON' ? 1 : 0),
            read_xform: (raw) => (raw ? 'ON' : 'OFF'),
            read_callback: (val) => {
                // The appliance reports 0 whenever it is off or in a mode this setting does not
                // apply to, and it forgets the setting across power cycles anyway. Publish what it
                // reports, so the switch says what the appliance is actually doing.
                this[field_name] = val === 'ON'
                return true
            },
            write_callback: (val) => {
                // No need to write the value if not running in the right mode
                const writable = this.getPowerTLV() !== 0 && (!check_mode || check_mode(this.getModeTLV()))

                // Nothing reaches the appliance, so put the switch back where it was instead of
                // leaving it showing a change that never happened.
                if (!writable) this.HA.publishProperty(this.id, name + '-', this[field_name] ? 'ON' : 'OFF')
                else this[field_name] = val === 1

                return writable
            },
        })
    }
}
