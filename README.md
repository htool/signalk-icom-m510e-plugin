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


