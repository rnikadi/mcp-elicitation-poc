#!/usr/bin/env python3
"""Records docs/demo.cast (asciinema v2) of the terminal client.

Starts nothing itself: run the server first (npm run dev:server, or
docker compose up), then: python3 scripts/record-demo.py
The script types into the client like a person would, and plays the
browser by POSTing to the payment page when the link appears.
"""
import json, os, pty, re, select, sys, threading, time, urllib.request

MCP_URL = os.environ.get('MCP_URL', 'http://localhost:3000/mcp')
OUT = os.environ.get('CAST', 'docs/demo.cast')
COLS, ROWS = 100, 34
DOWN, ENTER = '\x1b[B', '\r'

pid, fd = pty.fork()
if pid == 0:
    os.environ.update(MCP_URL=MCP_URL, FORCE_COLOR='1', COLUMNS=str(COLS), LINES=str(ROWS))
    os.execvp('npx', ['npx', 'tsx', 'src/client/main.ts'])

import fcntl, struct, termios
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', ROWS, COLS, 0, 0))

start = time.time()
events, screen = [], ''

def pump(seconds):
    global screen
    end = time.time() + seconds
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.05)
        if r:
            try:
                data = os.read(fd, 65536).decode(errors='replace')
            except OSError:
                return
            events.append([round(time.time() - start, 3), 'o', data])
            screen += data
            maybe_pay()

def wait_for(pattern, timeout=20):
    end = time.time() + timeout
    while time.time() < end:
        if re.search(pattern, re.sub(r'\x1b\[[0-9;?]*[A-Za-z]', '', screen)):
            return
        pump(0.1)
    sys.exit(f'timed out waiting for {pattern!r}')

def type_(text, pause=0.6, per_key=0.06):
    for ch in text:
        os.write(fd, ch.encode())
        pump(per_key)
    pump(pause)

paid = set()
def maybe_pay():
    # When the client prints the payment link, "pay" in the browser a few seconds later.
    for url in re.findall(r'http://[^\s\x1b]+/pay/[0-9a-f-]{36}', screen):
        if url in paid:
            continue
        paid.add(url)
        def pay(u=url):
            time.sleep(4)
            urllib.request.urlopen(urllib.request.Request(u + '/confirm', method='POST', data=b''))
        threading.Thread(target=pay, daemon=True).start()

wait_for('What next')
pump(1.5)
type_(DOWN + DOWN + ENTER, 1)              # show protocol messages
wait_for('What next'); pump(1)
type_(ENTER)                               # plan a trip
type_('\x15' + 'Lisbon' + ENTER, 1.5)     # clear default, type destination
wait_for('How do you want to respond'); pump(2)
type_(ENTER)                               # fill in the form
type_('2026-12-01' + ENTER)
type_(ENTER); type_(ENTER)                 # nights, travelers defaults
type_(DOWN + ENTER)                        # premium economy
type_(' ' + DOWN + ' ' + ENTER)            # breakfast + airport transfer
type_('ada@example.com' + ENTER, 2.5)
wait_for('Send this to'); pump(1)
type_(ENTER, 3)                            # send
wait_for(r'Total: €'); pump(3)
type_(DOWN + ENTER, 1)                     # check out
wait_for('Open this link'); pump(3)
type_(ENTER)                               # open it
wait_for('Booked!', 30); pump(3)
type_(DOWN + DOWN + DOWN + ENTER, 1)       # quit
pump(1)

header = {'version': 2, 'width': COLS, 'height': ROWS, 'timestamp': int(start),
          'title': 'MCP elicitation demo', 'env': {'TERM': 'xterm-256color', 'SHELL': '/bin/sh'}}
with open(OUT, 'w') as f:
    f.write(json.dumps(header) + '\n')
    for e in events:
        f.write(json.dumps(e, ensure_ascii=False) + '\n')
print(f'wrote {OUT} ({events[-1][0]:.0f}s, {len(events)} frames)')
