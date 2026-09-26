const test = require('node:test')
const assert = require('node:assert/strict')
const { createAudioBuffer, RATE } = require('../audio-buffer')

test('one minute of audio puts the halfway point at 30 seconds', () => {
  const audio = createAudioBuffer()
  const second = Buffer.alloc(RATE * 2, 1)
  for (let i = 0; i < 60; i++) audio.append(second)
  const info = audio.info(audio.sampleAt(30))
  assert.equal(Math.round(info.duration), 60)
  assert.equal(Math.round(info.at), 30)
  const halfway = audio.sampleAt(info.duration / 2)
  assert.equal(Math.round(audio.info(halfway).at), 30)
})

test('a seek before the buffer starts at the oldest sample', () => {
  const audio = createAudioBuffer()
  audio.append(Buffer.alloc(RATE * 2))
  const read = audio.read(0, 4)
  assert.equal(read.sample, 0)
  assert.equal(read.pcm.length, 8)
})
