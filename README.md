# signalk-icom-m510e-plugin
Get channel info and set listening channel

## SignalK info
Radio info is written to:
```
communication.vhf.ip        string      IP address of Icom M510E
                 .port      number      UDP source port
                 .busy      boolean     Is channel busy?
                 .squelch   number      Squelch setting (0-10)
                 .channel   string      Active channel
                 .fav       boolean     Is favourite?
                 .duplex    boolean     Is channel duplex?
                 .hilo      boolean     Allows changing High/Low?
                 .watt      number      1 or 25 Watt
                 .enabled   boolean     Is channel enabled
```

## Api

The following api calls can be made

```
/plugins/signalk-icom-m510e-plugin/channel/<n>
```
where `n` is `-1` for channel down, `+1` for channel up or a channel number in 4 characters, e.g. `2019` or `0001`.

## NMEA2000 / CT-M500

Normally the CT-M500 interface box should be used to create the NMEA2000 connectivity.
The Icom M510E without AIS seems to have all the AIS software onboard, just not the hardware bits (it seems).

If we can find out how to inject NMEA2000 (which is probably NMEA0183), most functionality of the CT-M500 can be done in software through a SignalK plugin.
So if you have access to a CT-M500, I'd like to get in contact.
