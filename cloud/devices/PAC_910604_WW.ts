import TLVDevice, { FieldDefinition } from './tlv_device'
import { Device as Thinq2Device } from '../thinq2/device'
import { ClimateComponent, DeviceDiscovery, type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import * as TLV from '@/util/tlv'
import log from '@/util/logging'
import HADevice from './base'

/**
 * LG stand (floor-standing) Air Conditioner
 * ThinQ model PAC_910604_WW (swVersion 310917, deviceType 401, platform thinq2)
 *
 * QUIRK: this appliance does not use the usual 0x87 frame marker at buf[6], and it is not
 * even consistent about what it does use. All 143 state frames in the reference capture
 * are marked 0xa7, so the base class' processData() drops every one of them. On the
 * private command channel the two command acknowledgements in the capture are marked 0x87,
 * but the two data responses - the appliance answering a read - are marked 0x65, echoing
 * the marker of the request they answer. processData() below therefore widens the
 * marker test on all three branches, still accepting 0x87 everywhere so that a firmware
 * behaving like every other model keeps working, and delegates anything it does not
 * recognise to the base class, following POT_056905_WW's override.
 *
 * The supported mode set is unusually small: cool, dry and air-clean/fan only. There is
 * no heat, no auto and no vertical swing on this model - injecting 0x1f9 = 2 was ignored
 * by the appliance.
 */

/*
 * ClimateComponent does not declare `modes` (HA's list of supported HVAC modes) because
 * every other AC profile is happy with HA's default list. This model supports only three
 * of them, so it has to spell the list out.
 */
type StandClimateComponent = ClimateComponent & { modes?: string[] }
type StandDiscovery = DeviceDiscovery & { components: { climate: StandClimateComponent } }

type SwitchOptions = {
    /* raw TLV value written for 'ON' (default 1) */
    onValue?: number
    /* raw TLV value written for 'OFF' (default 0) */
    offValue?: number
    /* raw TLV value that reads back as 'ON', when it differs from onValue */
    readOnValue?: number
}

export default class Device extends TLVDevice {
    readonly deviceConfig: StandDiscovery
    filterUsedTime: number = 0
    filterLifeTime: number = 0
    filterChangedDate: number = 0
    filterConfigured: boolean = false
    filterInitialQueryTimeout: ReturnType<typeof setTimeout> | undefined
    filterQueryTimer: ReturnType<typeof setInterval> | undefined

    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq)

        /*
         * Unlike RAC_056905_WW this profile builds its configuration up front instead of
         * waiting for a capability response. Nothing here is gated on capability bits -
         * this appliance was never observed answering a capability query at all (see
         * isCapsResponse below) - so deferring would risk publishing no entities ever.
         */
        const config: StandDiscovery = allowExtendedType({
            ...HADevice.config(meta, { name: 'LG Stand Air Conditioner' }),
            components: {
                climate: {
                    platform: 'climate',
                    unique_id: '$deviceid-climate',
                    name: null,
                    temperature_unit: 'C',
                    /* kept in sync with 0x1fb, see updateTempStep() */
                    temp_step: 0.5,
                    precision: 0.5,
                    /* 0x1fe is degrees * 2 and ranges over 36 .. 60 */
                    min_temp: 18,
                    max_temp: 30,
                    modes: ['off', 'cool', 'dry', 'fan_only'],
                    /* raw 2 .. 6 are the appliance's 1단 .. 5단; named as in RAC_056905_WW */
                    fan_modes: ['very low', 'low', 'medium', 'high', 'very high', 'auto'],
                    swing_modes: ['concentrated', 'wide', 'left', 'right', 'split'],
                } satisfies StandClimateComponent,
            },
        })
        this.deviceConfig = config

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
            /* the appliance was never observed being sent a bare 0x1f7, so mirror RAC */
            write_attach: (raw) => (raw ? [0x1f9, 0x1fa, 0x1fe] : []),
            read_xform: (raw) => (raw ? 'ON' : 'OFF'),
            read_callback: () => {
                // publish it as the climate mode instead
                this.processKeyValue(0x1f9, this.raw_clip_state[0x1f9])
                return false
            },
        })

        this.addField(config, {
            id: 0x1f9,
            name: 'mode',
            comp: 'climate',
            read_xform: (raw) => {
                /* 2 (fan only on other models) is rejected by this appliance */
                const modes2ha: Record<number, string> = { 0: 'cool', 1: 'dry', 5: 'fan_only' }
                if (this.raw_clip_state[0x1f7] === 0) return 'off'
                return modes2ha[raw]
            },
            write_xform: (val) => {
                const modes2clip: Record<string, number> = { cool: 0, dry: 1, fan_only: 5 }
                if (val === 'off') {
                    // Call function power (0x1f7) with value OFF
                    this.setProperty('climate-power', 'OFF')
                    return null
                }
                return modes2clip[val]
            },
            /*
             * The LG app always writes the trio 0x1f9, 0x1fa, 0x1fe together, and it only
             * ever did so with the appliance already running - the capture contains no
             * write of 0x1f7 at all, so what a bare mode write does to a powered-off
             * appliance is unverified. HA semantics are not ambiguous though: selecting an
             * hvac_mode while the entity reads 'off' means "turn on in that mode", so add
             * the power tag in exactly that case. While the appliance is on, the frame
             * stays byte-identical to the app's.
             *
             * The mutation has to happen here rather than in write_xform: setProperty()
             * calls write_xform first and only reads raw_clip_state after write_attach has
             * returned, so setting it earlier would destroy the previous power reading this
             * test depends on, and attaching 0x1f7 without setting it would send 0x1f7 = 0
             * and switch the appliance off.
             */
            write_attach: () => {
                if (this.raw_clip_state[0x1f7] === 1) return [0x1fa, 0x1fe]

                this.raw_clip_state[0x1f7] = 1
                return [0x1f7, 0x1fa, 0x1fe]
            },
        })

        this.addField(config, {
            id: 0x1fa,
            name: 'fan_mode',
            comp: 'climate',
            read_xform: (raw) => {
                /* 7 is only ever reported while jet mode runs - discard it */
                const modes2ha = [
                    undefined,
                    undefined,
                    'very low',
                    'low',
                    'medium',
                    'high',
                    'very high',
                    undefined,
                    'auto',
                ]
                return modes2ha[raw]
            },
            write_xform: (val) => {
                const modes2clip: Record<string, number> = {
                    'very low': 2,
                    low: 3,
                    medium: 4,
                    high: 5,
                    'very high': 6,
                    auto: 8,
                }
                return modes2clip[val]
            },
            write_attach: [0x1f9, 0x1fe],
        })

        this.addField(config, {
            id: 0x1fe,
            name: 'temperature',
            comp: 'climate',
            read_xform: (raw) => raw / 2,
            write_xform: (valStr) => {
                const val = Math.round(Number(valStr) * 2)
                if (val < 36) return 36
                if (val > 60) return 60
                return val
            },
            write_attach: [0x1f9, 0x1fa],
        })

        this.addField(config, {
            id: 0x2a3,
            name: 'swing_mode',
            comp: 'climate',
            read_xform: (raw) => {
                const modes2ha: Record<number, string> = {
                    1: 'concentrated',
                    2: 'wide',
                    3: 'left',
                    4: 'right',
                    5: 'split',
                }
                return modes2ha[raw]
            },
            write_xform: (val) => {
                const modes2clip: Record<string, number> = {
                    concentrated: 1,
                    wide: 2,
                    left: 3,
                    right: 4,
                    split: 5,
                }
                return modes2clip[val]
            },
        })

        /*
         * 0x1fb selects the resolution of 0x1fe: 0 => 0.5 C, 1 => 1 C. It is exposed as the
         * climate component's temp_step rather than as an entity of its own, so autoreg is
         * off and the read callback suppresses the (topic-less) publish.
         *
         * Not writable: the LG app always writes it paired with 0x1fc, whose meaning is
         * unknown and which this appliance never reports, so write_attach could not fill
         * it in from raw_clip_state.
         */
        this.addField(
            config,
            {
                id: 0x1fb,
                name: 'temp_step',
                comp: 'climate',
                writable: false,
                read_callback: (raw) => {
                    this.updateTempStep(Number(raw))
                    return false
                },
            },
            false,
        )

        /*
         * None of these switches is declared optimistic, unlike RAC_056905_WW's. RAC needs
         * it because its write_callback can silently drop a write that the appliance would
         * reject in the current mode; here every write goes out unconditionally and the
         * appliance echoes the resulting value back, so letting the real state win is both
         * simpler and more honest.
         */
        this.addSwitchField(config, 0x236, 'jet', 'Jet mode', 'mdi:wind-power')
        this.addSwitchField(config, 0x29d, 'quiet', 'Quiet mode', 'mdi:volume-off')
        this.addSwitchField(config, 0x2a2, 'uvnano', 'UVnano', 'mdi:bacteria')
        this.addSwitchField(config, 0x1be, 'spacefit', 'Space-fit wind', 'mdi:arrow-expand-horizontal')
        this.addSwitchField(config, 0x20f, 'airclean', 'Air purify', 'mdi:air-purifier')
        this.addSwitchField(config, 0x3a9, 'childlock', 'Child lock', 'mdi:lock')
        /* the appliance mirrors this into 0x25e, which needs no entity of its own */
        this.addSwitchField(config, 0x23e, 'smartcare', 'Smart care', 'mdi:auto-fix')
        /* AI dry enable is 0 / 255 rather than the usual 0 / 1 */
        this.addSwitchField(config, 0x20e, 'aidry', 'AI dry', 'mdi:hair-dryer', { onValue: 255 })

        /*
         * INVERTED polarity, same as the wall unit RAC_056905_WW: the appliance stores
         * 1 = display off / muted. Confirmed by the operator-annotated capture, where
         * "제품 화면 OFF" produced 0x21f = 1 and "제품 소리 OFF" produced 0x3a0 = 1.
         */
        this.addSwitchField(config, 0x21f, 'display', 'Product display', 'mdi:television-ambient-light', {
            onValue: 0,
            offValue: 1,
        })
        this.addSwitchField(config, 0x3a0, 'beep', 'Product beep', 'mdi:volume-high', { onValue: 0, offValue: 1 })

        /*
         * The cleaning cycles are start/stop pairs with a readable running state, so they
         * are switches rather than buttons. Both drive other fields (power, fan, wind
         * direction, smart care) by themselves while they run.
         *
         * 0x3a2 reads back 1 while the heat exchanger clean runs and 255 while the all
         * clean cycle runs, hence the exact comparison rather than a truthiness test.
         */
        this.addSwitchField(config, 0x3a2, 'hxclean', 'Heat exchanger clean', 'mdi:heating-coil')
        this.addSwitchField(config, 0x165, 'allclean', 'All clean', 'mdi:spray-bottle', {
            onValue: 100,
            readOnValue: 2,
        })

        this.addSelectField(config, 0x2a8, 'onesidewind', 'One-side wind', 'mdi:arrow-left-right', [
            'off',
            'left',
            'right',
        ])
        /* raw 2 .. 6 are the appliance's 1단 .. 5단 */
        this.addSelectField(
            config,
            0x1f2,
            'aidrylevel',
            'AI dry level',
            'mdi:hair-dryer-outline',
            ['1', '2', '3', '4', '5'],
            2,
        )
        /*
         * Read-only. Every other writable tag in this profile has a captured LG-app TLV
         * write behind it; 0x337 has none. The app does change this setting, but over the
         * private command channel rather than by TLV: the capture has it send private
         * command 0x0c (cmd_sub 0x01, 4-byte payload 0 or 1), after which the appliance
         * reports the new 0x337 in a state frame. A TLV write of 0x337 is therefore
         * unattested, and making this a writable select would mean building a private
         * channel write path, so it stays read-only. It is a sensor rather than a read-only
         * select because HA's MQTT select requires a command topic.
         */
        /*
         * 0x336 is the indoor relative humidity and 0x337 is the appliance's on-panel
         * display option for it - they are a value/display pair, hence declared together.
         *
         * 0x336 is a plain integer percentage, no scaling. Confirmed over 30 samples
         * spanning 55 .. 70: it falls while cooling (62 -> 60) and while AI-dry runs
         * (67 -> 63), and rises during air-clean (60 -> 70).
         */
        this.addSensorField(config, 0x336, 'humidity', 'Humidity', undefined, {
            device_class: 'humidity',
            unit_of_measurement: '%',
            state_class: 'measurement',
            suggested_display_precision: 0,
            /* a room measurement, not diagnostics - override addSensorField's default */
            entity_category: undefined,
        })

        this.addSensorField(
            config,
            0x337,
            'humiditydisplay',
            'Humidity display',
            'mdi:water-percent',
            undefined,
            (raw) => {
                const values2ha: Record<number, string> = { 0: 'while running', 1: 'always' }
                return values2ha[raw]
            },
        )

        this.addSensorField(config, 0x2b3, 'energy_current', 'Power', undefined, {
            device_class: 'power',
            unit_of_measurement: 'W',
            state_class: 'measurement',
            suggested_display_precision: 0,
        })
        this.addSensorField(config, 0x221, 'error', 'Error code', 'mdi:alert')

        /*
         * Vertical swing genuinely does not exist on this model - it has no such control,
         * so there is no analogue of RAC's 0x321 / 0x322.
         *
         * Refrigerant / ODU telemetry (0x2f9, 0x2fa, 0x32c, 0x332, 0x330, 0x32e, 0x331) is
         * absent from the reference capture, but that is NOT evidence the appliance lacks
         * it: a values query (TLV 0x1f5 = 2) is never sent in the capture, and on RAC that
         * query is the only path by which those tags arrive. The same reasoning already
         * produced two wrong "not supported" conclusions on this appliance - the filter
         * sensors and the capability response both turned out to work once something
         * actually asked. Treat this as unqueried, not unsupported.
         *
         * There is also a positive hint: the 307-byte 0xa8 records this profile ignores are
         * a fixed-offset mirror of the same state (offset 261 tracks 0x2b3 in 51 of 52
         * frames across 32 distinct values), and they contain a byte at offset 175 that
         * behaves exactly like an evaporator coil temperature - it falls as compressor
         * power ramps and recovers monotonically over 13 samples after shutdown. It is
         * deliberately NOT mapped here: there is no ground truth to calibrate it against,
         * and RAC's racPipeTemp table belongs to a different model.
         *
         * Seen in the capture but not understood, so left without entities:
         * 0x348 (mirrors 0x1f9), 0x279, 0x27a, 0x232, 0x233, 0x355, 0x356.
         *
         * 0x312 must never become an entity: it is the frame's own length field, matching
         * payload-minus-encoding-size in 123 of 123 frames. It is the most-observed tag in
         * the capture and therefore the most tempting false positive.
         *
         * The filter sensors are not TLV-backed; they are added once the private command
         * channel answers, see processFilterData().
         */

        this.setConfig(config)
    }

    start() {
        super.start()

        // we want to be informed about all TLV changes - set an empty blacklist
        this.thinq.send('setMaskingInfo', 0, { blacklist_tlv: '1200' })

        // give modem some time to process the command before continuing
        this.filterInitialQueryTimeout = setTimeout(() => {
            this.filterInitialQueryTimeout = undefined
            log('status', this.id, 'sending initial filter data query')
            this.sendFilterQuery()
        }, 500)
    }

    drop() {
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

    /*
     * Frame markers observed at buf[6] in the device -> cloud direction:
     *   0xa7  every one of the 143 state frames in the capture,
     *   0x87  both private command acknowledgements in the capture (buf[7] 0xfd, buf[8]
     *         0x10), and the live filter probe response this profile's filter support is
     *         built on,
     *   0x65  both 18-byte private data responses in the capture, which answer a read of
     *         private command 0x0c and echo the request's own marker.
     *
     * The capture holds two more frames with buf[7] 0xfd and buf[8] 0x03: 190-byte ones
     * marked 0x87, carrying command 0x15 with buf[1] 0x00 rather than the 0xff a data
     * response uses. They match no branch here and none in the base class either. Nothing
     * is known about them, so they are deliberately left unhandled rather than guessed at.
     *
     * The three branches below are the base class' (tlv_device.ts processData) with the
     * marker test widened and an early return added. Each widened branch is a superset of
     * the base class' branch, so the delegation at the end only ever sees frames the base
     * class would have ignored as well; nothing is processed twice. Note that neither
     * private branch was observed with 0xa7 and neither state frame with 0x65 - both
     * markers are accepted on both channels anyway, because this appliance has already
     * demonstrated that its marker is not uniform, and a wrong-but-accepted marker can only
     * match a frame that satisfies every other structural test.
     */
    processData(buf: Buffer) {
        /* state frame */
        if (
            buf[2] === 0x04 &&
            buf[3] === 0x00 &&
            buf[4] === 0x00 &&
            buf[5] === 0x00 &&
            (buf[6] === 0x87 || buf[6] === 0xa7) &&
            buf[7] === 0x02 &&
            (buf[8] === 0x01 || buf[8] === 0x04) &&
            buf[10] === buf.length - 13
        ) {
            this.processTLV(TLV.parse(buf.subarray(11, buf.length - 2)))
            return
        }

        /* private data response, e.g. the answer to sendFilterQuery() */
        if (
            buf[1] === 0xff &&
            buf[2] === 0x04 &&
            buf[3] === 0x00 &&
            buf[4] === 0x00 &&
            buf[5] === 0x00 &&
            (buf[6] === 0x87 || buf[6] === 0x65) &&
            buf[7] === 0xfd &&
            buf[8] === 0x03 &&
            buf[10] === buf.length - 13
        ) {
            this.processPrivData(buf[0], buf[9], buf.subarray(11, buf.length - 2))
            return
        }

        /* private command acknowledgement, e.g. the answer to sendFilterReset() */
        if (
            (buf[0] === 0x02 || buf[0] === 0x03) &&
            buf[2] === 0x04 &&
            buf[3] === 0x00 &&
            buf[4] === 0x00 &&
            buf[5] === 0x00 &&
            (buf[6] === 0x87 || buf[6] === 0x65) &&
            buf[7] === 0xfd &&
            buf[8] === 0x10 &&
            buf[9] === 0x00 &&
            buf[10] === 0x05 &&
            buf[11] === 0xfe &&
            buf[12] != null
        ) {
            this.processPrivDataCmdResp(buf[0] === 0x02, buf[1], buf[12], buf.subarray(13, buf.length - 2))
            return
        }

        super.processData(buf)
    }

    /*
     * Verified on real hardware. queryCaps() (TLV 0x1f5 = 1) was issued to a live
     * PAC_910604_WW and the appliance answered with a 174-byte frame carrying 54 TLVs,
     * 0x2da among them - so keying on 0x2da matches RAC_056905_WW and POT_056905_WW and is
     * correct for this model too.
     *
     * The capability reply also answers a question RAC_056905_WW leaves open. It carries
     * 0x2e1 = 36 and 0x2e2 = 60, i.e. the appliance declares its own setpoint range as
     * 18.0 .. 30.0 C - exactly the range measured from the remote, and exactly what the
     * "some devices report these temp ranges via tags 0x2e1 - 0x2ec" TODO in
     * RAC_056905_WW.ts predicted. min_temp / max_temp above are hardcoded to those values
     * rather than read from capabilities, because doing it properly means rebuilding the
     * climate component after caps arrive and belongs in a change that fixes it for every
     * AC profile, not just this one.
     *
     * The reply further declares the supported modes as three 0x2d7 entries valued 0, 1
     * and 5 - cool, dry and air-clean/fan - independently confirming the mode table above,
     * which was derived by pressing buttons on the remote.
     */
    isCapsResponse(tlvArray: TLV.TLV[]) {
        /* eeprom checksum */
        return tlvArray.some(({ t }) => t === 0x2da)
    }

    isValuesResponse(tlvArray: TLV.TLV[]) {
        /* power - present in the appliance's 94-tag comprehensive state dump */
        return tlvArray.length >= 10 && tlvArray.some(({ t }) => t === 0x1f7)
    }

    /* 0x1fb: 0 => 0.5 C, 1 => 1 C. Republish the discovery config when it changes. */
    updateTempStep(raw: number) {
        const step = raw === 1 ? 1 : 0.5
        const climate = this.deviceConfig.components.climate
        if (climate.temp_step === step) return

        log('status', this.id, 'temperature step changed to', step)
        climate.temp_step = step
        climate.precision = step
        this.setConfig(this.deviceConfig)
    }

    /*
     * Filter management uses the private command channel rather than TLV tags, exactly
     * like RAC_056905_WW - sendPrivCommand(0x02, 0x02) returns a payload with the same
     * layout, verified live on this model (used 0 h, life 720 h, changed date 0).
     *
     * data[0] is the command byte the appliance echoes back, which RAC_056905_WW does not
     * check because its appliance was never seen answering any other private read. This one
     * was: the capture contains two responses to private command 0x0c (the humidity display
     * setting), and they arrive with the same buf[0] == 0x02 that selects the filter path
     * here. They are short enough that processFilterData() would reject them today, but
     * only by accident, so dispatch on the echoed command byte as well.
     */
    processPrivData(cmd: number, buf9: number, data: Buffer) {
        if (cmd == 0x02 && data[0] === 0x02) this.processFilterData(buf9, data)
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

    processFilterData(buf9: number, data: Buffer) {
        if (data.length < 1 + 3 * 4) {
            log('status', this.id, 'filter data too short:', data.length)
            return
        }

        this.filterUsedTime = data.readUInt32LE(1 + 0 * 4)
        this.filterLifeTime = data.readUInt32LE(1 + 1 * 4)
        this.filterChangedDate = data.readUInt32LE(1 + 2 * 4)

        if (!this.filterConfigured && this.filterLifeTime) this.addFilterComponents()
        this.publishFilterData()
    }

    processFilterCmdResp(success: boolean, data: Buffer) {
        if (!success) {
            log('status', this.id, 'filter reset failed')
            return
        }

        log('status', this.id, 'filter reset okay, re-querying')
        this.sendFilterQuery()
    }

    /*
     * Bolt the filter entities onto the already-published configuration and republish it.
     * A device that never answers the filter query simply never gets them.
     */
    addFilterComponents() {
        this.filterConfigured = true

        const config = this.deviceConfig
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

        this.setConfig(config)

        /* Refresh only once a day since a query might do an EEPROM write. */
        if (this.filterQueryTimer == undefined) {
            this.filterQueryTimer = setInterval(
                () => {
                    log('status', this.id, 'sending periodic filter data refresh query')
                    this.sendFilterQuery()
                },
                24 * 60 * 60 * 1000,
            )
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

    addSwitchField(
        config: DeviceDiscovery,
        id: number,
        name: string,
        desc: string,
        icon: string,
        options: SwitchOptions = {},
    ) {
        const onValue = options.onValue ?? 1
        const offValue = options.offValue ?? 0
        const readOnValue = options.readOnValue ?? onValue

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
            write_xform: (val) => (val === 'ON' ? onValue : offValue),
            read_xform: (raw) => (raw === readOnValue ? 'ON' : 'OFF'),
        })
    }

    /* `options[raw - rawBase]` names each raw value; a raw value outside the list is discarded */
    addSelectField(
        config: DeviceDiscovery,
        id: number,
        name: string,
        desc: string,
        icon: string,
        options: string[],
        rawBase: number = 0,
    ) {
        const comp = {
            platform: 'select',
            unique_id: '$deviceid-' + name,
            name: desc,
            icon: icon,
            entity_category: 'config',
            options: options,
        }
        config['components'][name] = comp

        this.addField(config, {
            id: id,
            name: '',
            comp: name,
            read_xform: (raw) => options[raw - rawBase],
            write_xform: (val) => {
                const index = options.indexOf(val)
                /* null cancels the write rather than sending a bogus value */
                if (index < 0) return null
                return index + rawBase
            },
        })
    }

    addSensorField(
        config: DeviceDiscovery,
        id: number,
        name: string,
        desc: string,
        icon?: string,
        extra?: Record<string, unknown>,
        read_xform?: FieldDefinition['read_xform'],
    ) {
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
}
