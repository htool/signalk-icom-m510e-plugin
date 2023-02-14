const Speaker = require('speaker');
const regex_fav =        /49636f6d010000009........................90000000[012]000000....0.00[0246]./g
const regex_name =       /49636f6d010000009101a8c01901a8c000060000e40000000000000/g
const regex_properties = /49636f6d010000009[12]01a8c01901a8c000050000d00000000/g
const regex_update =    /49636f6d010000009[12]01a8c01901a8c00102000010000000....bd003000bd000205..00..000000/g
const is_rtp = require('is-rtp')
const RTPParser = require('@penggy/easy-rtp-parser');



// Create the Speaker instance
const speaker = new Speaker({
  channels: 1,          // 2 channels
  bitDepth: 16,         // 16-bit samples
  sampleRate: 8000     // 8000 Hz sample rate
});


var udp = require('dgram');
var serverA = udp.createSocket('udp4');
var serverB = udp.createSocket('udp4');
var serverC = udp.createSocket('udp4');
var serverD = udp.createSocket('udp4');
var serverVoice = udp.createSocket('udp4');
var modeArray = ['00', '10', '20']
var radio = {}

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
var busy = false
var propertiesHex
var activeChannelObj = {}
var header

function getObject (buffer) {
  Packet.allocate()
  var packet = Packet.buffer()
  for (var i = 0; i < 40 ; i++) {
  // for (var i = 0; i < buffer.length ; i++) {
	  packet[i] = buffer[i]
  }
  var proxy = Packet.fields
  var Obj = {'name': proxy.name, 'a': proxy.a, 'b': proxy.b, 'c': proxy.c, 'd': proxy.d, 'e': proxy.e, 'f': proxy.f, 'g': proxy.g, 'h': proxy.h, 'version': proxy.version }
  return Obj
}

serverA.on('message',function(msg,info){
  if (!findRadioTimer._destroyed) {
    clearInterval(findRadioTimer)
    radio.ip = info.address
    radio.port = info.port
    console.log('Received packet')
    console.log(msg.toString('hex') + " " + msg.toString('utf-8'))
    header = msg.slice(0,17).toString('hex')
    console.log('Header: ' + header)
    console.log('Radio found on ' + radio.ip)
    sendSignIn(radio.ip, radio.port, listenPortB, listenPortC, listenPortD, listenPortVoice)
  } else {
    console.log('ServerA: ' + msg.toString())
    // console.log(msg.slice(0,48).toString('hex') + ' [' + msg.length + ']');
    // console.log('Received %d bytes from %s:%d\n',msg.length, info.address, info.port);
    console.log(msg.toString('hex'))
  }
});

serverB.on('message',function(msg,info) {
  console.log('ServerB (' + info.address + ':' + info.port + '): ' + msg.toString('hex') + " " + msg.toString('utf-8'))
  if (!keepAliveTimer) {
    console.log('Starting keepalive')
    keepAliveTimer = setInterval(() => keepAlive(info.address, info.port), 5000)
  }
  // console.log('channelTable.requested: ' + channelTable.requested)
  if (channelTable.requested == false) {
    requestChannels(radio.ip, radio.port, 1)
    setTimeout(() => askChannel(), 4000)
    setTimeout(() => requestChannels(radio.ip, radio.port, 2), 5000)
  }
});

serverC.on('message',function(msg,info) {
  const hex = Array.from(msg)
  let msgString = msg.toString('hex')
  if (msg.length == 28) {
    console.log('ServerC ACK (' + info.address + ':' + info.port + '): [' + msg.length + '] ' + msg.toString('hex'))
  } else if (msgString.match(regex_update)) {
    readChannelUpdate(msg)
  } else {
    let s = parseInt(hex[35].toString(16),16)
    switch (s) {
      case 128:
        busy = true
        break
      case 0:
        busy = false
        break
    }
    console.log('ServerC channel info (' + info.address + ':' + info.port + '): [' + msg.length + '] ' + msg.toString('hex'))
    activeChannelObj = getChannel(hex)
    console.log("activeChannelObj:  " + JSON.stringify(activeChannelObj))
  } 
});

function readChannelUpdate (msg) {
  const hex = Array.from(msg)
  console.log(hex.join(' '))
  console.log('readChannelUpdate')
  radio.squelch = hex[34]
  switch (hex[35]) {
    case 7:
      activeChannelObj.watt = 1
      break
    case 15:
      activeChannelObj.watt = 25
      break
  }
  if (typeof activeChannelObj.nr != 'undefined') {
    channelTable[activeChannelObj.nr][activeChannelObj.mode].watt = activeChannelObj.watt
    console.log(hex.join(' '))
    console.log(radio)
    console.log(activeChannelObj)
  }
}

serverVoice.on('message',function(msg,info) {
  const hex = Array.from(msg)
  console.log('serverVoice (' + info.address + ':' + info.port + '): ' + msg.toString('hex'))
  msg.pipe(speaker)
});

function updateChannelFav (hex) {
  let f = Math.floor(parseInt(hex[32].toString(16),16)/16)
  let channel = getChannelInfoHex(hex[29], hex[28])
  var fav
  switch (f) {
    case 0:
      fav = true
      break
    case 2:
      fav = true
      break
    case 4:
      fav = false
      break
    case 6:
      fav = false
      break
  }
  if (typeof channelTable[channel.nr] != 'undefined') {
    if (typeof channelTable[channel.nr][channel.mode] != 'undefined') {
      channelTable[channel.nr][channel.mode].fav = fav
      channel.fav = fav
    }
  }
  return channel
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
    info.enabled = channelTable[nr][mode].enabled
  }
  return info
}

function getChannelInfoHex (hex1, hex2) {
  let n = (parseInt(hex1.toString(16),16) * 256) + parseInt(hex2.toString(16),16)
  return getChannelInfoN(n)
}

function getChannel (hex) {
  console.log('getChannel: ' + hex.join(' '))
  let channel = getChannelInfoHex(hex[27], hex[26])
  radio.squelch = hex[34]
  console.log(radio)
  // console.log('getChannel channel: ' + JSON.stringify(channel))
  let w = hex[36]
  // console.log('w: ' + w)
  switch (w) {
    case 3:
      channel.watt = 1
      break
    case 7:
      channel.watt = 1
      break
    case 11:
      channel.watt = 1
      break
    case 15:
      channel.watt = 25
      break
  }
  if (typeof channelTable[channel.nr] != 'undefined') {
    if (typeof channelTable[channel.nr][channel.mode] != 'undefined') {
      channelTable[channel.nr][channel.mode].watt = channel.watt
      channel.name = channelTable[channel.nr][channel.mode].name
      channel.fav = channelTable[channel.nr][channel.mode].fav
      channel.enabled = channelTable[channel.nr][channel.mode].enabled
    }
  }
  return channel
}

serverD.on('message',function(msg,info) {
  const hex = Array.from(msg)
  let msgString = msg.toString('hex')
  // console.log('ServerD:\n' + msg.toString('hex') + "\n" + msg.toString('utf-8'))
  if (msgString.match(regex_name)) {
    // console.log('ServerD Channel name:\n' + msg.toString('hex') + "\n" + msg.toString('utf-8'))
    let chunk = msg.slice(28)
    let startValue = parseInt(chunk.slice(1,2).toString('hex')+chunk.slice(0,1).toString('hex'), 16)
    chunk = chunk.slice(3)
    // console.log('StartValue: ' + startValue + ' nr: ' + channelTableNr)
    while (chunk.length > 10) {
      let name = chunk.slice(1, 11).toString('utf-8')
      addNameToChannelTable(name.trim())
      chunk = chunk.slice(11)
    }
    if (startValue == 520) {
      ready = true
      console.log(channelTable)
    }
  } else if (msgString.startsWith('8000')) {
    if (is_rtp(msg)) {
      var rtp = RTPParser.parseRtpPacket(msg);
      // console.log(rtp);
      var bKeyframe = RTPParser.isKeyframeStart(rtp.payload);
      // console.log(`key frame : ${bKeyframe}`);
      speaker.write(Buffer.from(rtp.payload))
    }
    // console.log('Voice (' + info.address + ':' + info.port + '): ' + msgString)
    //console.log('Voice (' + info.address + ':' + info.port + '): ' + wav.toString('hex'))
  } else if (msgString.match(regex_properties)) {
      // console.log('ServerD (' + info.address + ':' + info.port + '): ' + msgString)
      propertiesMsg(msg)
  } else if (msgString.match(regex_fav)) {
      console.log(updateChannelFav(msg))
  } else {
    // console.log('ServerD (' + info.address + ':' + info.port + '): ' + msgString)
    console.log('ServerD:\n' + msg.toString('hex') + "\n" + msg.toString('utf-8'))
  }
});

function propertiesMsg (msg) {
  var hex = Array.from(msg)
  msg = msg.slice(32)
  var propertiesType = hex[24]
  console.log("propertiesType: " + propertiesType)
  if (hex[28] == 0) {
    console.log('propertiesMsg: First message')
    propertiesHex = Array.from(msg)
    console.log('propertiesMsg: ' + msg.toString('hex'))
  } else if (hex[28] == 200) {
    console.log('propertiesMsg: Second message')
    propertiesHex = propertiesHex.concat(Array.from(msg))
    console.log('propertiesMsg: ' + msg.toString('hex'))
    console.log('propertiesMsg: ' + JSON.stringify(propertiesHex))
    var nr = 0
    var modePos = 0
    while (propertiesHex.length > 1) {
      let v = propertiesHex.shift()
      let b = hex2bin(v)
      let vInt = parseInt(v.toString(16), 16)
      var f
      var duplex = b[6]
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
        // console.log('Nr: ' + nr)
      }
    }
  }
}

function propertiesSet(nr, mode, properties) {

  // Favourite set
  if (properties[21] == 0) {
    channelTable[nr][mode]['fav'] = true
  } else {
    channelTable[nr][mode]['fav'] = false
  }

  // Channel enabled
  if (properties[0] == 0) {
    channelTable[nr][mode]['enabled'] = true
  } else {
    channelTable[nr][mode]['enabled'] = false
  }

  // 1 Watt
  if (properties[19] == 0) {
    channelTable[nr][mode]['watt'] = 25
  } else {
    channelTable[nr][mode]['watt'] = 1
  }

  // Duplex
  if (mode == '00') {
    if (properties[6] == 0) {
      channelTable[nr]['duplex'] = true
    } else {
      channelTable[nr]['duplex'] = false
    } 
  }
  console.log("nr: " + nr + " mode: " + mode + " properies: " + properties)
  console.log(channelTable[nr][mode])
}


function hex2bin(hex){
    return ("00000000" + (parseInt(hex, 16)).toString(2)).substr(-8);
}

function addNameToChannelTable (name) {
  // console.log('Adding ' + name + ' to ' + channelTableNr + ' ' + channelMode)
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

//================ if an error occurs
serverA.on('error',function(error){
  console.log('Error: ' + error);
  server.close();
});
serverB.on('error',function(error){
  console.log('Error: ' + error);
  server.close();
});
serverC.on('error',function(error){
  console.log('Error: ' + error);
  server.close();
});
serverD.on('error',function(error){
  console.log('Error: ' + error);
  server.close();
});

serverA.bind(function() {
  serverA.setBroadcast(true);
  const address = serverA.address()
  console.log("Client using portA " + address.port)
  listenPortA = address.port
  findRadioTimer = setInterval(broadcastNew, 1000);
})

serverB.bind(function() {
  const address = serverB.address()
  console.log("Client using portB " + address.port)
  listenPortB = address.port
})

serverC.bind(function() {
  const address = serverC.address()
  console.log("Client using portC " + address.port)
  listenPortC = address.port
})

serverD.bind(function() {
  const address = serverD.address()
  console.log("Client using portD " + address.port)
  listenPortD = address.port
})

serverVoice.bind(function() {
  const address = serverD.address()
  console.log("Client using voice port " + address.port)
  listenPortVoice = address.port
})

function broadcastNew() {
  var hex = listenPortA.toString(16)
  hex = hex[2]+hex[3]+hex[0]+hex[1]
  var broadcastMsg = Buffer.from("49636f6d01ff0000b901a8c0ffffffff0000000004000000" + hex + "0000", "hex")
  serverA.send(broadcastMsg, 0, broadcastMsg.length, 50000, '255.255.255.255', function() {
    console.log("Broadbast sent '" + broadcastMsg + "'");
    console.log(broadcastMsg)
  })
}

function keepAlive (ip, port) {
  var keepAliveMsg = Buffer.from("8001004", "hex")
  serverB.send(keepAliveMsg, 0, keepAliveMsg.length, port, ip, function() {
    // console.log("Sent keepalive")
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
    console.log("Sent channel request to " + ip + ":" + port + "  " + msg.toString('hex') + " " +  msg.toString('utf-8'))
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
    console.log("Sending SignIn to use portB:" + portB + " portC:" + portC)
    console.log(signIn.toString('utf-8'))
  })
}

function changeChannelTo (n) {
  //49 63 6f 6d 01 02 00 00 ca 01 a8 c0 99 01 a8 c0 01 00 00 00 08 00 00 00 03 00 00 00 01 00 1e 00
  //49 63 6f 6d 01 02 00 00 ca 01 a8 c0 99 01 a8 c0 01 00 00 00 08 00 00 00 02 00 00 00 01 00 21 00
  let chHex = ('0000'+(n).toString(16)).substr(-4)
  chHex = chHex[2] + chHex[3] + chHex[0] + chHex[1]
  msg = Buffer.from("49636f6d01020000ca01a8c09901a8c00100000008000000030000000100" + chHex, "hex")
  serverC.send(msg, 0, msg.length, 50003, radio.ip, function () {
    // console.log('Change channel: n: ' + n + ' hex: ' + chHex + '  ' + msg.toString('hex'))
    activeChannelObj = getChannelInfoN(n)
  })
}

function changeChannelUp (channelObj) {
  console.log("changeChannelUp")
  console.log(channelObj)
  if (Number(channelObj.nr) >= 88) {
    channelObj = getChannelInfoN(2)
    console.log(channelObj)
  }
  var n = (channelObj.nr * 3) + modeArray.indexOf(channelObj.mode)
  var nr, r, enabled, fav, match
  var lookupWorks = true
  console.log('n: ' + n)
  console.log(channelObj)
  do {
    n++
    r = n % 3
    nr = Math.floor(n / 3)
    try {
      enabled = channelTable[nr][modeArray[r]].enabled
      fav = channelTable[nr][modeArray[r]].fav
      lookupWorks = true
    } catch {
      enabled = false
      lookupWorks = false
    }
    // console.log('Finding next channel: nr: ' + nr + ' mode: ' + modeArray[r] + ' enabled: ' + enabled + ' fav: ' + fav)
    if (lookupWorks == true && fav == true && enabled == true ) {
      match = true
    } else {
      match = false
    }
    if (n >= 400) { n = 2 }
  } while (match == false)
  if (lookupWorks) {
    // console.log('Next channel: ' + nr + ' ' + modeArray[r])
    changeChannelTo(n)
  } else {
    console.log("Can't lookup yet")
  }
}

function askChannel () {
  var msg = Buffer.from("49636f6d01020000ca01a8c09901a8c00103000000000000", "hex")
  serverC.send(msg, 0, msg.length, 50003, radio.ip, function () {
    console.log("Sending askChannel")
  })
  var msg = Buffer.from("49636f6d01020000ca01a8c09901a8c00102000000000000", "hex")
  serverC.send(msg, 0, msg.length, 50003, radio.ip, function () {
    console.log("Sending askChannel")
  })
}

function scanUp () {
  // console.log('activeChannelObj: ' + JSON.stringify(activeChannelObj))
  if (!busy) {
    changeChannelUp(activeChannelObj)
    setTimeout(() => scanUp(), 200)
  }
}

function squelch (level) {
  // 49636f6d010000009101a8c01901a8c001020000100000000203bd003000bd000205050007000000
  // 49636f6d010000009101a8c01901a8c001020000100000000203bd003000bd000205010007000000
  let levelHex = ("00" + level.toString(16)).substr(-2);
  var msg = Buffer.from("49636f6d010000009102a8c01901a8c001020000100000000203bd003000bd000205" + levelHex + "0007000000", "hex")
  serverC.send(msg, 0, msg.length, 50003, radio.ip, function () {
    console.log("Sending squelch msg " + msg.toString('hex'))
  })
}

setTimeout(() => console.log(channelTable), 10000)
setTimeout(() => scanUp(), 15000)
