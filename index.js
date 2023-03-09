const util = require('util')
const _ = require('lodash')
// const Speaker = require('speaker');
const regex_fav =        /49636f6d01000000.........................90000000[012]000000....0.00[0246]./gi
const regex_name =       /49636f6d01000000...............000060000e40000000.00000/gi
const regex_properties = /49636f6d01000000...............000050000d00000000/gi
const regex_update =     /49636f6d01000000...............0102000010000000....bd003000bd000205..00..000000/gi
//                                        ^-hex ip src dst - seem to be ignored
const is_rtp = require('is-rtp')
const RTPParser = require('@penggy/easy-rtp-parser');
const ip = require('ip');

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
      autoFollowPath: {
        type: 'string',
        title: 'Path to check for auto-follow mode',
        default: 'communication.vhf.autofollow'
      },
      followPath: {
        title: 'Follow the channel published on this path',
        default: 'resources.vhfdata.nearest.0',
        type: 'string'
      },
      silence: {
        title: 'Silence time in seconds before changing channel',
        default: 30,
        type: 'number'
      }
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
    var myIP = ip.address()
    var myIPHex = ip2hex(myIP)
    var radioIPhex = "unlikely"
    var radioPorthex = "unlikely"
    var broadcastIP = '255.255.255.255'
    var broadcastIPHex = ip2hex(broadcastIP)
    var icomHex = "49636f6d"
    var RS_M500Hex = "52532d4d353030"
    var CT_M500Hex = "43542d4d353030"
    var IC_M510Hex = "49432d4d353130"
    var portAhex = "unlikely"
    var portBhex = "unlikely"
    var portChex = "unlikely"
    var portDhex = "unlikely"
    var portEhex = "unlikely"
    var portVoicehex = "unlikely"
		var serverA = udp.createSocket('udp4');
		var serverB = udp.createSocket('udp4');
		var serverC = udp.createSocket('udp4');
		var serverD = udp.createSocket('udp4');
		var serverVoice = udp.createSocket('udp4');
		var serverE = udp.createSocket('udp4');
		var modeArray = ['00', '10', '20']
		var radio = {busy: false, status: "offline"}
		var findRadioTimer
    var sendSilenceTimer
		var keepAliveTimer = false
    var scanTimer
		var listenPortA 
		var listenPortB 
		var listenPortC 
		var listenPortD 
		var listenPortE 
		var listenPortVoice
		var channelTable = {'requested': false}
		var channelTableNr = 0
		var channelMode = '00'
		var propertiesHex
		var activeChannelObj = {}
		var header
    var horn = false
    var startSilence
    var onlineTimestamp = Date.now()
    var online = false
    let onStop = []
    var autoFollow = false

    app.debug ('options: %j', options)


    let localSubscription = {
      context: '*', // Get data for all contexts
      subscribe: [
        {
          path: options.followPath,
          period: 1000
        },
        {
          path: options.autoFollowPath
        }
      ]
    };

    app.subscriptionmanager.subscribe(
      localSubscription,
      unsubscribes,
      subscriptionError => {
        app.error('Error:' + subscriptionError);
      },
      delta => {
        delta.updates.forEach(u => {
          handleData(u.values)
        });
      }
    );

    function handleData (data) {
      path = data[0].path
      // app.debug(`handleData: ${path}`)
      if (path == options.autoFollowPath) {
        var af = String(data[0].value).toLowerCase()
        if (af == '1' || af == 'true' || af == 'on') {
          autoFollow = true
        } else {
          autoFollow = false
        }
        app.debug(`autoFollow set to: ${autoFollow}`)
      } else if (path == options.followPath && autoFollow == true) {
        var channelObj = JSON.parse(data[0].value)
        app.debug('channelObj: %j', channelObj)
        // app.debug(channelObj.channel)
        let channel = channelObj.channel.toString()
        if (channel != "") {
          if (((Date.now() - startSilence) / 1000) > options.silence) {
            if (channelString() != channel) {
              app.debug('VHFinfo channel change: ' + channel + " n: " + stringToN(channel))
              changeChannelTo(stringToN(channel))
            }
          }
        }
      }
    }


    function ip2hex (ip) {
      var hex = []
      ip.split('.').forEach(n => {
        hex.push(("00" + parseInt(n).toString(16).toLowerCase()).substr(-2,2))
      })
      return hex[3]+hex[2]+hex[1]+hex[0]
    }
	
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
        radioIPhex = ip2hex(radio.ip)
        app.debug('radioIPhex: ' + radioIPhex)
		    radio.port = info.port
        radioPorthex = port2hex(radio.port)
		    // app.debug('Received ServerA packet')
		    // app.debug(msg.toString('hex') + " " + msg.toString('utf-8'))
		    header = msg.slice(0,17)
		    debugPrint('Header ', header)
        radio.status = 'Initializing RS-M500'
        sendRadio(radio)
		    sendSignIn(radio.ip, radio.port, listenPortB, listenPortC, listenPortD, listenPortE, listenPortVoice)
		  } else {
		    debugPrint('ServerA', msg)
		    // app.debug(msg.slice(0,48).toString('hex') + ' [' + msg.length + ']');
		    // app.debug('Received %d bytes from %s:%d\n',msg.length, info.address, info.port);
		  }
		})
		
		serverB.on('message',function(msg,info) {
      onlineTimestamp = Date.now()
      if (!msg.toString('hex').startsWith('80c9000')) {
        debugPrint('ServerB', msg)
      }
		  if (!keepAliveTimer) {
		    app.debug('Starting keepalive')
		    keepAliveTimer = setInterval(() => keepAlive(info.address, info.port), 5000)
		  }
		  // app.debug('channelTable.requested: ' + channelTable.requested)
		  if (channelTable.requested == false) {
		    requestChannels(radio.ip, radio.port, 1)
		    setTimeout(() => askChannel(), 4000)
		    // setInterval(() => askChannel(), 4000)
		    // setInterval(() => requestChannels(radio.ip, radio.port, 1), 5000)
		  }
		})

		serverC.on('message',function(msg,info) {
      onlineTimestamp = Date.now()
		  const hex = Array.from(msg)
		  let msgString = msg.toString('hex')
		  if (msg.length == 28) {
		    app.debug('ServerC ACK (' + info.address + ':' + info.port + '): [' + msg.length + '] ' + msg.toString('hex'))
		  } else if (msgString.match(regex_update)) {
		    readChannelUpdate(msg)
		  } else if (msg.length == 32) {
        if (hex[26] == 80) {
          app.debug('HORN is on')
          horn = true
        } else if (hex[26] == 64) {
          app.debug('HORN is off')
          horn = false
        }
		  } else if (msg.length < 35) {
        debugPrint("serverC <35", msg)
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
              startSilence = Date.now()
              sendRadio()
            }
		        break
		    }
		    debugPrint('Server', msg)
        activeChannelObj = JSON.parse(JSON.stringify(getChannel(hex)))
		    app.debug("activeChannelObj:  " + JSON.stringify(activeChannelObj))
		  } 
      sendRadio()
      sendChannel()
		})

		serverE.on('message', function(msg,info) {
		  app.debug('ServerE ACK (' + info.address + ':' + info.port + '): [' + msg.length + '] ' + msg.toString('hex'))
		  app.debug('ServerE ACK', msg)
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
		    app.debug(activeChannelObj)
		  }
		}
		
		serverVoice.on('message',function(msg,info) {
		  const hex = Array.from(msg)
		  debugPrint('ServerVoice', msg)
		  // msg.pipe(speaker)
		})
		
		function updateChannelFav (hex) {
		  let f = parseInt(hex[32].toString(16),16)
		  let h = hex2bin(hex[32])
		  let channel = getChannelInfoHex(hex[29], hex[28])
		  var fav
      var a = parseInt(h[3],10)
      var b = parseInt(h[5],10)
      if (a ? !b : b) {   // xor
        fav = false
      } else {
        fav = true
      }
      app.debug('updateChannelFav: f: ' + f + "  h: " + h + ' h[5]: ' + h[5] + ' fav: ' + fav)
		  if (typeof channelTable[channel.nr] != 'undefined') {
		    if (typeof channelTable[channel.nr][channel.mode] != 'undefined') {
		      channelTable[channel.nr][channel.mode].fav = fav
		      activeChannelObj.fav = fav
		    }
		  }
		}
	  
    function stringToN (string) {
      if (string.length == 4) {
        let r = modeArray.indexOf(string.substr(-4,2))
        let n = parseInt(string.substr(-2,2), 10)
        return n*3 + r
      } else if (string.length <= 2) {
        let n = parseInt(string, 10)
        return n*3
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
		  // app.debug('getChannel: ' + hex.join(' '))
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
          radio.status = 'Initializing RS-M500'
          startSilence = Date.now()
          setTimeout(() => {
		        sendSilenceTimer = setInterval(() => sendSilence(), 1000)
          }, 8000)
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
          sendChannel()
		  } else if (msgString.startsWith('49636f6d01000000000000000000000000010000')) {
		    // app.debug('ServerD (' + info.address + ':' + info.port + '): ' + msgString)
		  } else {
        debugPrint('ServerD', msg)
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
		    // app.debug('propertiesMsg: ' + msg.toString('hex'))
		  } else if (hex[28] == 200) {
		    app.debug('propertiesMsg: Second message')
		    propertiesHex = propertiesHex.concat(Array.from(msg))
		    // app.debug('propertiesMsg: ' + msg.toString('hex'))
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
		  if (properties[offset+4] == properties[offset+6]) {
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
      if (channelTable[nr][mode].enabled) {
		    // app.debug("nr: " + nr + " mode: " + mode + " properies: " + properties+ ' ' + properties[offset+4] + properties[offset+6] + ' fav: ' + channelTable[nr][mode].fav)
      }
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
      portAhex = port2hex(portAhex)
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

		serverE.bind(function() {
		  const address = serverE.address()
		  app.debug("Client using portE " + address.port)
		  listenPortE = address.port
		})

		serverVoice.bind(function() {
		  const address = serverD.address()
		  app.debug("Client using voice port " + address.port)
		  listenPortVoice = address.port
		})

		function broadcastNew() {
		  var hex = listenPortA.toString(16)
		  hex = hex[2]+hex[3]+hex[0]+hex[1]
		  var broadcastMsg = Buffer.from(icomHex + "01ff0000" + myIPHex + broadcastIPHex + "0000000004000000" + hex + "0000", "hex")
		  serverA.send(broadcastMsg, 0, broadcastMsg.length, 50000, broadcastIP, function() {
		    debugPrint("Broadbast sent ", broadcastMsg);
		  })
		}

		function keepAlive (ip, port) {
		  var keepAliveMsg = Buffer.from("8001004", "hex")
		  serverB.send(keepAliveMsg, 0, keepAliveMsg.length, port, ip, function() {
		    // app.debug("Sent keepalive")
		  })
		}
		
		function requestChannels (ip, port, nr) {
		  // var msg1 = Buffer.from(icomHex + "01020000" + myIPHex + ip2hex(radio.ip) + "000400000400000000000000", "hex")
		  // var msg2 = Buffer.from(icomHex + "01020000" + myIPHex + ip2hex(radio.ip) + "00040000020000000100", "hex")
		  var msg1 = Buffer.from(icomHex + "01000000" + myIPHex + ip2hex(radio.ip) + "000400000400000000000000", "hex")
		  var msg2 = Buffer.from(icomHex + "01000000" + myIPHex + ip2hex(radio.ip) + "00040000020000000100", "hex")
		  if (nr == 1) {
		    msg = msg1
		    setTimeout(() => requestChannels(radio.ip, radio.port, 2), 2000)
		  } else if (nr == 2) {
		    msg = msg2
		  }
		  serverA.send(msg, 0, msg.length, port, ip, function() {
		    debugPrint("Sent channel request to " + ip + ":" + port, msg)
		  })
		  channelTable.requested = true
		}
		
    function port2hex (port) {
		  var porthex = port.toString(16).toLowerCase()
		  return porthex[2]+porthex[3]+porthex[0]+porthex[1]
    }

		function sendSignIn (ip, port, portB, portC, portD, portE, portVoice) {
		  portBhex = port2hex(portB)
		  portChex = port2hex(portC)
		  portDhex = port2hex(portD)
		  portEhex = port2hex(portE)
		  portVoicehex = port2hex(portVoice)
      var signIn
      signIn = Buffer.from(icomHex + "01ff0000" + myIPHex + ip2hex(radio.ip) + "00020000380000000200" + portDhex + portVoicehex + portBhex + portChex + portEhex + RS_M500Hex + "00000042134195000000000000000000000000000000000000000000000000000000000000", "hex")
      status = 'Initializing RS-M500'
		  serverA.send(signIn, 0, signIn.length, port, ip, function() {
		    debugPrint("Sending SignIn", signIn)
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
      		    msg = Buffer.from(icomHex + "01020000" + myIPHex + ip2hex(radio.ip) + "0100000008000000030000000100" + chHex, "hex")
      		    serverC.send(msg, 0, msg.length, 50003, radio.ip, function () {
      		      // app.debug('Change channel: n: ' + n + ' hex: ' + chHex + '  ' + msg.toString('hex'))
      		      activeChannelObj = JSON.parse(JSON.stringify(getChannelInfoN(n)))
      		    })
		          app.debug("changeChannelTo: activeChannelObj:  " + JSON.stringify(activeChannelObj))
              return true
            } else {
		          app.debug("changeChannelTo: not enabled")
              return false
            }
          } else {
		        app.debug("changeChannelTo: enabled not defined")
          }
        } else {
		      app.debug("changeChannelTo: mode not defined")
        }
      } else {
		    app.debug("changeChannelTo: tableChannel[nr] not defined")
      }
      startSilence = Date.now()
		}
		
		function changeChannelUpDown (channelObj, direction, favOnly) {
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
		    app.debug('Finding next channel: favOnly: ' + JSON.stringify(favOnly) + ' nr: ' + nr + ' mode: ' + modeArray[r] + ' enabled: ' + enabled + ' fav: ' + fav + ' lookupWorks: ' + lookupWorks)
		    if (favOnly == true && lookupWorks == true && fav == true && enabled == true ) {
		      match = true
		    } else if (favOnly == false && lookupWorks == true && enabled == true ) {
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
      // var msg = Buffer.from(icomHex + "01020000" + myIPHex + ip2hex(radio.ip) + "0103000000000000", "hex")
      var msg = Buffer.from(icomHex + "01000000" + myIPHex + ip2hex(radio.ip) + "0103000000000000", "hex")
		  serverC.send(msg, 0, msg.length, 50003, radio.ip, function () {
		    app.debug("Sending askChannel")
		  })
		}

		function scanUp (favOnly) {
		  // app.debug('activeChannelObj: ' + JSON.stringify(activeChannelObj))
		  if (!radio.busy && favOnly != -1) {
		    changeChannelUpDown(activeChannelObj, 1, favOnly)
		    scanTimer = setTimeout(() => scanUp(favOnly), 200)
		  }
		}

		function squelch (level) {
		  // icomHex + "010000009101a8c01901a8c001020000100000000203bd003000bd000205050007000000
		  // icomHex + "010000009101a8c01901a8c001020000100000000203bd003000bd000205010007000000
		  let levelHex = ("00" + level.toString(16)).substr(-2);
		  var msg = Buffer.from(icomHex + "01000000" + myIPHex + ip2hex(radio.ip) + "01020000100000000203bd003000bd000205" + levelHex + "0007000000", "hex")
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
      if (typeof radio.status != 'undefined') {
        values.push({path: path + '.status', value: radio.status})
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

    function sendSilence() {
      var silence = Math.floor(((Date.now() - startSilence)/1000))
      if (Date.now() - onlineTimestamp < 10000) {
        // app.debug('sendSilence: alive sign')
        // if (radio.status == 'Initializing CT-M500') {
        if (radio.status == 'Initializing RS-M500') {
          radio.status = 'online'
          silence = 0
          app.debug(activeChannelObj)
          activeChannelObj.name = channelTable[activeChannelObj.nr][activeChannelObj.mode].name
          sendChannel()
        }
      } else {
        // app.debug('sendSilence: no alive sign')
        if (radio.status == 'online') {
          silence = -1
          radio.status = 'offline'
          activeChannelObj = {}
          channelTable.requested = false
          findRadioTimer = setInterval(broadcastNew, 1000);
          clearInterval(sendSilenceTimer)
        }
      }
      // app.debug('sendSilence: ' + silence + ' radio.status: ' + radio.status)
      var values = []
      var path = 'communication.vhf'
      if (radio.status == "online") {
        values.push({path: path + '.silence', value: silence})
      } 
      if (typeof radio.squelch != 'undefined') {
        values.push({path: path + '.squelch', value: radio.squelch})
      }
      values.push({path: path + '.channel', value: channelString()})
      values.push({path: path + '.status', value: radio.status})
      app.handleMessage(plugin.id, {
        updates: [
          {
            values: values
          }
        ]
      })
    }

    function channelN() {
      if (typeof activeChannelObj.nr != 'undefined') {
        if (typeof activeChannelObj.mode != 'undefined') {
          return (parseInt(activeChannelObj.nr, 10) * 3 + modeArray.indexOf(activeChannel.mode))
        }
      }
    }

    function channelString() {
      if (typeof activeChannelObj.nr != 'undefined') {
        if (typeof activeChannelObj.mode != 'undefined') {
          if (activeChannelObj.mode == "00") {
            return activeChannelObj.nr.toString()
          } else {
            return activeChannelObj.mode + ("00" + activeChannelObj.nr.toString()).substr(-2)
          }
        }
      } else {
        return ""
      }
    }


    function debugPrint (name, msg) {
      let re_myIPHex = new RegExp(myIPHex, "g")
      let re_broadcastIPHex = new RegExp(broadcastIPHex, "g")
      let re_icomHex = new RegExp(icomHex, "g")
      let re_RS_M500Hex = new RegExp(RS_M500Hex, "g")
      let re_IC_M510Hex = new RegExp(IC_M510Hex, "g")
      let re_portBhex = new RegExp(portBhex, "g")
      let re_portChex = new RegExp(portChex, "g")
      let re_portDhex = new RegExp(portDhex, "g")
      let re_portVoicehex = new RegExp(portVoicehex, "g")
      let re_portEhex = new RegExp(portEhex, "g")
      let re_radioIPhex = new RegExp(radioIPhex, "g")
      let re_radioPorthex = new RegExp(radioPorthex, "g")

      hexString = msg.toString('hex').toLowerCase()
                  .replace(re_myIPHex, '- myIP -')
                  .replace(re_broadcastIPHex, '- BCST -')
                  .replace(re_icomHex, 'Icom')
                  .replace(re_RS_M500Hex, 'RS-M500')
                  .replace(re_IC_M510Hex, 'IC-M510')
                  .replace(re_portBhex, '-pB-')
                  .replace(re_portChex, '-pC-')
                  .replace(re_portDhex, '-pD-')
                  .replace(re_portVoicehex, '-pV-')
                  .replace(re_portEhex, '-pE-')
                  .replace(re_radioIPhex, '-radoIP-')
                  .replace(re_radioPorthex, '-rP-')
                  .replace(/ / , '__')
      app.debug(name + ': [' + msg.length + '] ' + hexString)
    }

    function sendChannel () {
      app.debug('sendChannel: ' + JSON.stringify(activeChannelObj))
      var values = []
      var path = 'communication.vhf'
      values.push({path: path + '.channel', value: channelString()})
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

    app.registerPutHandler('vessels.self', 'communication.vhf.channel', apiChangeChannel, 'somesource.1');

    function apiChangeChannel (context, path, value, callback) {
      var statusCode
      var r, n
      app.debug("context: " + context + " path: " + path + " value: " + value)
      if (radio.status == 'online') {
        if (value == 'scanStop') {
          app.debug('Scanning stop')
          clearTimeout(scanTimer)
          statusCode = 200
        } else if (value == 'scanAll') {
          app.debug('Scanning all channels')
          setTimeout(() => scanUp(0), 10)
          statusCode = 200
        } else if (value == 'scanFav') {
          app.debug('Scanning favourite channels')
          setTimeout(() => scanUp(1), 10)
          statusCode = 200
        } else if (value == '+1') {
          app.debug('Changing +1')
          changeChannelUpDown(activeChannelObj, +1, false)
          statusCode = 200
        } else if (value == '-1') {
          app.debug('Changing -1')
          changeChannelUpDown(activeChannelObj, -1, false)
          statusCode = 200
        } else {
          app.debug('Changing to ' + value)
          if (value.length == 4) {
            r = modeArray.indexOf(value.toString(10).substr(0,2))
            n = parseInt(value.toString(10).substr(2,2), 10) * 3 + r
          } else {
            r = 0
            n = parseInt(("00" + value.toString(10)).substr(2,2), 10) * 3 + r
          }
          changeChannelTo(n)
          statusCode = 200
        }
      } else {
        statusCode = 400
      }
      callback({state: 'COMPLETED', statusCode: statusCode})
    }

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
