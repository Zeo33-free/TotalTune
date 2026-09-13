TotalTune Manual
================

Playback
  Space: play/stop (plays from the edit cursor, not synced to the host)
  Click/drag the ruler: move the edit cursor (triangle marker — sets the
    playback start and paste position)
  The vertical line during playback is the playhead; it returns to the
    cursor when stopped
  Shift+drag on the ruler: box a loop region; right-click to clear it
  BPM follows the host

Editing notes
  Double-click empty space: create
  Right-click: delete
  Drag: move (moves the whole selection)
  Drag right edge: change duration
  Shift+drag: translate the whole group (duration unchanged)
  Ctrl+drag: duplicate the group and drag the copy
  Hold Alt while dragging: time freezes in place, only pitch changes
    (snaps to the note or tuning degree under the mouse; the group keeps
    its intervals)
  Alt+Shift together: conflict — no snapping
  Drag on empty space: box-select; Ctrl+box: add to selection
  Ctrl+C / Ctrl+V: copy / paste at the cursor
  Ctrl+A: select all
  Ctrl+Z / Ctrl+Y: undo / redo (works even with CapsLock on)

Shortcuts
  W: tuning snap on/off (pitch snaps to tuning degrees while dragging,
    time keeps flowing)
  Q: lock the tuning panel on the right (same as the lock button)
  Space: play/stop

Mouse wheel
  Wheel: scroll up/down
  Shift+wheel: scroll left/right
  Alt+wheel: zoom horizontally
  Ctrl+wheel: zoom vertically

Scenes / files
  `+` in the sidebar: new Scene (fill in harmony first) / add melody
  Double-click a name: rename
  S / M: Solo / Mute
  Drag a file item out: get an MPE MIDI file (chordN / mdN)

Tuning
  Pick 12-TET / JI / custom in the top bar
  Interval buttons in the bottom-right: click = transpose the selection,
    Ctrl+click = build new notes
  Double-click the tuning panel: edit the degree table (one ratio per
    line, e.g. 9/8)

Save / load
  Save: pick a location to store a .ttp; it is also stored in the plugin
    state (travels with the host project)
  Load: pick a .ttp
  The editor restores automatically when reopened

Mini synth
  Icon in the top-right: volume / waveform, for auditioning; MIDI is
  still sent to the host
