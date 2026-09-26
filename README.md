# signalk-icom-m510e-plugin
Get channel info and set listening channel

## SignalK info
Radio info is written to:
```
communication.vhf.ip        string      IP address of Icom M510E
                 .port      number      UDP source port
                 .status    string      offline, Initializing RS-M500, or online
                 .busy      boolean     Is channel busy?
                 .silence   number      Seconds since the channel went quiet
                 .squelch   number      Squelch setting (0-10)
                 .channel   string      Active channel
                 .name      string      Channel name from the radio
                 .fav       boolean     Is favourite?
                 .duplex    boolean     Is channel duplex?
                 .hilo      boolean     Allows changing High/Low?
                 .watt      number      1 or 25 Watt
                 .enabled   boolean     Is channel enabled
                 .horn      boolean     Fog horn sounding
```

## Webapp

With the plugin installed, Signal K serves the RS-M500 style remote at `/signalk-icom-m510e-plugin/`. It shows the channel, name, power and favourite flag, and can change channel, squelch, HI/LO, scan, dualwatch, push-to-talk and intercom. There is no DSC.

## Api

The following api calls can be made

```
curl -H "Content-Type: application/json" -X PUT http://localhost:3000/signalk/v1/api/vessels/self/communication/vhf/channel -d '{"value": "+1"}'
```
where `value` is `-1` for channel down, `+1` for channel up or a channel number in 4 characters, e.g. `2019` or `0001`.

Auto-follow reads the nearest station from the path set in the plugin config (`resources.vhfdata.nearest.0` by default). That value is the VHFinfo JSON object. Its `channel` field is used, and a list such as `12/16` tunes the first channel.

## NMEA 0183

After sign-in the radio sends NMEA 0183 datagrams. GPS sentences are in the usual set (`GNRMC`, `GNGSA`, `GPGSV`, `GLGSV`); AIS sentences are forwarded the same way when the set emits them. Each sentence is emitted on the server `nmea0183` event and parsed into a Signal K delta.

## NMEA2000 / CT-M500

Normally the CT-M500 interface box should be used to create the NMEA2000 connectivity.
The Icom M510E without AIS seems to have all the AIS software onboard, just not the hardware bits (it seems).

If we can find out how to inject NMEA2000 (which is probably NMEA0183), most functionality of the CT-M500 can be done in software through a SignalK plugin.
So if you have access to a CT-M500, I'd like to get in contact.
