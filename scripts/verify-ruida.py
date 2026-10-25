"""Offline interoperability check; never opens a controller connection.

Requires MeerK40t 0.9.9100. Pass its downloaded wheel as the optional first argument,
then run after scripts/ruida-fixture.ts has been built and executed.
"""
import json
import sys
from importlib.metadata import version

if len(sys.argv) > 1:
    sys.path.insert(0, sys.argv[1])
assert version('meerk40t') == '0.9.9100', 'Use the pinned qualification dependency'
from meerk40t.ruida.rdjob import RDJob, parse_commands, abscoord, parse_speed, parse_power

messages = []
reader = RDJob(magic=0x88, channel=messages.append)
with open('dist-workshop/interop/sample.rd', 'rb') as source:
    commands = list(parse_commands(reader.unswizzle(source.read())))
with open('dist-workshop/interop/expected.json') as source:
    expected = json.load(source)
actual = []
speed = minimum = maximum = 0
air = False
for command in commands:
    reader.process(list(command))
    if command[:2] == b'\xc9\x02':
        speed = parse_speed(command[2:])
    if command[:2] == b'\xc6\x01':
        minimum = parse_power(command[2:])
    if command[:2] == b'\xc6\x02':
        maximum = parse_power(command[2:])
    if command[:2] in (b'\xc6\x21', b'\xc6\x22'):
        assert parse_power(command[2:]) == 0, 'Second laser is enabled'
    if command[:3] == b'\xca\x01\x13':
        air = True
    if command[:3] == b'\xca\x01\x12':
        air = False
    if command[0] in (0x88, 0xa8):
        actual.append((abscoord(command[1:6]) / 1000, abscoord(command[6:11]) / 1000,
                       command[0] == 0xa8, speed, minimum, maximum, air))
assert not any('Unknown Command' in line or 'NOT A COMMAND' in line for line in messages), messages
assert len(actual) == len(expected)
for (x, y, burn, speed, minimum, maximum, air), movement in zip(actual, expected):
    settings = movement['settings']
    assert abs(x - movement['to']['x']) < 0.0011 and abs(y - movement['to']['y']) < 0.0011
    assert burn == movement['burn'] and air == settings['airAssist']
    assert abs(speed - settings['speedMmS']) < 0.0011
    # MeerK40t's reader divides power by 16384; this writer encodes against 16383.
    assert abs(minimum - settings['minPower']) < 0.007
    assert abs(maximum - settings['maxPower']) < 0.007
print(f'PASS: MeerK40t 0.9.9100 decoded {len(commands)} commands and {len(actual)} matching movements/settings.')
print('Offline interoperability only; controller compatibility is not established by this check.')
