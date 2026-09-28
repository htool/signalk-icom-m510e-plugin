const os = require('os')
const protocol = require('./protocol')

const ROLES = ['discovery', 'keepalive', 'control', 'data', 'extra', 'voice']

function later (fn, ms) {
  const timer = setTimeout(fn, ms)
  if (timer.unref) timer.unref()
  return timer
}

function every (fn, ms) {
  const timer = setInterval(fn, ms)
  if (timer.unref) timer.unref()
  return timer
}

/** Same idea as m510-remote: localIp must be the address on the path to the radio. */
function pickLocalIpv4 (nearIp) {
  const candidates = []
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      const ipv4 = entry.family === 'IPv4' || entry.family === 4
      if (ipv4 && !entry.internal) candidates.push(entry.address)
    }
  }
  if (nearIp) {
    const same = candidates.find((ip) => sameSubnet24(ip, nearIp))
    if (same) return same
  }
  const radioLan = candidates.find((ip) => ip.startsWith('192.168.2.'))
  if (radioLan) return radioLan
  return candidates[0] || null
}

function sameSubnet24 (a, b) {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  if (pa.length !== 4 || pb.length !== 4) return false
  return pa[0] === pb[0] && pa[1] === pb[1] && pa[2] === pb[2]
}

class RadioSession {
  constructor (options) {
    this.localIp = options.localIp
    this.udp = options.udp
    this.debug = options.debug || (() => {})
    this.onUpdate = options.onUpdate || (() => {})
    this.onNmea = options.onNmea || (() => {})
    this.onRtp = options.onRtp || (() => {})
    this.discoverIntervalMs = options.discoverIntervalMs || 1000
    this.keepaliveMs = options.keepaliveMs || 5000
    this.silenceIntervalMs = options.silenceIntervalMs || 1000
    this.namesReadyDelayMs = options.namesReadyDelayMs == null ? 8000 : options.namesReadyDelayMs
    this.heardTimeoutMs = options.heardTimeoutMs || 10000
    // No radio traffic for this long while Initializing or online → rediscover.
    this.noResponseTimeoutMs = options.noResponseTimeoutMs == null ? 120000 : options.noResponseTimeoutMs
    this.scanIntervalMs = options.scanIntervalMs || 200
    this.scanResumeSeconds = Number.isFinite(options.scanResumeSeconds) ? options.scanResumeSeconds : 30
    this.discoverAddress = options.discoverAddress || '255.255.255.255'
    this.tablePart2Ms = options.tablePart2Ms == null ? 2000 : options.tablePart2Ms
    this.askChannelMs = options.askChannelMs == null ? 4000 : options.askChannelMs
    this.sockets = {}
    this.ports = {}
    this.timers = {}
    this.closed = true
    this.discovering = false
    this.tableRequested = false
    this.namesComplete = false
    this.channels = Object.create(null)
    this.nameNr = 0
    this.nameMode = 0
    this.propertyBytes = Buffer.alloc(0)
    this.lastHeard = 0
    this.initializingSince = null
    this.quietSince = null
    this.keepaliveTarget = null
    this.marked = []
    this.followList = []
    this.includeFollow = false
    this.scanMode = ''
    this.scanHolding = false
    this.scanQuietAt = null
    this.scanSkipUntil = 0
    this.favOverride = Object.create(null)
    this.pending = null
    this.pendingSquelch = null
    // Last user-requested SQL. Marked/fav scan channel hops make the radio
    // report the old level again after a brief confirm; keep asserting until
    // status matches (and re-push after each setChannel while set).
    this.desiredSquelch = null
    this.radio = {
      ip: null,
      port: null,
      status: 'offline',
      busy: false,
      squelch: null,
      horn: null,
      scanning: false,
      dualwatch: false,
      intercom: false,
      channelGroup: '',
    }
    this.channel = null
  }

  start (resume) {
    this.closed = false
    const savedPorts = resume && resume.ports
    const savedRadio = resume && resume.radio
    // Prefer a local address on the radio subnet so the Icom src IP matches the
    // UDP path (boatnet: 192.168.2.1 → 192.168.2.18). m510-remote passes this
    // explicitly; guessing the first NIC (often 192.168.3.x) breaks SQL writes.
    if (savedRadio && savedRadio.ip) {
      const better = pickLocalIpv4(savedRadio.ip)
      if (better) this.localIp = better
    } else if (!this.localIp || this.localIp === '127.0.0.1') {
      this.localIp = pickLocalIpv4(null) || this.localIp
    }
    let pending = ROLES.length
    for (const role of ROLES) {
      const socket = this.udp.createSocket('udp4')
      this.sockets[role] = socket
      socket.on('error', (err) => this.debug(`${role} socket error: ${err.message}`))
      socket.on('message', (msg, rinfo) => this.handleIncoming(role, msg, rinfo))
      const port = savedPorts && savedPorts[role] ? savedPorts[role] : 0
      // Bind 0.0.0.0 so replies arrive on every boatnet address; Icom frames still
      // carry localIp on the radio subnet (see pickLocalIpv4 / index localIpv4).
      socket.bind(port, () => {
        if (this.closed) return
        if (role === 'discovery') socket.setBroadcast(true)
        this.ports[role] = socket.address().port
        pending -= 1
        if (pending !== 0) return
        if (savedRadio && savedRadio.ip) this.resumeRadio(savedRadio)
        this.startDiscovery()
      })
    }
  }

  stop () {
    const resume = {
      ports: { ...this.ports },
      radio: this.radio.ip ? { ip: this.radio.ip, port: this.radio.port } : null,
    }
    this.closed = true
    this.discovering = false
    this.clearTimers()
    const sockets = Object.values(this.sockets)
    this.sockets = {}
    if (!sockets.length) return Promise.resolve(resume)
    return new Promise((resolve) => {
      let left = sockets.length
      const done = () => {
        left -= 1
        if (left === 0) resolve(resume)
      }
      for (const socket of sockets) {
        socket.once('close', done)
        try {
          socket.close()
        } catch (err) {
          this.debug(`socket close failed: ${err.message}`)
          done()
        }
      }
    })
  }

  resumeRadio (saved) {
    this.radio.ip = saved.ip
    this.radio.port = saved.port
    this.radio.status = 'Initializing RS-M500'
    this.lastHeard = Date.now()
    this.initializingSince = Date.now()
    this.resuming = true
    this.armHealthClock()
    this.sendSignIn()
    this.requestChannelTable()
  }

  inject (role, msg, rinfo) {
    this.handleIncoming(role, msg, rinfo)
  }

  getState () {
    return this.snapshot()
  }

  broadcast () {
    if (this.closed || !this.ports.discovery) return
    const frame = protocol.encodeDiscover(this.localIp, this.ports.discovery, this.discoverAddress)
    this.send(this.sockets.discovery, frame, protocol.PORT.DISCOVER, this.discoverAddress)
  }

  sendKeepAlive () {
    if (!this.keepaliveTarget || !this.sockets.keepalive) return
    this.send(
      this.sockets.keepalive,
      protocol.encodeKeepAlive(),
      this.keepaliveTarget.port,
      this.keepaliveTarget.address
    )
  }

  setChannel (index, options = {}) {
    const part = protocol.splitIndex(index)
    const entry = this.entry(part.nr, part.mode)
    if (!this.radio.ip || (!options.force && (!entry || entry.enabled !== true))) {
      this.quietSince = Date.now()
      this.debug(`setChannel refused index ${index}`)
      return false
    }
    const frame = protocol.encodeSetChannel(this.localIp, this.radio.ip, index)
    this.send(this.sockets.control, frame, protocol.PORT.CONTROL, this.radio.ip)
    this.quietSince = Date.now()
    if (options.direction) {
      const previous = this.channel ? protocol.channelIndex(this.channel.nr, this.channel.mode) : null
      const origin = this.seek && this.seek.origin != null ? this.seek.origin : previous
      const hops = this.seek && this.seek.origin != null ? this.seek.hops + 1 : 0
      this.seek = { index, previous, origin, direction: options.direction, hops, until: Date.now() + 800 }
      this.pending = null
    } else {
      // Absolute sets (auto-follow, scan, keypad) must not keep a leftover
      // +/- seek, or a stale status on the old channel re-triggers step().
      // Hold long enough that late status packets for the previous channel
      // (often 16) cannot snap the radio display back after a real confirm.
      this.seek = null
      this.pending = {
        index,
        until: Date.now() + 5000,
        lastSent: Date.now(),
        confirmed: false,
        resent: false,
      }
    }
    this.channel = this.channelFrom(part.nr, part.mode, entry || {})
    // Scan hops make the M510 forget a STATUS-form SQL write; push again on the
    // new channel while the user still wants that level.
    if (this.desiredSquelch != null) this.reassertSquelch()
    this.onUpdate(this.snapshot())
    return true
  }

  step (direction, favOnly) {
    if (!this.channel || this.channel.nr == null) return false
    const mode = this.channel.mode || '00'
    let nr = this.channel.nr
    for (let i = 0; i < protocol.MAX_CHANNEL; i++) {
      nr += direction
      if (nr > protocol.MAX_CHANNEL) nr = 1
      if (nr < 1) nr = protocol.MAX_CHANNEL
      const entry = this.entry(nr, mode)
      const index = protocol.channelIndex(nr, mode)
      if (index == null) continue
      const plain = !favOnly
      if (entry && entry.enabled === false && favOnly !== 'marked' && favOnly !== 'follow') continue
      if (plain && this.refused && this.refused.has(index)) continue
      if (favOnly === 'marked') {
        if (this.marked.indexOf(nr) < 0 && !this.followInScan(nr)) continue
        return this.setChannel(index, { force: true })
      }
      if (favOnly === 'follow') {
        if (this.followList.indexOf(nr) < 0) continue
        return this.setChannel(index, { force: true })
      }
      if (favOnly) {
        if ((!entry || entry.fav !== true) && !this.followInScan(nr)) continue
        return this.setChannel(index, { force: true })
      }
      return this.setChannel(index, this.scanMode ? { force: true } : { force: true, direction })
    }
    return false
  }

  followInScan (nr) {
    return this.includeFollow && this.followList.indexOf(nr) >= 0
  }

  scan (favOnly) {
    this.clearTimer('scan')
    this.seek = null
    const mode = favOnly === 'marked' ? 'marked' : favOnly === 'follow' ? 'follow' : favOnly ? 'favourites' : 'all'
    this.scanMode = mode
    this.scanHolding = false
    this.scanQuietAt = null
    const kind = mode === 'marked' ? 'marked' : mode === 'follow' ? 'follow' : mode === 'favourites'
    const tick = () => {
      if (this.closed || this.scanMode === '') return
      if (this.radio.busy) {
        this.scanHolding = true
        this.scanQuietAt = null
        this.timers.scan = later(tick, this.scanIntervalMs)
        return
      }
      if (this.scanHolding) {
        if (this.scanQuietAt == null) this.scanQuietAt = this.quietSince || Date.now()
        if ((Date.now() - this.scanQuietAt) / 1000 < this.scanResumeSeconds) {
          this.timers.scan = later(tick, this.scanIntervalMs)
          return
        }
        this.scanHolding = false
        this.scanQuietAt = null
      }
      if (this.scanSkipUntil && Date.now() < this.scanSkipUntil) {
        this.timers.scan = later(tick, this.scanIntervalMs)
        return
      }
      this.scanSkipUntil = 0
      if (this.channel) this.step(1, kind)
      this.timers.scan = later(tick, this.scanIntervalMs)
    }
    this.timers.scan = later(tick, Math.min(10, this.scanIntervalMs))
    this.onUpdate(this.snapshot())
  }

  nudgeScan () {
    if (!this.scanMode || !this.channel) return false
    const kind = this.scanMode === 'marked' ? 'marked' : this.scanMode === 'follow' ? 'follow' : this.scanMode === 'favourites'
    const ok = this.step(1, kind)
    this.scanHolding = false
    this.scanQuietAt = null
    this.scanSkipUntil = Date.now() + this.scanIntervalMs
    if (!this.timers.scan) {
      const mode = this.scanMode
      this.scan(mode === 'marked' ? 'marked' : mode === 'favourites')
      this.scanSkipUntil = Date.now() + this.scanIntervalMs
    }
    return ok
  }

  stopScan () {
    const running = this.scanMode !== '' || Boolean(this.timers.scan)
    this.scanMode = ''
    this.scanHolding = false
    this.scanQuietAt = null
    this.scanSkipUntil = 0
    this.clearTimer('scan')
    if (running) this.onUpdate(this.snapshot())
  }

  operate (key, option) {
    if (!this.radio.ip || !this.sockets.control) return false
    const frame = protocol.encodeOperation(this.localIp, this.radio.ip, key, option)
    this.send(this.sockets.control, frame, protocol.PORT.CONTROL, this.radio.ip)
    return true
  }

  setSquelch (level) {
    const n = Math.max(0, Math.min(10, Math.round(Number(level))))
    if (!Number.isFinite(n) || !this.radio.ip || !this.sockets.control) return false
    const index = this.channel
      ? protocol.channelIndex(this.channel.nr, this.channel.mode || '00')
      : null
    if (index == null) return false
    this.desiredSquelch = n
    this.pushSquelch(index, n)
    this.askStatus()
    this.pendingSquelch = {
      level: n,
      until: Date.now() + 60000,
      lastSent: Date.now(),
      resent: false,
      index,
    }
    this.radio.squelch = n
    this.onUpdate(this.snapshot())
    return true
  }

  pushSquelch (index, level) {
    if (!this.radio.ip || !this.sockets.control || index == null) return false
    // STATUS-shaped write (client.js / original plugin). OperationKey.SQL reaches
    // the radio but does not change the level; set-channel operate still works.
    const frame = protocol.encodeSquelch(this.localIp, this.radio.ip, index, level)
    this.send(this.sockets.control, frame, protocol.PORT.CONTROL, this.radio.ip)
    return true
  }

  /** Re-assert desired SQL using the current channel index (after scan hops). */
  reassertSquelch () {
    if (this.desiredSquelch == null || !this.radio.ip || !this.channel) return false
    const index = protocol.channelIndex(this.channel.nr, this.channel.mode || '00')
    if (index == null) return false
    if (this.pendingSquelch) {
      this.pendingSquelch.index = index
      this.pendingSquelch.lastSent = Date.now()
      this.pendingSquelch.resent = true
      this.pendingSquelch.until = Math.max(this.pendingSquelch.until, Date.now() + 15000)
    } else {
      this.pendingSquelch = {
        level: this.desiredSquelch,
        until: Date.now() + 15000,
        lastSent: Date.now(),
        resent: true,
        index,
      }
    }
    return this.pushSquelch(index, this.desiredSquelch)
  }

  askStatus () {
    if (!this.radio.ip || !this.sockets.control) return
    const ask = protocol.encodeAskChannel(this.localIp, this.radio.ip)
    const status = protocol.encodeQueryStatus(this.localIp, this.radio.ip)
    this.send(this.sockets.control, ask, protocol.PORT.CONTROL, this.radio.ip)
    this.send(this.sockets.control, status, protocol.PORT.CONTROL, this.radio.ip)
  }

  togglePower () {
    return this.operate(protocol.OperationKey.TX_POWER, 0)
  }

  toggleFavourite () {
    if (!this.channel || this.channel.nr == null) return false
    const nr = this.channel.nr
    const mode = this.channel.mode || '00'
    const entry = this.ensure(nr, mode)
    const next = entry.fav !== true
    entry.fav = next
    const index = protocol.channelIndex(nr, mode)
    this.favOverride[index] = next
    this.channel.fav = next
    if (this.radio.ip && this.sockets.control) {
      const frame = protocol.encodeSetFavourite(this.localIp, this.radio.ip, index, next)
      this.send(this.sockets.control, frame, protocol.PORT.CONTROL, this.radio.ip)
      this.operate(7, next ? 1 : 0)
    }
    this.onUpdate(this.snapshot())
    return true
  }

  toggleRadioScan () {
    return this.operate(protocol.OperationKey.SCAN, 0)
  }

  toggleDualwatch () {
    return this.operate(protocol.OperationKey.DUALWATCH, 0)
  }

  setPtt (down) {
    return this.operate(protocol.OperationKey.PTT, down ? 1 : 0)
  }

  /**
   * Forward an NMEA 0183 sentence to the radio (AIS targets on the M510 display).
   * Framing matches the old CT-M500 plugin send path on UDP 50004.
   */
  sendNmea (sentence) {
    if (!this.radio.ip || !this.sockets.data) return false
    const text = String(sentence || '').trim()
    if (!text || /aN/.test(text)) return false
    const nmea = Buffer.from(text, 'utf8')
    const length = nmea.length + 2
    const header = Buffer.from([
      0x49, 0x63, 0x6f, 0x6d, 0x01, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x01, 0x00, 0x00, length & 0xff, 0x00, 0x00, 0x00,
      0x01, length & 0xff, 0x02,
    ])
    const frame = Buffer.concat([header, nmea, Buffer.from([0x0d, 0x0a])])
    this.send(this.sockets.data, frame, protocol.PORT.NMEA, this.radio.ip)
    return true
  }

  pressPtt () {
    const scanning = this.scanMode !== ''
    const answering = this.radio.busy || this.scanHolding || this.scanQuietAt != null
    if (scanning && !answering) {
      this.stopScan()
      return 'stopped'
    }
    if (scanning) this.stopScan()
    return this.beginTalk('ptt') ? 'talk' : false
  }

  beginTalk (mode) {
    this.endTalk()
    if (!this.radio.ip) return false
    this.talkMode = mode === 'intercom' ? 'intercom' : 'ptt'
    if (this.rtpSsrc == null) this.rtpSsrc = (Math.random() * 0x100000000) >>> 0
    if (this.talkMode === 'intercom') return this.setIntercom(true)
    return this.setPtt(true)
  }

  sendVoice (mulaw) {
    if (!this.talkMode || !this.radio.ip || !mulaw || !mulaw.length) return false
    const packet = protocol.encodeRtp(mulaw, this.rtpSeq || 0, this.rtpTs || 0, this.rtpSsrc || 0)
    this.rtpSeq = ((this.rtpSeq || 0) + 1) & 0xffff
    this.rtpTs = ((this.rtpTs || 0) + mulaw.length) >>> 0
    this.send(this.sockets.voice, packet, protocol.PORT.VOICE, this.radio.ip)
    return true
  }

  endTalk () {
    if (!this.talkMode) return false
    const mode = this.talkMode
    this.talkMode = ''
    if (mode === 'intercom') return this.setIntercom(false)
    return this.setPtt(false)
  }

  setIntercom (talking) {
    if (!this.radio.ip || !this.sockets.control) return false
    const command = talking ? protocol.IntercomCommand.BEGIN_TALK : protocol.IntercomCommand.END
    const frame = protocol.encodeIntercom(this.localIp, this.radio.ip, command)
    this.send(this.sockets.control, frame, protocol.PORT.CONTROL, this.radio.ip)
    return true
  }

  startDiscovery () {
    if (this.closed) return
    this.discovering = true
    this.broadcast()
    this.clearTimer('discover')
    this.timers.discover = every(() => this.broadcast(), this.discoverIntervalMs)
  }

  handleIncoming (role, msg, rinfo) {
    if (this.closed) return
    const buffer = Buffer.from(msg)
    if (rinfo && rinfo.address && rinfo.address !== this.localIp) {
      this.lastHeard = Date.now()
      if (this.resuming && this.radio.ip === rinfo.address) this.finishResume()
    }
    if (role === 'discovery' && this.discovering) this.acceptDiscovery(buffer, rinfo)
    if (role === 'keepalive' && rinfo && rinfo.address !== this.localIp && !this.timers.keepalive) {
      this.keepaliveTarget = { address: rinfo.address, port: rinfo.port }
      this.timers.keepalive = every(() => this.sendKeepAlive(), this.keepaliveMs)
      this.requestChannelTable()
    }
    const message = protocol.classify(buffer)
    switch (message.type) {
      case 'nmea':
        message.sentences.forEach((sentence) => this.onNmea(sentence))
        break
      case 'status':
        this.applyStatus(message)
        break
      case 'names':
        this.applyNames(message)
        break
      case 'properties':
        this.applyProperties(message)
        break
      case 'favourite':
        this.applyFavourite(message)
        break
      case 'horn':
        this.radio.horn = message.on
        this.onUpdate(this.snapshot())
        break
      case 'rtp':
        this.onRtp(buffer)
        break
      case 'ack':
      case 'keepalive':
        break
      default:
        if (message.frame) {
          this.debug(`icom command 0x${message.frame.command.toString(16)} length ${message.frame.body.length}`)
        }
    }
  }

  acceptDiscovery (buffer, rinfo) {
    if (!rinfo || !rinfo.address || rinfo.address === this.localIp) return false
    if (!protocol.decodeFrame(buffer)) return false
    this.discovering = false
    this.clearTimer('discover')
    this.radio.ip = rinfo.address
    this.radio.port = rinfo.port
    const better = pickLocalIpv4(rinfo.address)
    if (better && better !== this.localIp) {
      this.debug(`localIp ${this.localIp} → ${better} for radio ${rinfo.address}`)
      this.localIp = better
    }
    this.radio.status = 'Initializing RS-M500'
    this.initializingSince = Date.now()
    this.lastHeard = Date.now()
    this.armHealthClock()
    this.sendSignIn()
    this.onUpdate(this.snapshot())
    return true
  }

  finishResume () {
    this.resuming = false
    this.namesComplete = true
    this.radio.status = 'online'
    this.initializingSince = null
    this.quietSince = this.quietSince || Date.now()
    this.armHealthClock()
    this.onUpdate(this.snapshot(0))
  }

  sendSignIn () {
    const frame = protocol.encodeSignIn(this.localIp, this.radio.ip, {
      data: this.ports.data,
      voice: this.ports.voice,
      keepalive: this.ports.keepalive,
      control: this.ports.control,
      extra: this.ports.extra,
    })
    this.send(this.sockets.discovery, frame, this.radio.port, this.radio.ip)
  }

  requestChannelTable () {
    if (this.tableRequested || !this.radio.ip) return
    this.tableRequested = true
    const first = protocol.encodeChannelTableRequest(this.localIp, this.radio.ip, 1)
    this.send(this.sockets.discovery, first, this.radio.port, this.radio.ip)
    this.timers.tablePart2 = later(() => {
      if (this.closed || !this.radio.ip) return
      const second = protocol.encodeChannelTableRequest(this.localIp, this.radio.ip, 2)
      this.send(this.sockets.discovery, second, this.radio.port, this.radio.ip)
    }, this.tablePart2Ms)
    this.timers.askChannel = later(() => {
      if (this.closed || !this.radio.ip) return
      // m510-remote: ask channel + empty status query together.
      this.askStatus()
    }, this.askChannelMs)
  }

  applyStatus (status) {
    const part = protocol.splitIndex(status.index)
    const entry = this.entry(part.nr, part.mode)
    const wasBusy = this.radio.busy
    if (this.desiredSquelch != null) {
      const want = this.desiredSquelch
      if (status.squelch === want) {
        this.pendingSquelch = null
        this.radio.squelch = want
      } else {
        const now = Date.now()
        if (!this.pendingSquelch || this.pendingSquelch.level !== want) {
          this.pendingSquelch = {
            level: want,
            until: now + 60000,
            lastSent: 0,
            resent: false,
            index: this.channel
              ? protocol.channelIndex(this.channel.nr, this.channel.mode || '00')
              : null,
          }
        }
        if (!this.pendingSquelch.resent || now - this.pendingSquelch.lastSent >= 500) {
          this.pendingSquelch.resent = true
          this.pendingSquelch.lastSent = now
          const index = this.channel
            ? protocol.channelIndex(this.channel.nr, this.channel.mode || '00')
            : this.pendingSquelch.index
          this.pushSquelch(index, want)
        }
        this.radio.squelch = want
      }
    } else if (this.pendingSquelch) {
      if (status.squelch === this.pendingSquelch.level) {
        this.pendingSquelch = null
        this.radio.squelch = status.squelch
      } else if (Date.now() < this.pendingSquelch.until) {
        if (this.radio.ip && (!this.pendingSquelch.resent || Date.now() - this.pendingSquelch.lastSent >= 500)) {
          this.pendingSquelch.resent = true
          this.pendingSquelch.lastSent = Date.now()
          const index = this.pendingSquelch.index != null
            ? this.pendingSquelch.index
            : (this.channel ? protocol.channelIndex(this.channel.nr, this.channel.mode || '00') : null)
          this.pushSquelch(index, this.pendingSquelch.level)
        }
        this.radio.squelch = this.pendingSquelch.level
      } else {
        this.debug(`squelch ${this.pendingSquelch.level} not confirmed, radio still ${status.squelch}`)
        this.pendingSquelch = null
        this.radio.squelch = status.squelch
      }
    } else {
      this.radio.squelch = status.squelch
    }
    this.radio.busy = status.busy
    this.radio.scanning = status.scanning === true
    this.radio.dualwatch = status.dualwatch === true
    this.radio.intercom = status.intercom === true
    this.radio.channelGroup = protocol.channelGroupLabel(status.groupName, status.wx)
    if (wasBusy && !status.busy) this.quietSince = Date.now()
    if (this.scanMode) this.seek = null
    if (this.seek && status.index === this.seek.index) {
      this.seek = null
      if (this.refused) this.refused.delete(status.index)
    } else if (this.seek && status.busy && (status.index === this.seek.previous || status.index === this.seek.origin)) {
      if (this.channel) this.channel.busy = true
      this.onUpdate(this.snapshot())
      return
    } else if (this.seek && Date.now() < this.seek.until && this.seek.hops < 4 && (status.index === this.seek.previous || status.index === this.seek.origin)) {
      const direction = this.seek.direction
      if (!this.refused) this.refused = new Set()
      this.refused.add(this.seek.index)
      this.step(direction, false)
      return
    }
    if (this.pending) {
      if (status.index === this.pending.index) {
        this.pending.confirmed = true
        this.pending.until = Math.max(this.pending.until, Date.now() + 4000)
      } else if (Date.now() < this.pending.until) {
        // Conflicting status: either still switching, or a late packet for the
        // previous channel after we already saw the target. Keep the target
        // and re-send the set so the radio does not stick on e.g. 16.
        if (this.radio.ip && (!this.pending.resent || Date.now() - this.pending.lastSent >= 500)) {
          this.pending.resent = true
          this.pending.lastSent = Date.now()
          const frame = protocol.encodeSetChannel(this.localIp, this.radio.ip, this.pending.index)
          this.send(this.sockets.control, frame, protocol.PORT.CONTROL, this.radio.ip)
        }
        const want = protocol.splitIndex(this.pending.index)
        const held = this.entry(want.nr, want.mode) || {}
        this.channel = this.channelFrom(want.nr, want.mode, held)
        this.channel.busy = status.busy === true
        this.onUpdate(this.snapshot())
        return
      } else {
        // Gave up holding. Allow auto-follow to retry without waiting a full
        // silence window (setChannel had reset quietSince).
        this.pending = null
        this.quietSince = Date.now() - 120000
      }
    }
    const watt = status.watt == null ? entry && entry.watt : status.watt
    const hilo = status.hilo == null ? entry && entry.hilo : status.hilo
    if (entry && status.watt != null) {
      entry.watt = status.watt
      entry.hilo = status.hilo
    }
    this.channel = {
      nr: part.nr,
      mode: part.mode,
      label: protocol.formatChannel(part.nr, part.mode),
      name: entry && entry.name,
      fav: entry && entry.fav,
      enabled: entry && entry.enabled,
      duplex: entry && entry.duplex,
      watt,
      hilo,
      busy: status.busy === true,
    }
    this.onUpdate(this.snapshot())
  }

  applyNames (block) {
    for (const name of block.names) this.addName(name)
    if (!block.done || this.namesComplete) return
    this.namesComplete = true
    this.radio.status = 'Initializing RS-M500'
    if (this.initializingSince == null) this.initializingSince = Date.now()
    this.quietSince = Date.now()
    this.armHealthClock()
  }

  addName (name) {
    const mode = protocol.MODES[this.nameMode]
    const entry = this.ensure(this.nameNr, mode)
    entry.name = name
    if (this.channel && this.channel.nr === this.nameNr && this.channel.mode === mode) {
      this.channel.name = name
      this.onUpdate(this.snapshot())
    }
    this.nameMode += 1
    if (this.nameMode === 3) {
      this.nameMode = 0
      this.nameNr += 1
    }
  }

  applyProperties (message) {
    if (message.offset === 0) {
      this.propertyBytes = Buffer.from(message.payload)
    } else if (message.offset === this.propertyBytes.length || message.offset === 200) {
      this.propertyBytes = Buffer.concat([this.propertyBytes, message.payload])
    } else {
      this.debug(`property block at offset ${message.offset} does not follow ${this.propertyBytes.length}`)
      return
    }
    const records = protocol.propertyRecords(this.propertyBytes)
    records.forEach((fields, index) => {
      const part = protocol.splitIndex(index)
      const entry = this.ensure(part.nr, part.mode)
      const key = protocol.channelIndex(part.nr, part.mode)
      entry.fav = Object.prototype.hasOwnProperty.call(this.favOverride, key)
        ? this.favOverride[key]
        : fields.fav
      entry.enabled = fields.enabled
      entry.watt = fields.watt
      entry.duplex = fields.duplex
    })
  }

  applyFavourite (message) {
    const part = protocol.splitIndex(message.index)
    const entry = this.entry(part.nr, part.mode)
    if (!entry) return
    const key = protocol.channelIndex(part.nr, part.mode)
    const favourite = Object.prototype.hasOwnProperty.call(this.favOverride, key)
      ? this.favOverride[key]
      : message.favourite
    entry.fav = favourite
    if (this.channel && this.channel.nr === part.nr && this.channel.mode === part.mode) {
      this.channel.fav = favourite
      this.onUpdate(this.snapshot())
    }
  }

  publishClock () {
    if (this.closed) return
    const now = Date.now()
    const heardAgo = now - this.lastHeard
    const initializing = this.radio.status === 'Initializing RS-M500'
    const online = this.radio.status === 'online'
    if ((initializing || online) && this.lastHeard && heardAgo >= this.noResponseTimeoutMs) {
      this.debug(`no radio response for ${Math.round(heardAgo / 1000)}s, rediscovering`)
      this.dropAndRediscover()
      return
    }
    if (initializing && heardAgo < this.heardTimeoutMs) {
      const since = this.initializingSince || now
      const waited = now - since
      const namesReady = this.namesComplete && waited >= this.namesReadyDelayMs
      const stuckWithStatus = !this.namesComplete && this.channel && waited >= this.namesReadyDelayMs
      if (namesReady || stuckWithStatus) {
        this.radio.status = 'online'
        this.initializingSince = null
        if (this.channel) {
          const entry = this.entry(this.channel.nr, this.channel.mode)
          if (entry && entry.name) this.channel.name = entry.name
        }
        this.onUpdate(this.snapshot(0))
        return
      }
    }
    if (online) {
      const silence = Math.floor((now - (this.quietSince || now)) / 1000)
      this.onUpdate(this.snapshot(silence))
    }
  }

  dropAndRediscover () {
    this.radio.status = 'offline'
    this.radio.busy = false
    this.radio.channelGroup = ''
    this.channel = null
    this.initializingSince = null
    this.resetTable()
    this.clearTimer('keepalive')
    this.keepaliveTarget = null
    this.onUpdate(this.snapshot(null))
    this.startDiscovery()
  }

  armHealthClock () {
    if (this.timers.silence) return
    this.timers.silence = every(() => this.publishClock(), this.silenceIntervalMs)
  }

  resetTable () {
    this.channels = Object.create(null)
    this.nameNr = 0
    this.nameMode = 0
    this.propertyBytes = Buffer.alloc(0)
    this.tableRequested = false
    this.namesComplete = false
    this.clearTimer('silenceArm')
    this.clearTimer('tablePart2')
    this.clearTimer('askChannel')
  }

  entry (nr, mode) {
    const row = this.channels[nr]
    return row && row[mode]
  }

  ensure (nr, mode) {
    if (!this.channels[nr]) this.channels[nr] = Object.create(null)
    if (!this.channels[nr][mode]) this.channels[nr][mode] = {}
    return this.channels[nr][mode]
  }

  channelFrom (nr, mode, entry) {
    return {
      nr,
      mode,
      label: protocol.formatChannel(nr, mode),
      name: entry.name,
      fav: entry.fav,
      enabled: entry.enabled,
      duplex: entry.duplex,
      watt: entry.watt,
      hilo: entry.hilo,
      busy: false,
    }
  }

  snapshot (silence) {
    return {
      radio: { ...this.radio },
      channel: this.channel ? { ...this.channel } : null,
      scanMode: this.scanMode,
      marked: this.marked.slice(),
      quietSince: this.quietSince,
      silence: silence === undefined ? null : silence,
    }
  }

  send (socket, frame, port, address) {
    if (this.closed || !socket) return
    try {
      socket.send(frame, 0, frame.length, port, address, (err) => {
        if (err) this.debug(`send failed: ${err.message}`)
      })
    } catch (err) {
      this.debug(`send failed: ${err.message}`)
    }
  }

  clearTimer (name) {
    if (!this.timers[name]) return
    clearInterval(this.timers[name])
    clearTimeout(this.timers[name])
    delete this.timers[name]
  }

  clearTimers () {
    for (const name of Object.keys(this.timers)) this.clearTimer(name)
  }
}

module.exports = { RadioSession }
