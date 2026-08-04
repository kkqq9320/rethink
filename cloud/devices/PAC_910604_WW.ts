import TLVDevice, { FieldDefinition } from './tlv_device'
import { Device as Thinq2Device } from '../thinq2/device'
import { ClimateComponent, ComponentInfo, DeviceDiscovery, type Connection } from '../homeassistant'
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
    /* HA entity_category; 'config' unless given, undefined for none - see entityCategoryOf() */
    entityCategory?: string
}

type SelectOptions = {
    /* HA entity_category, with exactly the same convention as SwitchOptions */
    entityCategory?: string
}

/*
 * HA files an entity on the device page by its entity_category: 'config' puts it under
 * "Configuration", 'diagnostic' under "Diagnostic", and NO KEY AT ALL under "Controls".
 * There is no category string meaning "Controls", so an everyday control needs the key to be
 * absent - which is why this returns a spreadable object rather than a bare value.
 *
 * `options.entityCategory ?? 'config'` cannot express that: it collapses "the caller asked
 * for Controls" and "the caller said nothing" into the same answer. The presence of the key
 * in `options` is the only thing that tells them apart, so that is what is tested. Note that
 * `entity_category: undefined` is not good enough either - JSON.stringify() would drop it on
 * the wire, but the component object HA's discovery payload is built from would still carry
 * the key, and the tests assert on that object.
 */
function entityCategoryOf(options: { entityCategory?: string }) {
    const category = 'entityCategory' in options ? options.entityCategory : 'config'
    return category === undefined ? {} : { entity_category: category }
}

/*
 * The 0xa8 telemetry record: NOT TLV, a FIXED-OFFSET binary struct, and therefore MODEL AND
 * FIRMWARE SPECIFIC in a way nothing else in this file is. Everywhere else a tag carries its
 * own identity, so a firmware that moves a field simply stops sending the tag; here a firmware
 * that inserts one byte silently makes every offset below mean something different. Evidence
 * is four annotated captures of ONE appliance on swVersion 310917 and nothing else.
 *
 * That is why the length test is exact rather than a lower bound. 66 of the 67 0xa8 frames on
 * file are exactly 307 bytes with an identical header - 00 00 04 00 00 00 a8 <2-byte counter>
 * 01 ff 0b 01 01 - and buf[10] is 0xff instead of the payload length every other frame kind
 * puts there, which is why these frames fail the state-frame branch's `buf[10] === length - 13`
 * test and reach here at all. The 67th is 15 bytes:
 *
 *   000004000000a8180201024ec1abda    (stand-capture.jsonl t+4341.7s)
 *
 * It is 0xa8 too, so a naive `buf[6] === 0xa8` predicate would index offset 160 of a 15-byte
 * buffer and read `undefined`. It carries buf[10] = 0x02 = length - 13 and a TLV-shaped
 * two-byte payload, so it fails BOTH extra tests below. Nothing else is known about it, and
 * it is deliberately not decoded.
 *
 * buf[7] and buf[8] are left unconstrained on purpose: across the corpus they run 0x6665,
 * 0x6701, 0x6702, 0x6703, 0x6705 ... 0x6766, increasing monotonically within a session. They
 * are a counter, not a type code, and pinning them would reject valid frames.
 */
const A8_FRAME_LENGTH = 307

/*
 * Byte offset of the outdoor compressor running flag inside that record. MEASURED, and the
 * derivation is written out in full because there is no tag name to fall back on and because
 * an earlier draft of this file picked the wrong byte - the two candidates agree on every
 * frame the owner actually watched, and differ only where he was predicting.
 *
 * hvac-action.jsonl is a purpose-run experiment: the owner set cooling to 18 C, raised the
 * setpoint to 30 C so the compressor would stop, lowered it back to 18 C so it would restart,
 * then switched to dry, annotating each step live and metering the outdoor unit.
 *
 * WHAT HE OBSERVED, kept strictly apart from what he predicted. Three of his eight notes are
 * future tense - t+9.0s "압축기 돌 것" (the compressor WILL run), t+147.8s "압축기 설 것"
 * (will stop), t+198.1s "다시 돌 것" (will run again) - and a prediction is not a reading.
 * These are the frames a present-tense observation covers. 0x2b3 is tenths of a watt (see the
 * power sensor below), so 13151 is 1315.1 W:
 *
 *      t+142.3s   @160=1   0x2b3=13151   "압축기 도는 중" (the compressor is running), t+125.4s
 *      t+173.2s   @160=0   0x2b3=1008    "압축기 선 듯" (it seems to have stopped), t+156.6s
 *      t+194.6s   @160=0   0x2b3=488     "압축기 진자 선듯. 실측 0w임" - really stopped, 0 W
 *                                        measured at the outdoor unit, t+185.5s
 *      t+433.1s   @160=1   0x2b3=11676   "다시 도는 중" (running again), t+420.1s
 *      t+473.0s   @160=1   0x2b3=11387   running, now in dry mode
 *
 * THOSE FIVE LEAVE THREE CANDIDATES, NOT ONE. Of the 307 offsets, exactly @160, @173 and @198
 * are strictly 0-or-1 across all 66 long frames in all four captures AND reproduce all five
 * labels. @198 is eliminated because it disagrees with the compressor-Hz byte @177 in 21 of
 * the 66. @160 and @173 disagree on exactly TWO frames in the whole corpus, hvac-action
 * t+4.5s and t+337.3s - and those are precisely the two the owner never observed, the ones
 * his two "will run" predictions point at. The choice between them is therefore made on
 * telemetry, and the telemetry says the compressor was not cooling at either:
 *
 *   t+4.5s   @160=0 @173=1. The appliance has just been switched on. 0x2b3 reads 25.5 W at
 *            t+8.2s and ramps 39.2, 59.3, 65.2, 65.3, 78.3, 88.2 W through t+68.1s - a fan
 *            ramp, nothing more - and only steps to 943.2 W at t+77.8s. The compressor
 *            started about 73 s AFTER this frame.
 *   t+337.3s @160=0 @173=1, 0.4 s after a state frame carrying 0x2b3=1388 (138.8 W, against
 *            an 87.1 W fan-only baseline 10 s earlier). Hz @177 and EEV @152 both read 0, and
 *            coil temperature @175 reads 121 - the highest value anywhere in the corpus. At
 *            t+4.5s it reads 116. Every one of the 30 frames with @177 > 0 has @175 <= 107.
 *            Whatever 0x2b3 was about to do, nothing was being cooled at that instant.
 *
 * So @173 leads the machine by up to 73 s: it is a demand or enable, not a report. That is
 * the wrong quantity for HA's hvac_action, which asks what the appliance IS doing - a fan
 * ramping towards a compressor that has not started is 'idle', not 'cooling'.
 *
 * @160 is not an arbitrary pick out of the survivors either. Five offsets - 148, 153, 160,
 * 165 and 177 - are non-zero in exactly the frames where @177 is non-zero, without a single
 * exception in the 66; they are the compressor's own telemetry group. The other four carry
 * magnitudes (@177 runs 50..77, @165 up to 55); @160 is the group's only strictly boolean
 * member. It is the running bit that belongs to the same block as the Hz reading.
 *
 * The byte is strictly 0 or 1 in all 66 frames. It is read as `!== 0` anyway - if some
 * firmware ever reports a compressor stage there, non-zero still means running.
 *
 * The name is COMPRESSOR_ and not IDU_ on purpose: RAC_056905_WW's getIDUActionRunningTLVNum
 * is where the idea comes from, but this byte tracks the outdoor compressor, and calling it
 * after the indoor unit would be a third wrong thing in one comment block.
 */
const COMPRESSOR_RUNNING_OFFSET = 160

export default class Device extends TLVDevice {
    readonly deviceConfig: StandDiscovery

    /*
     * Last reading of the outdoor compressor flag, out of the 0xa8 record - see
     * COMPRESSOR_RUNNING_OFFSET and updateClimateAction(). `undefined` means no 0xa8 frame
     * has arrived that describes the run now in progress, which is a THIRD state and not a
     * synonym for "not running": it is what suppresses the cooling/drying/idle publish
     * entirely until the appliance has said. It is set back to `undefined` whenever the
     * appliance is switched on, because a reading taken before or during an off period says
     * nothing about the run that is starting - see forgetCompressorOnPowerUp().
     */
    compressorRunning: boolean | undefined = undefined

    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq)

        /*
         * Unlike RAC_056905_WW this profile builds its configuration up front instead of
         * waiting for a capability response. Nothing here is gated on capability bits, so
         * every entity exists from the first connect.
         *
         * This appliance does answer a capability query - a live probe got a 174-byte,
         * 54-TLV reply, see isCapsResponse() below. It is simply not needed to publish these
         * components, and its contents were never recorded in full, which is why processTLV()
         * below keeps it away from the filter counters.
         */
        const config: StandDiscovery = allowExtendedType({
            ...HADevice.config(meta, { name: 'LG Stand Air Conditioner' }),
            components: {
                climate: {
                    platform: 'climate',
                    unique_id: '$deviceid-climate',
                    name: null,
                    /* hvac_action, published by updateClimateAction() - see the 0xa8 note there */
                    action_topic: '$this/climate-action',
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
                    /* sideways airflow aim, not oscillation - see 0x2a3 below */
                    swing_horizontal_modes: ['focus', 'wide', 'left', 'right', 'split'],
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
            /*
             * 2 .. 6 are the five speeds the user can pick. 7 and 8 are not selectable:
             * they are the appliance saying "I am driving the fan myself right now" - 8 in
             * dry mode, 7 while jet mode runs. Confirmed on hardware: in both states the
             * fan control is greyed out on the appliance and in the LG app.
             *
             * Both must map to 'auto'. Discarding 7 (as this did originally) leaves HA
             * displaying whatever speed was selected before jet was switched on, which is
             * not what the appliance is doing.
             *
             * 'auto' stays writable because HA offers no way to publish a read-only member
             * of fan_modes; writing it sends 8, which is what the app sends when it puts the
             * appliance into dry.
             */
            read_xform: (raw) => {
                const modes2ha = [
                    undefined,
                    undefined,
                    'very low',
                    'low',
                    'medium',
                    'high',
                    'very high',
                    'auto', // 7: jet mode drives the fan
                    'auto', // 8: dry mode drives the fan
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

        /*
         * 0x2a3 aims the airflow sideways; it is not an oscillation setting, and this model
         * has no vertical louvre control at all. So it belongs on swing_horizontal_mode -
         * the same place RAC_056905_WW puts its left/right vane - and swing_modes is left
         * undeclared rather than misused.
         */
        this.addField(config, {
            id: 0x2a3,
            name: 'swing_horizontal_mode',
            comp: 'climate',
            read_xform: (raw) => {
                const modes2ha: Record<number, string> = {
                    1: 'focus',
                    2: 'wide',
                    3: 'left',
                    4: 'right',
                    5: 'split',
                }
                return modes2ha[raw]
            },
            write_xform: (val) => {
                const modes2clip: Record<string, number> = {
                    focus: 1,
                    wide: 2,
                    left: 3,
                    right: 4,
                    split: 5,
                }
                return modes2clip[val]
            },
        })

        /*
         * 0x1fb selects the resolution of 0x1fe: 0 => 0.5 C, 1 => 1 C. It has two jobs, and
         * exactly ONE field, because addField() registers fields_by_id[0x1fb] and a second
         * registration would silently replace the first:
         *   - it keeps the climate component's temp_step / precision in sync, via
         *     updateTempStep() in the read callback, and
         *   - it publishes a select of its own so the owner can change the resolution from
         *     HA instead of only from the appliance.
         *
         * So addSelectField() is deliberately NOT used here - it would build its own field
         * for 0x1fb and take the temp_step sync with it. The component is built by hand and
         * the topics come from addField()'s autoreg, which derives them from comp + '-' +
         * name; hand-writing them would be one typo away from a silent desync.
         *
         * read_xform is total on purpose - it mirrors updateTempStep's own `raw === 1` rule
         * rather than indexing the option list, so it can never return undefined and skip
         * the read callback, which is what keeps temp_step tracking whatever the appliance
         * reports. Diagnostic, because it describes how the setpoint is displayed rather
         * than what the appliance does.
         *
         * WRITE CAVEAT, unattested on hardware. The LG app never writes 0x1fb alone: both
         * writes in the capture pair it with 0x1fc = 0, whose meaning is unknown and which
         * this appliance never reports, so write_attach cannot source it from
         * raw_clip_state and inventing a value for it would be a guess.
         *
         *   01010400000065020100047f007ec14025   0x1fc = 0, 0x1fb = 1   ("1도로 변경")
         *   01010400000065020100047f007ec05004   0x1fc = 0, 0x1fb = 0   ("0.5도로 변경")
         *
         * What goes out from here is therefore a bare 0x1fb. If a report ever arrives that
         * HA moved this select and the appliance did not follow, 0x1fc is the first thing to
         * try - the reads and the temp_step sync are unaffected either way.
         */
        const tempStepOptions = ['0.5', '1']
        const tempStep = {
            platform: 'select',
            unique_id: '$deviceid-tempstep',
            name: 'Temperature step',
            icon: 'mdi:thermometer-lines',
            entity_category: 'diagnostic',
            options: tempStepOptions,
        }
        config['components']['tempstep'] = tempStep

        this.addField(config, {
            id: 0x1fb,
            name: '',
            comp: 'tempstep',
            read_xform: (raw) => (raw === 1 ? '1' : '0.5'),
            read_callback: () => {
                /* processKeyValue() stores the raw value before it dispatches to the field */
                this.updateTempStep(this.raw_clip_state[0x1fb])
                /* ... and then let the select publish as usual */
                return true
            },
            write_xform: (val) => {
                const index = tempStepOptions.indexOf(val)
                /* null cancels the write rather than sending a bogus resolution */
                if (index < 0) return null
                return index
            },
        })

        /*
         * None of these switches is declared optimistic, unlike RAC_056905_WW's. RAC needs
         * it because its write_callback can silently drop a write that the appliance would
         * reject in the current mode; here every write goes out unconditionally and the
         * appliance echoes the resulting value back, so letting the real state win is both
         * simpler and more honest.
         */
        this.addSwitchField(config, 0x236, 'jet', 'Jet cool', 'mdi:wind-power')
        this.addSwitchField(config, 0x29d, 'quiet', 'Quiet mode', 'mdi:volume-off')
        this.addSwitchField(config, 0x2a2, 'uvnano', 'UVnano', 'mdi:bacteria')
        /*
         * Space-fit wind, air purify and the one-side wind select below carry NO
         * entity_category, so HA files them under "Controls" next to the climate card rather
         * than under "Configuration". They aim or clean the airflow - the owner reaches for
         * them as often as for the fan speed, which is what separates a control from a
         * setting here. Everything else stays 'config'.
         */
        this.addSwitchField(config, 0x1be, 'spacefit', 'Space-fit wind', 'mdi:arrow-expand-horizontal', {
            entityCategory: undefined,
        })
        this.addSwitchField(config, 0x20f, 'airclean', 'Air purify', 'mdi:air-purifier', {
            entityCategory: undefined,
        })
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
        this.addSwitchField(config, 0x21f, 'display', 'Display Light', 'mdi:television-ambient-light', {
            onValue: 0,
            offValue: 1,
        })
        /* "Beep Sound" is the parallel of the display switch's "Display Light" above */
        this.addSwitchField(config, 0x3a0, 'beep', 'Beep Sound', 'mdi:volume-high', { onValue: 0, offValue: 1 })

        /*
         * The cleaning cycles are start/stop pairs with a readable running state, so they
         * are switches rather than buttons. Both drive other fields (power, fan, wind
         * direction, smart care) by themselves while they run.
         *
         * 0x3a2 reads back 1 while the heat exchanger clean runs and 255 while the all
         * clean cycle runs, hence the exact comparison rather than a truthiness test.
         *
         * They are diagnostic rather than config: these are occasional maintenance cycles,
         * not settings, and they do not belong next to the everyday controls.
         *
         * Both are named "Cleaning - ..." so that the two sort together in HA's alphabetical
         * entity list; the component keys are untouched, so entity_ids do not move.
         */
        this.addSwitchField(config, 0x3a2, 'hxclean', 'Cleaning - Heat exchanger', 'mdi:heating-coil', {
            entityCategory: 'diagnostic',
        })
        this.addSwitchField(config, 0x165, 'allclean', 'Cleaning - ALL', 'mdi:spray-bottle', {
            onValue: 100,
            readOnValue: 2,
            entityCategory: 'diagnostic',
        })

        /* rawBase 0, and no entity_category - an everyday airflow control, see above */
        this.addSelectField(
            config,
            0x2a8,
            'onesidewind',
            'One-side wind',
            'mdi:arrow-left-right',
            ['off', 'left', 'right'],
            0,
            { entityCategory: undefined },
        )
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
         * How much of the AI dry cycle is left, and whether one is running at all. Both come
         * from 0x225, the third member of the AI dry trio - 0x20e is the enable switch, 0x1f2
         * the level - and both are read-only, because this is the appliance counting down,
         * not a setting.
         *
         * MINUTES, NOT PERCENT, and that is measured rather than inherited. A capture of a real
         * cycle on this appliance (aidry-run.jsonl) has the operator transcribing what the
         * appliance's own display said, and the tag matches it exactly. RAC_056905_WW published
         * the same tag in '%' until 2026-08-04, when a cycle was finally run on that unit and it
         * counted minutes too; upstream and #122's 'binary' style still say '%'.
         *
         * READ THE WHOLE FILE. aidry-run.jsonl holds TWO capture sessions: a `stopped` marker
         * at t+213.8s and then a fresh `session` record at t+706.8s. An earlier version of
         * this comment stopped scanning at that marker and cited only the first four
         * readings; there are ten device-side values of 0x225 on disk, and the cancel below.
         *
         *      t+2.9s      0x225 = 32   (the unit had just been switched off)
         *      t+34.5s     operator: "32분 남았다고 보임" - the display says 32 minutes left
         *      t+47.1s     0x225 = 31
         *      t+106.8s    0x225 = 30
         *      t+166.6s    0x225 = 29
         *      t+211.1s    operator: "29분 남았다고 보임"
         *      ---         capture stopped t+213.8s, resumed t+706.8s: 28 .. 20 are simply
         *                  not on disk, so the jump below is a recording gap, not a skip
         *      t+763.6s    0x225 = 19
         *      t+823.3s    0x225 = 18
         *      t+883.1s    0x225 = 17
         *      t+942.8s    0x225 = 16
         *      t+1002.7s   0x225 = 15
         *      t+1019.5s   operator: "지금 15분 남음" - 15 minutes left now
         *      t+1021.3s   the LG app cancels the cycle - see the read-only note below
         *
         * The value decrements once every 60 s - 47.1 -> 106.8 -> 166.6 in the first session,
         * then 59.7 / 59.8 / 59.7 / 59.9 s apart across 19 -> 15 in the second - which is
         * what a minute counter does and what a percentage of an unknown-length cycle would
         * not. Three independent transcriptions of the appliance's own display fix the unit.
         *
         * RAC gates its version on 0x2cc & 4; here it is unconditional, for the reason given
         * at the sleep timer below.
         */
        this.addSensorField(
            config,
            0x225,
            'aidryremain',
            'AI dry remaining',
            'mdi:hair-dryer-outline',
            {
                device_class: 'duration',
                unit_of_measurement: 'min',
                state_class: 'measurement',
            },
            undefined,
            () => {
                this.publishAiDryRunning()
                /* let the remaining-time sensor publish as usual */
                return true
            },
        )

        /*
         * Derived from the same tag, so it has NO field of its own - registering a second
         * field for 0x225 would silently replace the first, exactly as at 0x1fb above. It is
         * published from that field's read callback, the pattern 'filterused' already uses.
         *
         * ON when 0x225 > 0. The tag reads 0 in every other capture of this appliance,
         * including throughout a long cooling run, and jumps to 32 in the very frame that
         * reports the unit being switched off with AI dry enabled - so a non-zero remaining
         * time is exactly the condition "a dry cycle is running now".
         *
         * NOT the same thing as the 'aidry' switch on 0x20e. That one is the user's enable
         * setting: it stays ON whether or not a cycle is in progress, and it is what makes a
         * cycle start when the appliance is next switched off. This is the cycle itself. Do
         * not merge the two - one is a preference, the other is a live state.
         *
         * Both sensors are read-only, but a cycle CAN now be stopped from HA - see the
         * 'aidrycancel' button below.
         */
        const aidryRunning = {
            platform: 'binary_sensor',
            unique_id: '$deviceid-aidryrunning',
            state_topic: '$this/aidryrunning',
            name: 'AI dry running',
            icon: 'mdi:hair-dryer',
            entity_category: 'diagnostic',
        }
        config['components']['aidryrunning'] = aidryRunning

        /*
         * Cancel a running AI dry cycle. THE CANCEL IS CAPTURED - it is a plain TLV write of 0
         * to 0x225, and nothing about it is inferred. aidry-run.jsonl catches the LG app
         * cancelling the running cycle, CRC valid, four seconds before the operator wrote down
         * that they pressed stop:
         *
         *   TX 010104000000650201000289403d4f       0x225 = 0                    (t+1021.3s)
         *          payload 8940: tag = (0x89 << 2) | (0x40 >> 6) = 0x225, len = 0, value = 0
         *   rx 0201040000008701100000ec3c           acknowledgement              (t+1021.5s)
         *   rx 000004000000a7020404068940a8c1c48485b6                            (t+1021.6s)
         *          0x225 = 0, 0x2a3 = 1 - the appliance confirms, and resets the wind
         *          direction as the cycle ends
         *   operator: "지금 15분 남음" (15 minutes left now, t+1019.5s), then "중단 눌렀음"
         *          (pressed stop, t+1025.3s), then "중단 됨 - 화면에서 건조 표시 사라짐"
         *          (stopped, the drying indicator is gone from the display, t+1039.3s)
         *
         * Same shape as the filter reset below, for the same reasons. It goes through
         * fields_by_ha directly rather than addField, because addField would take over
         * fields_by_id[0x225] and break the 'aidryremain' sensor and the derived
         * 'aidryrunning' with it. It carries no `id` key at all, so there is no tag for the
         * default write path to stamp even if write_callback's return value were ever changed.
         * The callback sends the frame itself and returns false: the appliance's own reply -
         * the third line above - is what moves the two sensors, so a press that the appliance
         * ignores leaves HA showing the cycle still running, which is the truth.
         *
         * A button rather than a switch, and not merged into the 'aidry' switch on 0x20e:
         * that switch is the owner's standing preference for whether a cycle starts at the
         * next power-off, and it stays ON across this cancel. Only 'aidryrunning' goes OFF.
         * There is no captured way to START a cycle on demand - the appliance begins one by
         * itself when it is switched off with 0x20e set - so a start button would be a guess
         * and there is none.
         */
        const aidryCancel = {
            platform: 'button',
            unique_id: '$deviceid-aidrycancel',
            command_topic: '$this/aidrycancel/set',
            name: 'Cancel AI dry',
            icon: 'mdi:hair-dryer-outline',
            entity_category: 'diagnostic',
        }
        config['components']['aidrycancel'] = aidryCancel
        this.fields_by_ha['aidrycancel'] = {
            name: '',
            comp: '',
            write_xform: (val) => (val === 'PRESS' ? 0 : null),
            write_callback: () => {
                log('status', this.id, 'cancelling the AI dry cycle')
                this.send([1, 1, 2, 1, 1], [{ t: 0x225, v: 0 }])
                return false
            },
        }

        /*
         * Sleep timer: the appliance switches itself off after this many minutes. Stored in
         * MINUTES, published in hours on a 0 .. 15 h slider in quarter-hour steps, exactly as
         * RAC_056905_WW does.
         *
         * SCALE AND RANGE UNATTESTED ON THIS APPLIANCE, in the same sense as the 0x1fb write
         * caveat above, and stated here rather than left to look like a measurement. Every
         * capture was decoded tag by tag: 0x21a occurs exactly twice, once in each 94-TLV
         * comprehensive dump, and reads 0 both times. There is no non-zero reading, no
         * observed countdown, no write of it by the LG app, and not one operator annotation
         * about a sleep or reservation timer. So the minute scale, the once-a-minute
         * countdown, the 15 h ceiling the display shows as "FH" and the quarter-hour step are
         * not observations of this appliance. They rest on three other things: addTimerField()
         * below is a byte-identical re-implementation of RAC_056905_WW's, whose own comment is
         * where the once-a-minute countdown comes from; the owner reports the range and the
         * "FH" display; and the capability bit below says the feature exists at all. One
         * 15-minute observation - set the timer, watch a single decrement - would settle it.
         *
         * Supported, on this model's own word: the capability reply carries
         * 0x2d3 = 282643 = 0x45013, and 0x2d3 & 1 - the bit RAC gates its sleep timer on - is
         * set. It is added UNCONDITIONALLY rather than gated, because this profile publishes
         * its whole configuration from the constructor and the capability reply only arrives
         * later; gating would mean rebuilding the config after caps, which is the change
         * RAC's design implies and this profile deliberately does not make.
         *
         * NO turn-on / turn-off timers, and do not add them from a tag dump: RAC gates its
         * 0x21c / 0x21b pair on 0x2d3 & 4, and in the same word - 0x45013 - that bit is
         * CLEAR. This model does not support them.
         */
        this.addTimerField(config, 0x21a, 'sleeptimer', 'Sleep timer', 'mdi:bed-clock', 15)

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

        /*
         * The LG app changes this over the private command channel rather than with a TLV
         * write, so it was first exposed read-only. A TLV write was then tried against the
         * appliance and does take effect, so it is a proper select.
         *
         * Diagnostic: it changes what the appliance's own panel shows, not what the
         * appliance does, so it sits with the readings rather than with the settings.
         */
        this.addSelectField(
            config,
            0x337,
            'humiditydisplay',
            'Humidity display',
            'mdi:water-percent',
            ['while running', 'always'],
            0,
            { entityCategory: 'diagnostic' },
        )

        /*
         * force_update matters here: the appliance refreshes 0x2b3 less often than the
         * profile polls, so without it a Riemann sum over this sensor produces a staircase
         * rather than an energy total.
         *
         * On this model 0x2b3 is in tenths of a watt, unlike RAC_056905_WW where it is whole
         * watts. Taken raw the appliance would claim 10085 W at full load, which no single
         * indoor unit draws; a tenth of that, 1008 W, is exactly right for a stand unit.
         * The rest of the range agrees: 72 .. 251 raw while only the fan runs is 7 .. 25 W,
         * and 2556 .. 3501 raw under partial cooling load is 256 .. 350 W.
         *
         * There is no additive bias to remove, and this is now measured rather than assumed.
         * RAC applies max(5, raw - 60) because that appliance never reports a true zero; this
         * one reports exactly 0 when it is switched off (stand-capture.jsonl t+4336.0s, in the
         * frame after 0x1f7 goes to 0), so subtracting anything would be wrong.
         *
         * THE FIGURE INCLUDES THE INDOOR FAN. An earlier version of this comment repeated
         * RAC's claim that it is the indoor unit's share of the outdoor compressor and
         * EXCLUDES the fan; on this appliance that is backwards, and hvac-action.jsonl says so
         * directly. With the compressor stopped - @160 = 0 at t+173.2s and t+194.6s, see
         * COMPRESSOR_RUNNING_OFFSET - the owner metered the OUTDOOR unit at 0 W and wrote down
         * ("압축기 진자 선듯. 실측 0w임", t+185.5s) while 0x2b3 was reading 488, i.e. 48.8 W.
         * A tag that excluded the indoor fan would have had to read 0 there. What it reports
         * instead is the 48.8 W the outdoor meter cannot see, which is the indoor fan.
         *
         * That single reading does two jobs. It fixes the offset at zero - 488 raw against a
         * true outdoor 0 W leaves no room for a subtraction that would also have to survive
         * the 0 reported when the unit is off - and it makes this figure the whole indoor
         * unit's draw, so these DO sum across a house rather than being a share to apportion
         * between rooms.
         */
        this.addSensorField(
            config,
            0x2b3,
            'energy_current',
            'Power',
            undefined,
            {
                device_class: 'power',
                unit_of_measurement: 'W',
                state_class: 'measurement',
                suggested_display_precision: 0,
                force_update: true,
                /* a primary measurement, not diagnostics - override addSensorField's default */
                entity_category: undefined,
            },
            (raw) => raw / 10,
        )
        this.addSensorField(config, 0x221, 'error', 'Error code', 'mdi:alert')

        /*
         * The filter counters are ordinary TLV tags on this model:
         *   0x356 is the filter's rated life in hours. Observed once, at 3000, in the
         *     comprehensive dump - the only frame in the capture that carries it.
         *   0x355 is how many of those hours are LEFT, and it counts DOWN. Observed twice:
         *     2442 in the dump, then 2441 in a one-tag change notification.
         *
         * Confirmed numerically against the appliance's own LG ThinQ app, which showed
         * 2438 h remaining and 562 h used - and 2438 + 562 = 3000 exactly. The app reading
         * is a day newer than the capture's 2442, i.e. 4 h of runtime apart, which is one
         * summer day on this appliance.
         *
         * Hours *used* is the number a filter reminder is actually built on, and no tag
         * carries it, so it is derived as 0x356 - 0x355 and published from a read callback
         * on both tags: the comprehensive dump carries the pair in one frame (0x356 first),
         * and a change notification may carry either one alone.
         */
        const filterSensorExtra = { device_class: 'duration', unit_of_measurement: 'h' }
        const publishUsed = () => {
            this.publishFilterUsed()
            /* let the primary sensor publish as usual */
            return true
        }
        this.addSensorField(
            config,
            0x356,
            'filterlife',
            'Filter life time',
            'mdi:air-filter',
            filterSensorExtra,
            undefined,
            publishUsed,
        )
        this.addSensorField(
            config,
            0x355,
            'filterremaining',
            'Filter remaining time',
            'mdi:air-filter',
            filterSensorExtra,
            undefined,
            publishUsed,
        )

        /* Derived, so it has no tag and therefore no field - see publishFilterUsed(). */
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

        /*
         * Resetting the filter counter is a plain TLV write of 0 to 0x355; the appliance
         * answers by reporting 0x355 = 0x356, i.e. a full life again. Captured from the LG
         * app doing exactly this:
         *
         *   TX 0101040000006502010002d540769d   0x355 = 0
         *   rx 0201040000008701100000ec3c       acknowledgement
         *   rx 000004000000a70204c606d5600bb8…  0x355 = 3000
         *
         * An earlier version of this profile drove the reset over the private command
         * channel, copied from RAC_056905_WW. That was wrong - the private channel's
         * counter is a different one - and it is why the button was withdrawn for a
         * release. The unique_id is unchanged, so installations that saw the withdrawn
         * button get this one wired up in its place rather than a second entity.
         *
         * It goes through fields_by_ha directly rather than addField, because addField
         * would take over fields_by_id[0x355] and break the filterremaining sensor. The
         * write_callback sends the frame itself and returns false so the default path does
         * not also stamp 0 into raw_clip_state - the appliance's own reply is what should
         * update the sensors.
         */
        const filterReset = {
            platform: 'button',
            unique_id: '$deviceid-filterreset',
            command_topic: '$this/filterreset/set',
            name: 'Reset filter usage',
            icon: 'mdi:air-filter',
            entity_category: 'diagnostic',
        }
        config['components']['filterreset'] = filterReset
        this.fields_by_ha['filterreset'] = {
            name: '',
            comp: '',
            write_xform: (val) => (val === 'PRESS' ? 0 : null),
            write_callback: () => {
                log('status', this.id, 'resetting the filter counter')
                this.send([1, 1, 2, 1, 1], [{ t: 0x355, v: 0 }])
                return false
            },
        }

        /*
         * MIGRATION. The previous version published a 'changeddate' component - the private
         * channel's filter-changed date - that no longer exists. It was really created, and
         * dropping it from the payload does NOT remove it, it only stops updating it.
         *
         * HA removes a component when the payload carries its key with the platform and
         * NOTHING else: mqtt/discovery.py pops the platform and treats what is left, if it
         * is empty, as a removal. Adding unique_id - or any other key - silently turns the
         * removal back into a registration, so do not "fix" the cast by filling it in.
         *
         * Safe to delete once every installation has run this version once.
         */
        config['components']['changeddate'] = { platform: 'sensor' } as ComponentInfo

        /*
         * Vertical swing genuinely does not exist on this model - it has no such control,
         * so there is no analogue of RAC's 0x321 / 0x322.
         *
         * Refrigerant / ODU telemetry (0x2f9, 0x2fa, 0x32c, 0x332, 0x330, 0x32e, 0x331) is
         * absent from the reference capture, but that is NOT evidence the appliance lacks
         * it: a values query (TLV 0x1f5 = 2) is never sent in the capture, and on RAC that
         * query is the only path by which those tags arrive. The same reasoning already
         * produced two wrong "not supported" conclusions on this appliance - the capability
         * response and the private command channel both turned out to answer once something
         * actually asked. Treat this as unqueried, not unsupported. (Answering is not the
         * same as answering usefully: see the filter note below.)
         *
         * There is also a positive hint: the 307-byte 0xa8 records - of which this profile
         * now decodes exactly one byte, the compressor flag at COMPRESSOR_RUNNING_OFFSET - are a
         * fixed-offset mirror of the same state (offset 261 tracks 0x2b3 in 51 of 52
         * frames across 32 distinct values), and they contain a byte at offset 175 that
         * behaves exactly like an evaporator coil temperature - it falls as compressor
         * power ramps and recovers monotonically over 13 samples after shutdown. It is
         * deliberately NOT mapped here: there is no ground truth to calibrate it against,
         * and RAC's racPipeTemp table belongs to a different model.
         *
         * Seen in the capture but not understood, so left without entities:
         * 0x348 (mirrors 0x1f9), 0x279, 0x27a, 0x232, 0x233.
         *
         * 0x312 must never become an entity: it is the frame's own length field, matching
         * payload-minus-encoding-size in 123 of 123 frames. It is the most-observed tag in
         * the capture and therefore the most tempting false positive.
         *
         * NO PRIVATE-CHANNEL FILTER SUPPORT HERE, deliberately. This profile used to copy
         * RAC_056905_WW's filter handling - sendPrivCommand(0x02, 0x02), then decode used /
         * life / changed-date out of the reply, plus a reset button. That channel does
         * answer on this appliance: a live probe came back and RAC's decode applied
         * unmodified, yielding used = 0 h, life = 720 h, changed date = 0. Those numbers are
         * simply not this appliance's filter. Its own app reports a 3000 h part with 562 h
         * used, which is exactly what 0x356 / 0x355 above carry. What the 720 h counter
         * counts is unidentified - it is not the user-visible filter, and nothing else about
         * it is known - so it is not published, and the reset button is gone with it: its
         * target was never verified and pressing it would have written a lifetime that
         * contradicts the appliance's own display.
         */

        this.setConfig(config)
    }

    start() {
        super.start()

        // we want to be informed about all TLV changes - set an empty blacklist
        this.thinq.send('setMaskingInfo', 0, { blacklist_tlv: '1200' })
    }

    /* No drop() override: nothing here owns a timer, so TLVDevice.drop() is the whole job. */

    /*
     * Frame markers observed at buf[6] in the device -> cloud direction:
     *   0xa7  every one of the 143 state frames in the capture,
     *   0x87  both private command acknowledgements in the capture (buf[7] 0xfd, buf[8]
     *         0x10), and the one live private-channel read reply this appliance was ever
     *         probed with,
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
     *
     * The two private-channel branches classify frames this profile itself has no use for -
     * it sends no private commands (see the filter note in the constructor) - and hand them
     * to TLVDevice's processPrivData() / processPrivDataCmdResp() hooks, which are no-ops
     * unless a subclass overrides them. They are kept because the marker widening is the
     * only place this appliance's non-uniform framing is written down, and re-deriving it
     * would mean re-capturing the appliance.
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

        /*
         * 0xa8 telemetry record. Everything about the predicate and the offset is argued at
         * A8_FRAME_LENGTH / COMPRESSOR_RUNNING_OFFSET above; the two extra tests keep the
         * 15-byte 0xa8 variant out, so neither may be dropped as redundant. Note this cannot
         * be folded into the state branch: buf[10] is 0xff here, so `buf[10] === length - 13`
         * is false by construction.
         */
        if (
            buf[2] === 0x04 &&
            buf[3] === 0x00 &&
            buf[4] === 0x00 &&
            buf[5] === 0x00 &&
            buf[6] === 0xa8 &&
            buf[10] === 0xff &&
            buf.length === A8_FRAME_LENGTH
        ) {
            this.compressorRunning = buf[COMPRESSOR_RUNNING_OFFSET] !== 0
            this.updateClimateAction()
            return
        }

        /* private data response - the appliance answering a private-channel read */
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

        /* private command acknowledgement - the appliance confirming a private-channel write */
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
     * Keep the capability reply away from the filter counters.
     *
     * TLVDevice.processTLV() dispatches every tag of every accepted frame to its field
     * before it decides whether the frame is a capability reply, and the capability reply is
     * the first frame this profile ever sees: the constructor queries for it and retries
     * every 15 s until it answers. What its 54 TLVs contain is unknown - only ten of the
     * tags were ever written down and the frame was never recorded in full - so whether
     * 0x355 / 0x356 appear in it, and with what meaning if they do, cannot be answered from
     * anything on file. The old private-channel filter code was structurally immune to this;
     * sourcing the counters from TLV tags gives that immunity up unless it is restored here.
     *
     * A capability declaration is not a reading. Dropping the pair costs nothing if the
     * reply does not carry them, and stops a declared range or default from being published
     * as the user's filter if it does. That matters most for the derived 'filterused', which
     * is state_class total_increasing: a wrong value there is not merely overwritten by the
     * next state frame, it stays in HA's long-term statistics.
     *
     * Only the two tags are stripped, not the whole frame: the same reply carries 0x2e1 /
     * 0x2e2 - the appliance's own setpoint range - and reading those out of raw_clip_state
     * is the obvious next improvement, see isCapsResponse() below.
     */
    processTLV(tlvArray: TLV.TLV[]) {
        if (this.isCapsResponse(tlvArray)) tlvArray = tlvArray.filter(({ t }) => t !== 0x355 && t !== 0x356)

        const powerBefore = this.raw_clip_state[0x1f7]
        super.processTLV(tlvArray)

        this.forgetCompressorOnPowerUp(powerBefore)

        /*
         * hvac_action is derived from three inputs and has to be republished when ANY of them
         * moves, not only when a 0xa8 frame lands - the 0xa8 records arrive every 20 .. 100 s
         * and a mode change in between would otherwise leave HA showing 'cooling' during a
         * dry cycle for over a minute. The 0xa8 branch in processData() covers the third input.
         *
         * Gated on the frame carrying one of the two tags rather than run unconditionally,
         * because a state frame carrying only room temperature or humidity cannot have changed
         * the action. This is a relevance test, not a de-duplicator: the 0xa8 branch above
         * republishes on every record, so an unchanged action is re-sent every 20 .. 100 s
         * regardless. That is deliberate - it is roughly one retained MQTT message a minute -
         * and the gate here would not reduce it.
         *
         * The gate is deliberately applied to the post-filter array, but that is not what keeps
         * the capability reply out - checked rather than assumed: the appliance's real 54-TLV
         * capability reply carries NEITHER 0x1f7 nor 0x1f9, so it cannot reach this at all.
         * Were a future firmware to include them, the base class would already have stamped
         * them into raw_clip_state before this line runs, so recomputing from them changes
         * nothing that has not already happened.
         *
         * This is done here rather than from the fields' read callbacks, which is how
         * RAC_056905_WW does it, because both of those callbacks are unreachable for exactly
         * the values that matter most: processKeyValue() drops a reading whose read_xform
         * returns undefined BEFORE it reaches the callback, and 0x1f9's read_xform returns
         * undefined for any raw outside {0, 1, 5}. Sourcing the tags from raw_clip_state,
         * which the base class has already stamped, means an unmapped mode still reaches
         * updateClimateAction() and still gets an answer computed for it.
         *
         * What it does NOT do is make the answer a good one. modes2ha there covers 0 and 1
         * only, so with the unit on, the flag set and a mode outside {0, 1, 5}, the action is
         * undefined and nothing is published - HA keeps showing whatever it last saw. That is
         * the same freeze, one layer up, and it is left alone rather than papered over: mode 2
         * was injected into this appliance and rejected, the capability reply declares exactly
         * {0, 1, 5}, and no other value appears in any of the four captures. There is no
         * evidence about what such a mode would be doing, and inventing a string for it would
         * be the mistake COMPRESSOR_RUNNING_OFFSET is a note about.
         */
        if (tlvArray.some(({ t }) => t === 0x1f7 || t === 0x1f9)) this.updateClimateAction()
    }

    /*
     * THE COMPRESSOR FLAG DOES NOT SURVIVE AN OFF PERIOD. Call with the value of 0x1f7 read
     * BEFORE whatever may have changed it; this throws the flag away if that turned the
     * appliance on.
     *
     * updateClimateAction() answers 'off' from power alone and never reads the flag while the
     * unit is off, so a stale reading is harmless *during* the off period - but without this
     * it is still sitting there when the appliance comes back on, and the first recomputation
     * after power returns publishes it as 'cooling'. The stale reading is real, not
     * hypothetical: aidry-run.jsonl goes 0x1f7 = 0 at t+2.9s and the flag still reads 1 at
     * t+5.1s and t+8.4s, reaching 0 only at t+14.0s.
     *
     * THE RISING EDGE, NOT THE FALLING ONE. Clearing when the appliance switches off looks
     * equivalent and is not: 0xa8 records keep arriving while it is off - t+5.1s above is one
     * of them - so the flag would simply be re-latched a second or two later and the same
     * wrong 'cooling' would appear at the next power-on. Only the rising edge is a moment
     * after which no earlier reading can possibly describe the run that is starting.
     *
     * BOTH WAYS THE APPLIANCE CAN COME ON. A state frame carrying 0x1f7 = 1 is only the case
     * where the user pressed the button on the remote. When the user presses it in HA,
     * TLVDevice.setProperty() stamps raw_clip_state before it sends anything and 0x1f9's
     * write_attach does the same for a mode select made while off, so by the time the
     * appliance echoes the change back there is no transition left to see. That is why this
     * is a helper called from two places rather than three lines inside processTLV().
     *
     * THE COST, stated rather than glossed: for the first moments of a new run the action is
     * unknown again, so nothing is published and HA goes on showing the 'off' it was last
     * told, until a 0xa8 record lands - within 100 s in every observed session, and 3.3 s in
     * the one real power cycle on file (stand-capture.jsonl, 0x1f7 = 1 at t+4340.5s, next
     * 0xa8 at t+4343.8s). That is the same trade this profile already makes at startup and for
     * the same reason. Clearing to `false` instead - i.e. claiming 'idle' - was rejected
     * because it is not entailed: the compressor really can still be turning seconds after an
     * off, which is exactly what t+5.1s shows, and a fast off/on would then be misreported in
     * the other direction.
     */
    forgetCompressorOnPowerUp(powerBefore: number | undefined) {
        if (powerBefore === 0 && this.raw_clip_state[0x1f7] === 1) this.compressorRunning = undefined
    }

    /*
     * The HA-side half of that. Everything a user can press in HA arrives here, so reading
     * 0x1f7 around the base class' write is enough to catch both routes that turn the
     * appliance on: the power switch, which writes 0x1f7 itself, and a mode select made while
     * the entity reads 'off', which reaches it through 0x1f9's write_attach.
     */
    setProperty(prop: string, mqttValue: string) {
        const powerBefore = this.raw_clip_state[0x1f7]
        super.setProperty(prop, mqttValue)
        this.forgetCompressorOnPowerUp(powerBefore)
    }

    /*
     * Publish HA's hvac_action - what the appliance is doing right now, as opposed to
     * hvac_mode, which is what it has been asked to do. The mechanism is RAC_056905_WW's:
     * an action_topic on the climate component plus a plain publishProperty() to it, with no
     * field and no tag behind it.
     *
     * WHY THIS PROFILE NEEDS ITS OWN. RAC reads the indoor-unit running flag from TLV 0x189 or
     * 0x6c (getIDUActionRunningTLVNum). Neither tag appears anywhere in any of the four
     * captures of this appliance - not in the 94-tag comprehensive dump, not in the 54-TLV
     * capability reply, not in any change notification. The information is not missing though:
     * it is in the fixed-offset 0xa8 record this profile used to ignore. See
     * COMPRESSOR_RUNNING_OFFSET.
     *
     * ORDER IS LOAD-BEARING, not stylistic:
     *
     *   power 0x1f7 === 0        -> 'off'.  Tested FIRST because the compressor coasts down
     *        after the unit is switched off and the flag lags: aidry-run.jsonl t+5.1s and
     *        t+8.4s are real frames with 0x1f7 = 0 and @160 = 1. Checking the flag first would
     *        report a powered-off appliance as cooling.
     *   mode 0x1f9 === 5         -> 'fan'.  Air-clean, which HA has no better word for.
     *        Tested BEFORE the flag for the same class of reason: stand-capture.jsonl has six
     *        frames with mode 5 and @160 = 1 (t+587.5s, 590.4s, 1003.6s, 1006.0s, 3319.0s,
     *        3321.8s), the compressor still winding down from the mode that preceded it.
     *        Checking the flag first would report 'cooling' while the appliance air-cleans.
     *   flag set                 -> 'cooling' (mode 0) or 'drying' (mode 1).
     *   flag clear, unit on      -> 'idle'.
     *
     * WHAT IS PUBLISHED WHILE THE FLAG IS UNKNOWN: nothing, unless the answer does not depend
     * on it. 'off' and 'fan' are published from the state frame alone, because power and mode
     * settle them. For a running cool or dry the choice is between 'cooling' and 'idle' and
     * there is no evidence either way, so this publishes NEITHER and HA shows no action - or
     * goes on showing the previous one - until a 0xa8 record lands, within 100 s in every
     * observed session. That window opens twice: at startup, and again on every power-on, when
     * processTLV() discards the pre-off reading. RAC defaults its equivalent flag to "running"
     * when it has no tag to read; that is not copied here, because on this appliance the flag
     * genuinely exists and assuming it would mean showing 'cooling' during the minute a
     * compressor typically takes to start - which is exactly what hvac-action.jsonl t+4.5s
     * measures, 73 s of fan before the compressor drew anything. A missing reading is better
     * than an invented one.
     *
     * Deliberately no analogue of RAC's `action = 'None'`: that is not one of HA's hvac_action
     * values, it exists for RAC's auto mode, and this model has no auto mode. Only the five
     * HA-valid strings are ever emitted. Deliberately no analogue of updateQueryInterval()
     * either - it owns a setTimeout, and this profile owns no timers (see drop()).
     */
    updateClimateAction() {
        const power = this.raw_clip_state[0x1f7]
        const mode = this.raw_clip_state[0x1f9]
        const modes2ha: Record<number, string> = { 0: 'cooling', 1: 'drying' }

        let action: string | undefined = undefined
        if (power === 0) {
            action = 'off'
        } else if (power === 1) {
            if (mode === 5) action = 'fan'
            else if (this.compressorRunning === false) action = 'idle'
            else if (this.compressorRunning === true) action = modes2ha[mode]
        }

        /* undefined means "not known yet", which is published as silence, not as a string */
        if (action !== undefined) this.HA.publishProperty(this.id, 'climate-action', action)
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
     * 'used' has no tag of its own: it is 0x356 (rated life) minus 0x355 (hours left), and
     * both read callbacks call this because either tag can arrive first - the comprehensive
     * dump orders 0x356 before 0x355, but a change notification may carry 0x355 alone.
     *
     * Nothing is published until both are known, so a lone 0x355 cannot briefly publish a
     * value derived from a missing life. A negative result would mean the pair disagrees,
     * for which there is no precedent in the two samples on file - 0x356 seen once at 3000,
     * 0x355 seen at 2442 and then 2441 - so it is dropped rather than shown as a nonsensical
     * filter reading.
     *
     * Dropping is not clearing: publishProperty retains, so whatever was published last
     * stays live in the broker and HA goes on showing it, next to a 'filterlife' and
     * 'filterremaining' that did publish. That is what the log line is for - a reading that
     * silently stops tracking is how a wrong filter number survives unnoticed. It still
     * beats the alternative: clamping to 0 would read as "brand-new filter", which is
     * actively misleading rather than merely stale.
     */
    publishFilterUsed() {
        const life = this.raw_clip_state[0x356]
        const remaining = this.raw_clip_state[0x355]
        if (life === undefined || remaining === undefined) return

        const used = life - remaining
        if (used < 0) {
            log('status', this.id, 'filter counters disagree, not publishing used:', life, remaining)
            return
        }

        this.HA.publishProperty(this.id, 'filterused', used)
    }

    /*
     * 'aidryrunning' has no tag of its own: it is the truth of 0x225 > 0, published from the
     * read callback of the field that owns 0x225 - see the AI dry block in the constructor.
     *
     * processKeyValue() stores the raw value before it dispatches to the field, so reading it
     * back out of raw_clip_state here sees this frame's value, not the previous one. It is
     * read from there rather than taken as the callback's argument so that the rule stays
     * written against the raw tag, which is what the observation above is about.
     */
    publishAiDryRunning() {
        const remaining = this.raw_clip_state[0x225]
        this.HA.publishProperty(this.id, 'aidryrunning', remaining > 0 ? 'ON' : 'OFF')
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
            ...entityCategoryOf(options),
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

    /*
     * A countdown timer, published as an HA number in hours while the appliance stores
     * minutes. This is RAC_056905_WW's addTimerField() re-implemented rather than imported:
     * that one is a private method of the RAC profile, and the two profiles share no base
     * class below TLVDevice.
     *
     * No entity_category, so HA files it under "Controls" - it is a thing the owner sets,
     * not a setting about the appliance. `max` is a parameter only because it is RAC's
     * shape; this profile has exactly one timer and passes 15.
     */
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
        }
        config['components'][name] = comp

        this.addField(config, {
            id: id,
            name: '',
            comp: name,
            /* round UP: 61 minutes left is still more than one hour, so show 1.25 h */
            read_xform: (raw) => Math.ceil(raw / 60 / 0.25) * 0.25,
            write_xform: (val) => Math.round(Number(val) * 60),
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
        selectOptions: SelectOptions = {},
    ) {
        const comp = {
            platform: 'select',
            unique_id: '$deviceid-' + name,
            name: desc,
            icon: icon,
            ...entityCategoryOf(selectOptions),
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
        /* must return true, or this sensor stops publishing - see FieldDefinition */
        read_callback?: FieldDefinition['read_callback'],
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
            read_callback: read_callback,
        })
    }
}
