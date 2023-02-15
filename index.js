const util = require('util')
const _ = require('lodash')
// const Speaker = require('speaker');
const regex_fav =        /49636f6d010000009........................90000000[012]000000....0.00[0246]./g
const regex_name =       /49636f6d010000009101a8c01901a8c000060000e40000000000000/g
const regex_properties = /49636f6d010000009[12]01a8c01901a8c000050000d00000000/g
const regex_update =     /49636f6d010000009[12]01a8c01901a8c00102000010000000....bd003000bd000205..00..000000/g
const is_rtp = require('is-rtp')
const RTPParser = require('@penggy/easy-rtp-parser');

var globalOptions = []



module.exports = function (app) {
  var plugin = {}
  var unsubscribes = []
  var timers = []

  plugin.id = 'signalk-icom-m510e-plugin'
  plugin.name = 'ICOM M510E plugin'
  plugin.description = 'Get active channel information and change channel over wlan.'

  var schema = {
    // The plugin schema
    properties: {
      'null': {
        'title': 'Set new names for data types',
        'type': 'null',
      },
    }
  }

  function sendN2k(msgs) {
    app.debug("n2k_msg: " + msgs)
    msgs.map(function(msg) { app.emit('nmea2000out', msg)})
  }

  plugin.schema = function() {
    return schema
  }

  plugin.start = function (options, restartPlugin) {
    // Here we put our plugin logic
    app.debug('Plugin started');
    var unsubscribes = [];
		var udp = require('dgram');
		var serverA = udp.createSocket('udp4');
		var serverB = udp.createSocket('udp4');
		var serverC = udp.createSocket('udp4');
		var serverD = udp.createSocket('udp4');
		var serverVoice = udp.createSocket('udp4');
		var modeArray = ['00', '10', '20']
		var radio = {busy: false}
		var ready = false
		var findRadioTimer
		var keepAliveTimer = false
		var listenPortA 
		var listenPortB 
		var listenPortC 
		var listenPortD 
		var listenPortVoice
		var channelTable = {'requested': false}
		var channelTableNr = 0
		var channelMode = '00'
		var propertiesHex
		var activeChannelObj = {}
		var header

    globalOptions = options;
    app.debug ('%j', globalOptions)

	
    /*
		// Create the Speaker instance
		const speaker = new Speaker({
		  channels: 1,          // 2 channels
		  bitDepth: 16,         // 16-bit samples
		  sampleRate: 8000     // 8000 Hz sample rate
		})
    */
		
		
		serverA.on('message',function(msg,info){
		  if (!findRadioTimer._destroyed) {
		    clearInterval(findRadioTimer)
		    radio.ip = info.address
		    radio.port = info.port
		    // app.debug('Received ServerA packet')
		    // app.debug(msg.toString('hex') + " " + msg.toString('utf-8'))
		    header = msg.slice(0,17).toString('hex')
		    app.debug('Header: ' + header)
        sendRadio(radio)
		    sendSignIn(radio.ip, radio.port, listenPortB, listenPortC, listenPortD, listenPortVoice)
		  } else {
		    app.debug('ServerA: ' + msg.toString())
		    // app.debug(msg.slice(0,48).toString('hex') + ' [' + msg.length + ']');
		    // app.debug('Received %d bytes from %s:%d\n',msg.length, info.address, info.port);
		    app.debug(msg.toString('hex'))
		  }
		})
		
		serverB.on('message',function(msg,info) {
		  app.debug('ServerB (' + info.address + ':' + info.port + '): ' + msg.toString('hex') + " " + msg.toString('utf-8'))
		  if (!keepAliveTimer) {
		    app.debug('Starting keepalive')
		    keepAliveTimer = setInterval(() => keepAlive(info.address, info.port), 5000)
		  }
		  // app.debug('channelTable.requested: ' + channelTable.requested)
		  if (channelTable.requested == false) {
		    requestChannels(radio.ip, radio.port, 1)
		    setTimeout(() => askChannel(), 4000)
		    setTimeout(() => requestChannels(radio.ip, radio.port, 2), 5000)
		  }
		})
		
		serverC.on('message',function(msg,info) {
		  const hex = Array.from(msg)
		  let msgString = msg.toString('hex')
		  if (msg.length == 28) {
		    app.debug('ServerC ACK (' + info.address + ':' + info.port + '): [' + msg.length + '] ' + msg.toString('hex'))
		  } else if (msgString.match(regex_update)) {
		    readChannelUpdate(msg)
		  } else {
		    let s = parseInt(hex[35].toString(16),16)
		    switch (s) {
		      case 128:
            if (radio.busy == false) {
		          radio.busy = true
              sendRadio()
            }
		        break
		      case 0:
            if (radio.busy == true) {
		          radio.busy = false
              sendRadio()
            }
		        break
		    }
		    app.debug('ServerC channel info (' + info.address + ':' + info.port + '): [' + msg.length + '] ' + msg.toString('hex'))
        activeChannelObj = JSON.parse(JSON.stringify(getChannel(hex)))
		    app.debug("activeChannelObj:  " + JSON.stringify(activeChannelObj))
		  } 
      sendRadio()
      sendChannel()
		})
		
		function readChannelUpdate (msg) {
		  const hex = Array.from(msg)
		  app.debug(hex.join(' '))
		  app.debug('readChannelUpdate')
		  radio.squelch = hex[34]
		  switch (hex[35]) {
		    case 3:
		      activeChannelObj.watt = 1
		      activeChannelObj.hilo = false
		      break
		    case 7:
		      activeChannelObj.watt = 1
		      activeChannelObj.hilo = true
		      break
		    case 15:
		      activeChannelObj.watt = 25
		      activeChannelObj.hilo = true
		      break
		  }
		  if (typeof activeChannelObj.nr != 'undefined') {
		    channelTable[activeChannelObj.nr][activeChannelObj.mode].watt = activeChannelObj.watt
		    app.debug(hex.join(' '))
		    app.debug(radio)
		    app.debug(activeChannelObj)
		  }
		}
		
		serverVoice.on('message',function(msg,info) {
		  const hex = Array.from(msg)
		  app.debug('serverVoice (' + info.address + ':' + info.port + '): ' + msg.toString('hex'))
		  // msg.pipe(speaker)
		})
		
		function updateChannelFav (hex) {
		  let f = parseInt(hex[32].toString(16),16)
		  let h = hex2bin(hex[32])
      app.debug('updateChannelFav: hex: ' + hex.join(' '))
      app.debug('updateChannelFav: f: ' + f + "  h: " + h)
		  let channel = getChannelInfoHex(hex[29], hex[28])
		  var fav
		  switch (h[5]) {
		    case 1:
		      fav = true
		      break
		    case 0:
		      fav = false
		      break
		  }
		  if (typeof channelTable[channel.nr] != 'undefined') {
		    if (typeof channelTable[channel.nr][channel.mode] != 'undefined') {
		      channelTable[channel.nr][channel.mode].fav = fav
		      activeChannelObj.fav = fav
		    }
		  }
		}
		
		function getChannelInfoN (n) {
		  let r = n % 3
		  let nr = Math.floor(n / 3)
		  var mode = modeArray[r]
		  var info = {nr: nr, mode: mode}
		  if (typeof channelTable[nr] != 'undefined'){
		    info.name = channelTable[nr][mode].name
		    info.fav = channelTable[nr][mode].fav
		    info.watt = channelTable[nr][mode].watt
		    info.duplex = channelTable[nr][mode].duplex
		    info.enabled = channelTable[nr][mode].enabled
		  }
		  return info
		}
		
		function getChannelInfoHex (hex1, hex2) {
		  let n = (parseInt(hex1.toString(16),16) * 256) + parseInt(hex2.toString(16),16)
		  return getChannelInfoN(n)
		}
		
		function getChannel (hex) {
		  app.debug('getChannel: ' + hex.join(' '))
		  let channel = getChannelInfoHex(hex[27], hex[26])
		  radio.squelch = hex[34]
		  // app.debug('getChannel channel: ' + JSON.stringify(channel))
		  let w = hex[36]
		  // app.debug('w: ' + w)
		  switch (w) {
		    case 3:
		      channel.watt = 1
		      channel.hilo = false
		      break
		    case 7:
		      channel.watt = 1
		      channel.hilo = true
		      break
		    case 11:
		      channel.watt = 1
		      channel.hilo = true
		      break
		    case 15:
		      channel.watt = 25
		      channel.hilo = true
		      break
		  }
		  if (typeof channelTable[channel.nr] != 'undefined') {
		    if (typeof channelTable[channel.nr][channel.mode] != 'undefined') {
		      channelTable[channel.nr][channel.mode].watt = channel.watt
		      channelTable[channel.nr][channel.mode].hilo = channel.hilo
		      channel.name = channelTable[channel.nr][channel.mode].name
		      channel.fav = channelTable[channel.nr][channel.mode].fav
		      channel.enabled = channelTable[channel.nr][channel.mode].enabled
		      channel.duplex = channelTable[channel.nr][channel.mode].duplex
		      channel.properties = channelTable[channel.nr][channel.mode].properties
		    }
		  }
		  return channel
		}
		
		serverD.on('message',function(msg,info) {
		  const hex = Array.from(msg)
		  let msgString = msg.toString('hex')
		  // app.debug('ServerD:\n' + msg.toString('hex') + "\n" + msg.toString('utf-8'))
		  if (msgString.match(regex_name)) {
		    // app.debug('ServerD Channel name:\n' + msg.toString('hex') + "\n" + msg.toString('utf-8'))
		    let chunk = msg.slice(28)
		    let startValue = parseInt(chunk.slice(1,2).toString('hex')+chunk.slice(0,1).toString('hex'), 16)
		    chunk = chunk.slice(3)
		    // app.debug('StartValue: ' + startValue + ' nr: ' + channelTableNr)
		    while (chunk.length > 10) {
		      let name = chunk.slice(1, 11).toString('utf-8')
		      addNameToChannelTable(name.trim())
		      chunk = chunk.slice(11)
		    }
		    if (startValue == 520) {
		      ready = true
		      //sendChannelTable()
		    }
		  } else if (msgString.startsWith('8000')) {
		    if (is_rtp(msg)) {
		      var rtp = RTPParser.parseRtpPacket(msg);
		      // app.debug(rtp);
		      var bKeyframe = RTPParser.isKeyframeStart(rtp.payload);
		      // app.debug(`key frame : ${bKeyframe}`);
		      // speaker.write(Buffer.from(rtp.payload))
		    }
		    // app.debug('Voice (' + info.address + ':' + info.port + '): ' + msgString)
		    //app.debug('Voice (' + info.address + ':' + info.port + '): ' + wav.toString('hex'))
		  } else if (msgString.match(regex_properties)) {
		      // app.debug('ServerD (' + info.address + ':' + info.port + '): ' + msgString)
		      propertiesMsg(msg)
		  } else if (msgString.match(regex_fav)) {
		      updateChannelFav(msg)
		  } else {
		    app.debug('ServerD:\n' + msg.toString('hex') + "\n" + msg.toString('utf-8'))
		  }
		})
		
		function propertiesMsg (msg) {
		  var hex = Array.from(msg)
		  msg = msg.slice(32)
		  var propertiesType = hex[24]
		  app.debug("propertiesType: " + propertiesType)
		  if (hex[28] == 0) {
		    app.debug('propertiesMsg: First message')
		    propertiesHex = Array.from(msg)
		    app.debug('propertiesMsg: ' + msg.toString('hex'))
		  } else if (hex[28] == 200) {
		    app.debug('propertiesMsg: Second message')
		    propertiesHex = propertiesHex.concat(Array.from(msg))
		    app.debug('propertiesMsg: ' + msg.toString('hex'))
		    app.debug('propertiesMsg: ' + JSON.stringify(propertiesHex))
		    var nr = 0
		    var modePos = 0
		    while (propertiesHex.length > 1) {
		      let v = propertiesHex.shift()
		      let b = hex2bin(v)
		      let vInt = parseInt(v.toString(16), 16)
		      var f
		      var mode = modeArray[modePos]
		      channelTable[nr] = channelTable[nr] || {}
		      channelTable[nr][mode] = channelTable[nr][mode] || {}
		      channelTable[nr][mode]['properties'] = channelTable[nr][mode]['properties'] || ''
		      channelTable[nr][mode]['properties'] = channelTable[nr][mode]['properties'] + b
		      if (channelTable[nr][mode]['properties'].length == 24) {
		        propertiesSet(nr, mode, channelTable[nr][mode]['properties'])
		      }
		
		      // Next loop
		      modePos++
		      if (modePos == 3) {
		        modePos = 0
		        nr++
		        // app.debug('Nr: ' + nr)
		      }
		    }
		  }
		}
		
		function propertiesSet(nr, mode, properties) {
		
		  // Favourite set
      let offset=15
		  if (properties[offset+5] == 0) {
		    channelTable[nr][mode]['fav'] = true
		  } else {
		    channelTable[nr][mode]['fav'] = false
		  }
		
		  // Channel enabled
		  if (properties[8] == 0) {
		    channelTable[nr][mode]['enabled'] = true
		  } else {
		    channelTable[nr][mode]['enabled'] = false
		  }
		
		  // 1 Watt
		  if (properties[offset+4] == 0) {
		    channelTable[nr][mode]['watt'] = 25
		  } else {
		    channelTable[nr][mode]['watt'] = 1
		  }
		
		  // Duplex
      // 00110100 (edge case)
		  if (properties[offset+7] == 0 && properties[offset+4] != 1) {
		    channelTable[nr][mode]['duplex'] = true
		  } else {
		    channelTable[nr][mode]['duplex'] = false
		  } 

		  app.debug("nr: " + nr + " mode: " + mode + " properies: " + properties)
		  app.debug(channelTable[nr][mode])
		}
		
		
		function hex2bin(hex){
		    return ("00000000" + (parseInt(hex, 16)).toString(2)).substr(-8);
		}
		
		function addNameToChannelTable (name) {
		  // app.debug('Adding ' + name + ' to ' + channelTableNr + ' ' + channelMode)
		  channelTable[channelTableNr] = channelTable[channelTableNr] || {}
		  channelTable[channelTableNr][channelMode] = channelTable[channelTableNr][channelMode] || {}
		  channelTable[channelTableNr][channelMode].name = name
		  switch (channelMode) {
		    case '00':
		      channelMode = '10'
		      break
		    case '10':
		      channelMode = '20'
		      break
		    case '20':
		      channelMode = '00'
		      channelTableNr++
		      break
		  }
		}
		
		serverA.on('error',function(error){
		  app.debug('Error: ' + error);
		  server.close();
		})

		serverB.on('error',function(error){
		  app.debug('Error: ' + error);
		  server.close();
		})

		serverC.on('error',function(error){
		  app.debug('Error: ' + error);
		  server.close();
		})

		serverD.on('error',function(error){
		  app.debug('Error: ' + error);
		  server.close();
		})
		
		serverA.bind(function() {
		  serverA.setBroadcast(true);
		  const address = serverA.address()
		  app.debug("Client using portA " + address.port)
		  listenPortA = address.port
		  findRadioTimer = setInterval(broadcastNew, 1000);
		})
		
		serverB.bind(function() {
		  const address = serverB.address()
		  app.debug("Client using portB " + address.port)
		  listenPortB = address.port
		})
		
		serverC.bind(function() {
		  const address = serverC.address()
		  app.debug("Client using portC " + address.port)
		  listenPortC = address.port
		})
		
		serverD.bind(function() {
		  const address = serverD.address()
		  app.debug("Client using portD " + address.port)
		  listenPortD = address.port
		})
		
		serverVoice.bind(function() {
		  const address = serverD.address()
		  app.debug("Client using voice port " + address.port)
		  listenPortVoice = address.port
		})
		
		function broadcastNew() {
		  var hex = listenPortA.toString(16)
		  hex = hex[2]+hex[3]+hex[0]+hex[1]
		  var broadcastMsg = Buffer.from("49636f6d01ff0000b901a8c0ffffffff0000000004000000" + hex + "0000", "hex")
		  serverA.send(broadcastMsg, 0, broadcastMsg.length, 50000, '255.255.255.255', function() {
		    app.debug("Broadbast sent '" + broadcastMsg + "'");
		    app.debug(broadcastMsg)
		  })
		}
		
		function keepAlive (ip, port) {
		  var keepAliveMsg = Buffer.from("8001004", "hex")
		  serverB.send(keepAliveMsg, 0, keepAliveMsg.length, port, ip, function() {
		    // app.debug("Sent keepalive")
		  })
		}
		
		function requestChannels (ip, port, nr) {
		  var msg1 = Buffer.from("49636f6d01020000ca01a8c09901a8c0000400000400000000000000", "hex")
		  var msg2 = Buffer.from("49636f6d01020000ca01a8c09901a8c000040000020000000100", "hex")
		 
		  if (nr == 1) {
		    msg = msg1
		  } else if (nr == 2) {
		    msg = msg2
		  }
		  serverA.send(msg, 0, msg.length, port, ip, function() {
		    app.debug("Sent channel request to " + ip + ":" + port + "  " + msg.toString('hex') + " " +  msg.toString('utf-8'))
		  })
		  channelTable.requested = true
		}
		
		function sendSignIn (ip, port, portB, portC, portD, portVoice) {
		  var portBhex = portB.toString(16)
		  portBhex = portBhex[2]+portBhex[3]+portBhex[0]+portBhex[1]
		  var portChex = portC.toString(16)
		  portChex = portChex[2]+portChex[3]+portChex[0]+portChex[1]
		  var portDhex = portD.toString(16)
		  portDhex = portDhex[2]+portDhex[3]+portDhex[0]+portDhex[1]
		  var portVoicehex = portVoice.toString(16)
		  portVoicehex = portVoicehex[2]+portVoicehex[3]+portVoicehex[0]+portVoicehex[1]
		  var signIn = Buffer.from("49636f6d01ff0000ca01a8c09901a8c000020000380000000200" + portDhex + portVoicehex + portBhex + portChex + "2ab052532d4d35303000000042134195000000000000000000000000000000000000000000000000000000000000", "hex")
		  serverA.send(signIn, 0, signIn.length, port, ip, function() {
		    app.debug("Sending SignIn to use portB:" + portB + " portC:" + portC)
		    app.debug(signIn.toString('utf-8'))
		  })
		}
		
		function changeChannelTo (n) {
		  let nr = Math.floor(n / 3)
		  let r = n % 3
      let mode = modeArray[r]
      if (typeof channelTable[nr] != 'undefined') {
        if (typeof channelTable[nr][mode] != 'undefined') {
          if (typeof channelTable[nr][mode].enabled != 'undefined') {
            if (channelTable[nr][mode].enabled == true) {
      		    //49 63 6f 6d 01 02 00 00 ca 01 a8 c0 99 01 a8 c0 01 00 00 00 08 00 00 00 03 00 00 00 01 00 1e 00
      		    //49 63 6f 6d 01 02 00 00 ca 01 a8 c0 99 01 a8 c0 01 00 00 00 08 00 00 00 02 00 00 00 01 00 21 00
      		    let chHex = ('0000'+(n).toString(16)).substr(-4)
      		    chHex = chHex[2] + chHex[3] + chHex[0] + chHex[1]
      		    msg = Buffer.from("49636f6d01020000ca01a8c09901a8c00100000008000000030000000100" + chHex, "hex")
      		    serverC.send(msg, 0, msg.length, 50003, radio.ip, function () {
      		      // app.debug('Change channel: n: ' + n + ' hex: ' + chHex + '  ' + msg.toString('hex'))
      		      activeChannelObj = JSON.parse(JSON.stringify(getChannelInfoN(n)))
      		    })
		          app.debug("changeChannelTo: activeChannelObj:  " + JSON.stringify(activeChannelObj))
              return true
            } else {
              return false
            }
          }
        }
      }
		}
		
		function changeChannelUpDown (channelObj, direction) {
		  app.debug("changeChannelUpDown")
		  // app.debug(channelObj)
		  var n = (channelObj.nr * 3) + modeArray.indexOf(channelObj.mode)
		  var nr, r, enabled, fav, match, lookupWorks
		  do {
		    if (n > 88*3) { 
          n = 2 
        } else if (n < 2) {
          n = 88*3+1
        }
		    lookupWorks = false
		    enabled = false
        fav = false
		    n = n + direction
		    r = n % 3
		    nr = Math.floor(n / 3)
        mode = modeArray[r]
		    if (typeof channelTable[nr] != 'undefined') {
          if (typeof channelTable[nr][mode] != 'undefined') {
            if (typeof channelTable[nr][mode].enabled != 'undefined') {
		          enabled = channelTable[nr][mode].enabled
		          if (typeof channelTable[nr][mode].fav != 'undefined') {
                fav = channelTable[nr][mode].fav
		            lookupWorks = true
              }
            }
          }
		    }
		    app.debug('Finding next channel: nr: ' + nr + ' mode: ' + modeArray[r] + ' enabled: ' + enabled + ' fav: ' + fav + ' lookupWorks: ' + lookupWorks)
		    if (lookupWorks == true && fav == true && enabled == true ) {
		      match = true
		    } else {
		      match = false
		    }
		  } while (match == false)
		  if (lookupWorks) {
		    // app.debug('Next channel: ' + nr + ' ' + modeArray[r])
		    return(changeChannelTo(n))
		  } else {
		    app.debug("Can't lookup yet")
		  }
		}
		
		function askChannel () {
		  var msg = Buffer.from("49636f6d01020000ca01a8c09901a8c00103000000000000", "hex")
		  serverC.send(msg, 0, msg.length, 50003, radio.ip, function () {
		    app.debug("Sending askChannel")
		  })
		  var msg = Buffer.from("49636f6d01020000ca01a8c09901a8c00102000000000000", "hex")
		  serverC.send(msg, 0, msg.length, 50003, radio.ip, function () {
		    app.debug("Sending askChannel")
		  })
		}
		
		function scanUp () {
		  // app.debug('activeChannelObj: ' + JSON.stringify(activeChannelObj))
		  if (!radio.busy) {
		    changeChannelUpDown(activeChannelObj, 1)
		    setTimeout(() => scanUp(), 200)
		  }
		}
		
		function squelch (level) {
		  // 49636f6d010000009101a8c01901a8c001020000100000000203bd003000bd000205050007000000
		  // 49636f6d010000009101a8c01901a8c001020000100000000203bd003000bd000205010007000000
		  let levelHex = ("00" + level.toString(16)).substr(-2);
		  var msg = Buffer.from("49636f6d010000009102a8c01901a8c001020000100000000203bd003000bd000205" + levelHex + "0007000000", "hex")
		  serverC.send(msg, 0, msg.length, 50003, radio.ip, function () {
		    app.debug("Sending squelch msg " + msg.toString('hex'))
		  })
		}
		
    function sendRadio () {
      app.debug('sendRadio: ' + JSON.stringify(radio))
      var values = []
      var path = 'communication.vhf'
      if (typeof radio.ip != 'undefined') {
        values.push({path: path + '.ip', value: radio.ip})
        values.push({path: path + '.port', value: radio.port})
      }
      if (typeof radio.squelch != 'undefined') {
        values.push({path: path + '.squelch', value: radio.squelch})
      }
      if (typeof radio.busy != 'undefined') {
        values.push({path: path + '.busy', value: radio.busy})
      }
      app.handleMessage(plugin.id, {
        updates: [
          {
            values: values
          }
        ]
      })
    }

    function sendChannel () {
      app.debug('sendChannel: ' + JSON.stringify(activeChannelObj))
      var values = []
      var path = 'communication.vhf'
      if (typeof activeChannelObj.nr != 'undefined') {
        if (typeof activeChannelObj.mode != 'undefined') {
          if (activeChannelObj.mode == "00") {
            values.push({path: path + '.channel', value: activeChannelObj.nr.toString()})
          } else {
            let channel = activeChannelObj.mode + ("00" + activeChannelObj.nr.toString()).substr(-2)
            values.push({path: path + '.channel', value: channel})
          }
        }
      }
      if (typeof activeChannelObj.watt != 'undefined') {
        values.push({path: path + '.watt', value: activeChannelObj.watt})
      }
      if (typeof activeChannelObj.duplex != 'undefined') {
        values.push({path: path + '.duplex', value: activeChannelObj.duplex})
      }
      if (typeof activeChannelObj.hilo != 'undefined') {
        values.push({path: path + '.hilo', value: activeChannelObj.hilo})
      }
      if (typeof activeChannelObj.name != 'undefined') {
        values.push({path: path + '.name', value: activeChannelObj.name})
      }
      if (typeof activeChannelObj.fav != 'undefined') {
        values.push({path: path + '.fav', value: activeChannelObj.fav})
      }
      app.handleMessage(plugin.id, {
        updates: [
          {
            values: values
          }
        ]
      })
    }

    function sendChannelTable () {
      app.debug('sendChannelTable')
      var values = []
      var path = 'communication.vhf'
      if (typeof activeChannelObj.mode != 'undefined') {
        values.push({path: path + '.channelTable', value: JSON.stringify(channelTable)})
      }
      app.handleMessage(plugin.id, {
        updates: [
          {
            values: values
          }
        ]
      })
    }

    plugin.registerWithRouter = function(router) {
      // Will appear here; plugins/signalk-icom-m510e-plugin/
      app.debug("registerWithRouter")
      router.get("/:action/:nr", (req, res) => {
        res.contentType("application/json")
        if (ready) {
          var action = req.params.action;
          var nr = req.params.nr;
          app.debug('api: action: ' + action + ' nr: ' + nr)
          if (action == 'channel') {
            if (nr == '+1') {
              app.debug('Changing +1')
              res.send(changeChannelUpDown(activeChannelObj, +1))
            } else if (nr == '-1') {
              app.debug('Changing -1')
              res.send(changeChannelUpDown(activeChannelObj, -1))
            } else {
              app.debug('Changing to ' + nr)
              let r = modeArray.indexOf(nr.substr(0,2))
              let n = parseInt(nr.substr(2,2), 10) * 3 + r
              res.send(changeChannelTo(n))
            }
          }
        } else {
          res.send('Not ready')
        }
      })
    }

		//setTimeout(() => app.debug(channelTable), 10000)
		//setTimeout(() => scanUp(), 15000)
		
	};

  plugin.stop = function () {
    // Here we put logic we need when the plugin stops
    app.debug('Plugin stopped');
    plugin.stop = function () {
      unsubscribes.forEach(f => f());
      unsubscribes = [];
      timers.forEach(timer => {
        clearInterval(timer)
      }) 
    };

  };

  return plugin;
};

function intToHex(integer) {
	var hex = padd((integer & 0xff).toString(16), 2)
  return hex
}
