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
    let pending = ROLES.length
    for (const role of ROLES) {
      const socket = this.udp.createSocket('udp4')
      this.sockets[role] = socket
      socket.on('error', (err) => this.debug(`${role} socket error: ${err.message}`))
      socket.on('message', (msg, rinfo) => this.handleIncoming(role, msg, rinfo))
      const port = savedPorts && savedPorts[role] ? savedPorts[role] : 0
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
    }
    this.channel = this.channelFrom(part.nr, part.mode, entry || {})
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
    if (!Number.isFinite(n) || !this.operate(protocol.OperationKey.SQL, n)) return false
    this.radio.squelch = n
    this.onUpdate(this.snapshot())
    return true
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
      const ask = protocol.encodeAskChannel(this.localIp, this.radio.ip)
      this.send(this.sockets.control, ask, protocol.PORT.CONTROL, this.radio.ip)
    }, this.askChannelMs)
  }

  applyStatus (status) {
    const part = protocol.splitIndex(status.index)
    const entry = this.entry(part.nr, part.mode)
    const wasBusy = this.radio.busy
    this.radio.squelch = status.squelch
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
