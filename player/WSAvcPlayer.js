'use strict'

import Avc from 'broadway/Decoder'
import YUVWebGLCanvas from 'canvas/YUVWebGLCanvas'
import YUVCanvas from 'canvas/YUVCanvas'
import Size from 'utils/Size'
import { EventEmitter } from 'events'

class WSAvcPlayer extends EventEmitter {
    constructor (canvas, canvastype, useWorker) {
        super()
        this.canvas = canvas
        this.canvastype = canvastype
        this.now = new Date().getTime()
        // AVC codec initialization
        // this.avc = new DecoderAsWorker(canvastype)

        this.avc = new Avc()

        // TODO: figure out why this was here
        /* if (false) this.avc.configure({
            filter: 'original',
            filterHorLuma: 'optimized',
            filterVerLumaEdge: 'optimized',
            getBoundaryStrengthsA: 'optimized',
        }) */

        // WebSocket variable
        this.ws
        this.pktnum = 0

        this.avc.onPictureDecoded = (e, w, h, ...rest) => {
            return this.initCanvas(w, h, [ e, w, h, ...rest ])
        }
    }


    decode (data) {
        let naltype = 'invalid frame'
        // TODO fix type recog: const frameType = data[0] & 0x1f
        /*
            0      Unspecified                                                    non-VCL
            1      Coded slice of a non-IDR picture                               VCL
            2      Coded slice data partition A                                   VCL
            3      Coded slice data partition B                                   VCL
            4      Coded slice data partition C                                   VCL
            5      Coded slice of an IDR picture                                  VCL
            6      Supplemental enhancement information (SEI)                     non-VCL
            7      Sequence parameter set                                         non-VCL
            8      Picture parameter set                                          non-VCL
            9      Access unit delimiter                                          non-VCL
            10     End of sequence                                                non-VCL
            11     End of stream                                                  non-VCL
            12     Filler data                                                    non-VCL
            13     Sequence parameter set extension                               non-VCL
            14     Prefix NAL unit                                                non-VCL
            15     Subset sequence parameter set                                  non-VCL
            16     Depth parameter set                                            non-VCL
            17..18 Reserved                                                       non-VCL
            19     Coded slice of an auxiliary coded picture without partitioning non-VCL
            20     Coded slice extension                                          non-VCL
            21     Coded slice extension for depth view components                non-VCL
            22..23 Reserved                                                       non-VCL
            24..31 Unspecified                                                    non-VCL
        */

        if (data.length > 4) {
            if ((data[4] & 0x1f) === 5) {
                naltype = 'I frame'
            }
            else if ((data[4] & 0x1f) === 1) {
                naltype = 'P frame'
            }
            else if ((data[4] & 0x1f) === 7) {
                naltype = 'SPS'
                setTimeout(() => {
                  this.emit('message', 'binary')
                }, 200)
            }
            else if ((data[4] & 0x1f) === 8) {
                naltype = 'PPS'
            }
        }
        // log(`Passed ${ naltype } to decoder ${ data[4] & 0x1f }`)
        /* const now_new = new Date().getTime()
        const elapsed = now_new - this.now
        this.now = now_new
        console.log(1000 / elapsed) */
        this.avc.decode(data)
    }

    connect(url) {
        // Websocket initialization
        if (this.ws !== undefined) {
            this.ws.close()
            delete this.ws
        }

        this.ws = new WebSocket(url)
        this.ws.binaryType = 'arraybuffer'

        this.ws.onopen = () => {
            // log('Connected to ' + url)
            this.emit('connected', url)
        }

        let framesList = []

        this.ws.onmessage = (evt) => {
            if (typeof evt.data == 'string') {
                if (/^start /.test(evt.data)) {
                    const config = JSON.parse(evt.data.substr('start '.length))
                    if (config.orientation === 90 || config.orientation === 270) {
                        this.autoWidth = true
                    } else {
                        this.autoWidth = false
                    }
                }

                return this.emit('message', evt.data)
            }

            this.pktnum++
            const frame = new Uint8Array(evt.data)
            // log("[Pkt " + this.pktnum + " (" + evt.data.byteLength + " bytes)]");
            // this.decode(frame);
            framesList.push(frame)
        }


        let running = true

        const shiftFrame = function () {
            if (!running)
                return

            // 帧队列长度超过 30，判断是否有 SPS帧（即起始帧）
            if (framesList.length > 30) {
                // log('Dropping frames', framesList.length)
                const vI = framesList.findIndex(e => (e[4] & 0x1f) === 7)
                // console.log('Dropping frames', framesList.length, vI)
                if (vI >= 0) {
                    // 包含新的起始帧，则帧队列数据更新为起始帧之后的数据
                    // [I, I, I, SPS, PPS, I, I, I, ...]
                    framesList = framesList.slice(vI)
                }
                // framesList = []
            }
            // 下面开始逐帧绘制
            const frame = framesList.shift()
            this.emit('frame_shift', framesList.length)

            if (frame)
                this.decode(frame)

            // 「逐帧函数」，这里是执行绘制入口
            requestAnimationFrame(shiftFrame)
        }.bind(this)


        shiftFrame()


        this.ws.onclose = () => {
            running = false
            this.emit('disconnected')
            // log('WSAvcPlayer: Connection closed')
        }

        return this.ws
    }

    initCanvas (width, height, dec) {
        const canvasFactory = this.canvastype === 'webgl' || this.canvastype === 'YUVWebGLCanvas'
            ? YUVWebGLCanvas
            : YUVCanvas

        const canvas = new canvasFactory(this.canvas, new Size(width, height))
        
        this.avc.onPictureDecoded = (e, w, h, ...rest) => {
            // console.log(rest)
            if (w !== width || h !== height) {
                return this.initCanvas(w, h, [ e, w, h, ...rest ])
            }

            return canvas.decode(e, w, h, ...rest)
        }

        if (this.canvas.parentNode && this.canvas.parentNode.parentNode) {
            this.canvas.parentNode.parentNode.classList.toggle('letterboxed', this.autoWidth || false)
        }
        this.emit('portrait', !this.autoWidth)
        
        this.canvas.width = width
        this.canvas.height = height

        if (dec) {
            return canvas.decode(...dec)
        }
    }

    disconnect () {
        this.ws.onerror = this.ws.onclose = this.ws.onmessage = this.ws.onopen = null
        this.ws.close()
    }

    send (payload) {
        return this.ws.send(payload)
    }
}

module.exports = WSAvcPlayer
