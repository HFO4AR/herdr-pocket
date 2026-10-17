"""A Claude Code / Codex input box for the fakes, reacting the way the real ones did when checked live
(Claude Code 2.1.268, Codex 0.163, through Herdr 0.8.2 pane input and tmux 3.7 send-keys):

  · a bracketed paste is inserted at the cursor; `hold` makes Claude show "Pasting…" for that many
    screen reads first (it reads the clipboard when a paste names a picture that is no local file),
    and an Enter pressed meanwhile is dropped; `hold=None` never lands;
  · ctrl+e end of line, ctrl+u delete to the line start, ctrl+k delete to the line end (on an empty
    line or at its end: the line break after it), backspace (at a line start: the break before it);
  · Enter submits (the box empties) unless `drop` says to ignore that many Enters; `frozen` ignores
    the editing keys (as a vim normal mode would);
  · screens carry colours like the real ones: Claude's box between two rules, a reverse-video cursor;
    Codex's "›" composer with its dim placeholder and footer."""

RULE = "\x1b[38;5;244m" + "─" * 40 + "\x1b[0m"


class BoxTui:
    def __init__(self, kind="claude", box="", row=None, col=None):
        self.kind = kind
        self.lines = box.split("\n")
        self.row = len(self.lines) - 1 if row is None else row
        self.col = len(self.lines[self.row]) if col is None else col
        self.submitted, self.pastes, self.keys, self.typed = [], [], [], []
        self.hold, self.pending, self.drop, self.frozen, self.reads = 0, None, 0, False, 0

    # ── screen ──
    def text(self): return "\n".join(self.lines)

    def ansi(self):
        self.reads += 1
        if self.pending is not None and self.hold is not None:
            self.hold -= 1
            if self.hold <= 0: self._insert(self.pending); self.pending = None
        pasting = self.pending is not None
        empty = not self.text()
        if self.kind == "codex":
            first = "›\x1b[0m " + ("\x1b[2mAsk Codex to do anything" if empty else self.lines[0])
            body = [first] + self.lines[1:]
            return "\n".join(["\x1b[1m⚠ weekly limit: 8% left · /status", ""] + body +
                             ["", "\x1b[0m  GPT-6 medium · /tmp/proj · Context 0% used", "  \x1b[1m?\x1b[0m for shortcuts"])
        first = "\x1b[39m❯ " + ("\x1b[7m \x1b[0m" if empty else self.lines[0] + "\x1b[0m")
        return "\n".join(["● 好了。", "", RULE, first] + ["  " + x for x in self.lines[1:]] +
                         [RULE, "  Pasting…" if pasting else "  \x1b[38;5;211m⏵⏵ accept edits on\x1b[0m"])

    def screen(self):
        import re
        return re.sub(r"\x1b\[[0-9;]*m", "", self.ansi())

    # ── input ──
    def _insert(self, text):
        parts = text.replace("\r", "\n").split("\n")
        line = self.lines[self.row]
        head, tail = line[:self.col], line[self.col:]
        new = [head + parts[0]] + parts[1:]
        self.col = len(new[-1])
        new[-1] += tail
        self.lines[self.row:self.row + 1] = new
        self.row += len(parts) - 1

    def paste(self, text):
        self.pastes.append(text)
        if self.pending is not None: self.pending += text
        elif self.hold is None or self.hold > 0: self.pending = text
        else: self._insert(text)

    def type(self, text): self.typed.append(text); self._insert(text)

    def key(self, name):
        self.keys.append(name)
        name = {"C-e": "ctrl+e", "C-u": "ctrl+u", "C-k": "ctrl+k", "BSpace": "backspace", "Enter": "enter"}.get(name, name)
        if name == "enter":
            if self.pending is not None or self.drop:
                self.drop = max(0, self.drop - (self.pending is None))
                return
            self.submitted.append(self.text()); self.lines, self.row, self.col = [""], 0, 0
            return
        if self.frozen: return
        line = self.lines[self.row]
        if name == "ctrl+e": self.col = len(line)
        elif name == "ctrl+u": self.lines[self.row] = line[self.col:]; self.col = 0
        elif name == "ctrl+k":
            if self.col < len(line): self.lines[self.row] = line[:self.col]
            elif self.row + 1 < len(self.lines): self.lines[self.row] = line + self.lines.pop(self.row + 1)
        elif name == "backspace":
            if self.col: self.lines[self.row] = line[:self.col - 1] + line[self.col:]; self.col -= 1
            elif self.row:
                self.row -= 1; self.col = len(self.lines[self.row])
                self.lines[self.row] += self.lines.pop(self.row + 1)
        else: raise AssertionError("key not expected in an input box: " + name)
