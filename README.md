# signalk-icom-m510e-plugin

Signal K plugin for an Icom M510E over the radio's WLAN, using the same UDP session as the RS-M500 handset. It publishes the radio state, accepts channel and control commands, and serves a web remote.

![RS-M500 style web remote](screenshot.png)

## Webapp

With the plugin installed, Signal K serves the remote at `/signalk-icom-m510e-plugin/`.

- Channel, name, 1W/25W, favourite, and the channel-group label (USA, INT, CAN, DSC, ATIS, or WX).
- Channel down and up. Both keep working while the channel is busy.
- Squelch from 0 to 10, with − and + beside the slider. The label and the value sit above the slider.
- Favourite and a marked-channel tick. Marked channels and favourite overrides are stored in the plugin data directory.
- Scan, Scan marked, and Scan favourites. A scan pauses on a busy channel and resumes after the configured silence time. The channel steps stay on the channel the radio reports, so a slow status does not skip ahead.
- Auto follow of the nearest VHF station.
- Push-to-talk, and an intercom tab for a call with the radio.
- Received audio on every open webapp, each with its own rewind buffer and 10-second jumps. The time label includes the channel number that was on the radio when that audio arrived.

## Webapp states

- **Disconnected.** The radio is offline. The buttons do not drive it.
- **Connected.** This webapp has the buttons and push-to-talk, and it hears the audio.
- **Following.** Another webapp has the buttons and push-to-talk. This one still hears the audio and can rewind its own buffer. Take over moves the buttons and push-to-talk here and releases the other webapp's push-to-talk. Scan and auto follow keep running; they belong to the radio.
- **Locked.** This phone's buttons are blocked so they are not pressed by accident. The screen stays awake either way. Other webapps are unchanged.

Opening a second webapp does not take the buttons. Take over does.
- Lock blocks the buttons so they are not pressed by accident. The screen stays awake after the first touch. Mute silences playback.
- Saving the plugin config keeps the existing UDP session with the radio.

There is no DSC remote.

## Signal K

Values are published under `communication.vhf`:

```
communication.vhf.ip            string    Radio IP, while a session exists
                 .port          number    Radio UDP port
                 .status        string    offline, Initializing RS-M500, or online
                 .squelch       number    0–10
                 .horn          boolean   Fog horn sounding
                 .scanning      boolean   Radio scan flag
                 .dualwatch     boolean   Dual watch
                 .intercom      boolean   Intercom call
                 .channelGroup  string    USA, INT, CAN, DSC, ATIS, WX, or empty
                 .silence       number    Seconds since the channel went quiet
                 .channel       object    Active channel, see below
                 .audio         string    IP of the client that has the audio, or empty
                 .marked        number[]  Channel numbers ticked in the webapp
                 .scanMode      string    all, marked, favourites, or empty
                 .autofollow    boolean   Auto follow is on
```

`communication.vhf.bank` is written as an empty string so an older value does not linger. Channel group lives on `channelGroup`.

`communication.vhf.channel` is one object:

```
{
  "nr": 16,
  "duplex": false,
  "hilo": true,
  "fav": true,
  "name": "CALLING",
  "watt": 25,
  "mode": "00",
  "enabled": true,
  "busy": false
}
```

`mode` is `00`, `10`, or `20` (the USA, INT, and CAN lists). `watt` is 1 or 25. `busy` is receiving on that channel.

## API

PUT `vessels.self` paths. Each call returns `{ "state": "COMPLETED", "statusCode": 200 }` or `400`.

Channel (`communication.vhf.channel`):

```
curl -H "Content-Type: application/json" -X PUT \
  http://localhost:3000/signalk/v1/api/vessels/self/communication/vhf/channel \
  -d '{"value": "+1"}'
```

`value` is `+1`, `-1`, `scanAll`, `scanFav`, `scanStop`, a channel number (list `00`), or four characters of list plus number, for example `0016`, `1016`, or `2016`.

| Path | Value |
| --- | --- |
| `communication.vhf.squelch` | 0–10 |
| `communication.vhf.watt` | any value toggles 1W / 25W |
| `communication.vhf.scanning` | any value toggles the radio scan |
| `communication.vhf.dualwatch` | any value toggles dual watch |
| `communication.vhf.ptt` | `true`, `1`, or `down` presses; anything else releases |
| `communication.vhf.intercom` | `true`, `talk`, or `begin` starts; anything else ends |
| `communication.vhf.autofollow` | `toggle`, or `1` / `true` / `on` |
| `communication.vhf.marked` | `toggle` for the active channel number |
| `communication.vhf.scanMode` | `all`, `marked`, `favourites`, or `off` |
| `communication.vhf.fav` | `toggle` |

Auto follow reads the nearest station from the path set in the plugin config (`resources.vhfdata.nearest.0` by default). That value is the JSON object published by the [VHFinfo plugin](https://github.com/htool/vhfinfo). Its `channel` field is used, and a list such as `12/16` tunes the first channel.

## Plugin config

| Setting | Default |
| --- | --- |
| Path to check for auto-follow mode | `communication.vhf.autofollow` |
| Signal K path of the nearest VHF station | `resources.vhfdata.nearest.0` |
| Auto follow: seconds of silence before changing channel | 30 |
| Scan: seconds of silence before resuming | 30 |
| Audio buffer length in minutes | 5 |
| Icom M510E IP | empty; discovery is broadcast |

The nearest-station path is a JSON object from the [VHFinfo plugin](https://github.com/htool/vhfinfo). When the IP is set, discovery is sent to that address instead of the broadcast.
