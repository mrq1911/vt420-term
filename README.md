# vt420-term

Run programs made for modern terminals, zellij first, on a DEC VT420.

![zellij on a white phosphor VT420](media/zellij.gif)

A program runs in a pseudo-terminal and believes it talks to xterm; [xterm.js](https://github.com/xtermjs/xterm.js)
emulates that terminal in memory, and the VT420 only ever receives what vt420-term draws from the emulated screen: DEC
character sets, the attributes a VT420 has, and controls it implements, at the pace its line allows. Nothing a program
prints reaches the terminal as it was written. (The GIF is rendered from the bytes vt420-term sent, played through the
test emulator.)

## Install

```bash
git clone https://github.com/mrq1911/vt420-term.git ~/.local/share/vt420-term
~/.local/share/vt420-term/install.sh
```

`install.sh` installs the dependencies without lifecycle scripts, builds node-pty's native module (a C++ compiler and
Python are needed), and links `vt420-term`, `zellij-vt420`, its key sheet `zellij-vt420-help` and `vt420-term-update`
into `~/.local/bin`. Node 22.18 or
later runs the TypeScript directly. `vt420-term-update` pulls and runs the same steps again.

## Use

```bash
vt420-term                        # your shell
vt420-term -- htop
vt420-term --baud 9600 -- vim     # pacing for a serial line whose speed stty cannot read
zellij-vt420                      # zellij with the VT420 profile
zellij-vt420 --baud 9600 -- attach main
```

The terminal options are pi-vt420's: `--columns 80|132`, `--lines 24|36|48`, `--status-line`, `--encoding`,
`--latin1`/`--dec-mcs`, `--8bit`, `--baud`, `--no-flow-control` and `--log`; `--term` sets the program's `TERM`
(xterm-256color), `--meta-key` the key that sends Alt (F14), and `--show-keys` puts what each key sent, and what the
program got for it, on the status line. See `vt420-term --help`. Programs find the terminal's name in `VT420_TERM`, so
ones made for the VT420, pi-vt420 among them, know what is at the end of the line.

## Screen saver

A CRT keeps a picture it shows for hours, and a program in a pane can run that long, so after ten minutes without a key
the terminal goes dark while the program runs on. `--screensaver progress`, the default on DEC terminals, shows the
program's title and whether its screen still changes (`zellij (main) · busy`, `· quiet 12m`) in another place every
half minute; `blank` shows nothing; `off` is the default on emulators. `--screensaver-minutes` sets the wait. Any key
wakes the screen and does not reach the program. With zellij-vt420 the options go before `--`:
`zellij-vt420 --screensaver blank -- attach main`.

## Keys

| LK401 | The program sees |
| --- | --- |
| F11, F12, F13 | Escape, BS and LF, as in VT100 mode; the LK401 has no Escape key |
| F14 | Alt with the next key, and F14 itself when pressed twice (`--meta-key` changes or disables it); the status line shows **Alt** while it waits |
| Help, F17-F20 | xterm's F15 and F17-F20, which it sends as Shift with F3 and F5-F8 |
| Do | F5, a code the LK401 never sends (its F5 is the local Break key) |
| PF1-PF4 | F1-F4, which xterm sends with the same codes |
| Find, Select | Home and End |
| Cursor keys, keypad | in the modes the program asked for (the keypad stays in application mode on the terminal) |
| Ctrl-S, Ctrl-Q, Hold Screen | XON/XOFF flow control, which stays on |

After Escape the next key waits 80 ms, so a program cannot read the two as Alt and that key.

## zellij

`zellij-vt420` starts zellij with `zellij/vt420.kdl`: zellij's default keymap without Ctrl s and Ctrl q, which are
XOFF and XON on a serial line, and Ctrl h, which is the BS that F12 sends. The LK401's keys work zellij with Alt, that
is F14 and then the key, and stay the programs' otherwise, so pi-vt420, htop and mc keep their function keys.

| F14, then | Action |
| --- | --- |
| PF1, PF2, PF3, PF4, Do | pane, tab, resize, scroll and session mode; in a mode the keys need no F14, and the mode's own key leaves it |
| F6, F7 | focus left and right, across tabs at the edges |
| F8 | new pane |
| F9 | show and hide floating panes |
| F10 | fullscreen the focused pane |
| Help | Help, to the program (Help alone shows these keys in a floating pane) |
| F17, F18 | previous and next tab |
| F19, F20 | new tab, pane frames on and off |
| a letter or an arrow | zellij's Alt bindings, such as Alt n or Alt and the arrows |

Do then q quits, and move mode is m in pane mode.

It also uses the compact layout (one bar), `simplified_ui` (no Powerline glyphs), and turns off the mouse, startup tips
and the kitty keyboard protocol. zellij gets a row more than the screen, and its bar, in that row, is shown on the
VT420's status line (`vt420-term --status-row`), so the panes have all 24 lines; F14 shows Alt over its start.
Set `ZELLIJ_VT420_CONFIG` to use a profile of your own.

## What reaches the terminal

- **Characters**: DEC Special Graphics, DEC Technical and DEC Supplemental (or ISO Latin-1), with the transliteration
  of pi-vt420: box drawing maps to line drawing, accents to the supplemental set, the rest to its nearest glyph. Every
  emulated cell is one VT420 cell, so pane borders stay put; a double-width character keeps its two columns with `?`,
  and Private Use Area glyphs (Powerline, Nerd Font) become spaces.
- **Colours**: a VT420 reads `38;5;n` or `38;2;r;g;b` one number at a time, so 5 would switch on blink and 7 reverse.
  vt420-term judges each colour by how it looks instead: a light or vivid background is reverse video, a vivid
  foreground is bold, greys and whites stay plain. With zellij's default theme the active tab is inverted, inactive
  tabs and the bars are plain, and the focused pane's frame is bold. Italic is underlined; dim is normal.
- **Controls**: cursor movement, erasing, SGR 0, 1, 4, 5, 7 and their resets, scrolling margins, character sets, the
  status line, rectangle fills; nothing else. OSC, DCS, APC and graphics from the program stop at the emulator, which
  also answers its queries (DA, cursor position, modes); the window title goes to the status line.
- **Proof**: the tests run hostile output (raw colour codes, emoji, CJK, OSC titles ended by BEL, DCS and APC strings,
  random binary) and real zellij sessions through the adapter into a strict VT420 emulator, and check every byte sent
  against that repertoire.

## How it draws

- **The latest screen, never the history**: frames are composed from the emulated screen, so a program that floods its
  output costs the line no more than the screen it ends up showing. Zellij's own output for its first five seconds is
  22 KB; the whole 17-second session in the GIF sent 2.7 KB to the terminal, under 1.5 s of a 19200 baud line.
- **Pacing**: a frame goes to a DEC terminal in pieces of 96 bytes at most, each ending with a DSR request, whose
  answer is four bytes (DA1 where the terminal ignores DSR), and a piece goes out only while at most one other is
  unanswered, fewer bytes than a VT420's input buffer holds, so even a full screen never runs ahead of the VT420,
  with smooth scroll set up or flow control that comes back over ssh too late to stop it, or none at all. Limited transmit, which holds the terminal's
  answers to 150 characters a second, is lifted for the session (DECXRLM) and put back on exit. When answers stop
  coming, lost on the line or held up by Set-Up, Hold Screen or flow control, only a DA1 probe goes out, less often
  each time, until one is answered, so a held terminal never gets a backlog to wade through. Frames wait for
  synchronized updates (mode 2026) to finish.
- **Panes scroll in hardware**: when a rectangle of the screen moved up or down, such as one pane scrolling next to
  others, the renderer scrolls it inside left and right margins (DECLRMM, DECSLRM) with IND or RI and writes only the
  new lines. The rectangle is the maximum-sum subrectangle of per-cell gains, and a measured trial decides whether
  scrolling it costs fewer bytes than rewriting it. A log scrolling next to a full pane costs 55 bytes a line instead of
  345.
- **The rest of pi-vt420's renderer**: relative cursor moves, ECH, DCH for text that moved left, DECFRA for long runs.

## Terminals

The probe of pi-vt420 decides what is used. A VT420 or VT5xx gets everything; xterm in VT420 mode too, with UTF-8
output. A VT320 lacks left and right margins and rectangle operations, so panes are redrawn instead of scrolled; a
VT220 also lacks DEC Technical and the status line. Modern emulators get UTF-8 output and whatever margins they have.

A VT420 is best set up as pi-vt420's README lists under Terminal setup: 38400 baud, Data Leads Only, XOFF at 128,
Jump Scroll, 6 pages of 24 lines, VT400 mode with 7-bit controls.

## Not included

Mouse input, images (sixel and kitty graphics are dropped), colour beyond the four attributes, and screens other than
80 or 132 columns by 24, 36 or 48 lines.

## Development

```bash
npm ci --ignore-scripts && npm rebuild node-pty
npm run check    # biome and tsc
npm test         # vitest; the zellij test runs when zellij is installed
```

`src/vt420` started as pi-vt420's terminal layer, character sets and renderer, in
[mrq1911/pi](https://github.com/mrq1911/pi/tree/vt420/packages/coding-agent/src/experimental/vt420); here the renderer
also scrolls rectangles, and the terminal layer hands over raw input. MIT licensed.
