// Kinetic Lyrics — synced, expressive lyric typography on the GNOME desktop.
// SPDX-License-Identifier: GPL-3.0-or-later

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {LyricsClient} from './lyricsClient.js';

const TICK_MS = 120;             // how often the active line is re-evaluated
const RESYNC_MS = 1000;          // how often the real playback position is re-read
const SEEK_BACK_MS = 1500;       // backward jumps smaller than this are treated as jitter

const MPRIS_PREFIX = 'org.mpris.MediaPlayer2.';
const MPRIS_PATH = '/org/mpris/MediaPlayer2';
const PLAYER_IFACE = 'org.mpris.MediaPlayer2.Player';

const ALIGN = {
    start: Clutter.ActorAlign.START,
    center: Clutter.ActorAlign.CENTER,
    end: Clutter.ActorAlign.END,
};

export default class KineticLyricsExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._readConfig();
        this._loadBundledFonts();

        this._client = new LyricsClient();
        this._players = new Map();   // bus name -> player state
        this._lyrics = null;         // {lines, isSynced} for the current track
        this._trackKey = null;
        this._activeIndex = -2;
        this._fetchToken = 0;
        this._nameWatchId = 0;
        this._content = null;
        this._revealIds = [];

        // Fixed-layout canvas; each lyric line is built as a "content" block inside it.
        this._box = new St.Widget({
            layout_manager: new Clutter.FixedLayout(),
            reactive: false,
            opacity: 0,
            visible: false,
        });

        // Sits in the background layer: above the wallpaper, below every window.
        this._bgGroup = Main.layoutManager._backgroundGroup;
        this._bgGroup.add_child(this._box);
        this._bgGroup.connectObject('child-added', (_g, actor) => {
            if (actor !== this._box)
                this._raiseSoon();
        }, this);
        Main.layoutManager.connectObject('monitors-changed', () => this._reposition(), this);
        Main.overview.connectObject(
            'showing', () => {
                if (this._cfg.hideInOverview)
                    this._box.hide();
            },
            'hidden', () => this._refreshVisibility(),
            this);
        this._settings.connectObject('changed', () => this._onSettingsChanged(), this);
        this._reposition();

        this._startMpris();
        this._tickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TICK_MS, () => {
            this._tick();
            return GLib.SOURCE_CONTINUE;
        });
    }

    disable() {
        if (this._tickId) {
            GLib.source_remove(this._tickId);
            this._tickId = 0;
        }
        if (this._raiseId) {
            GLib.source_remove(this._raiseId);
            this._raiseId = 0;
        }
        this._cancelReveals();
        this._stopMpris();
        this._bgGroup?.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        Main.overview.disconnectObject(this);
        this._settings?.disconnectObject(this);
        this._box?.destroy();
        this._box = null;
        this._content = null;
        this._client?.destroy();
        this._client = null;
        this._players = null;
        this._lyrics = null;
        this._settings = null;
        this._cfg = null;
    }

    // ---- settings & fonts -------------------------------------------------

    _readConfig() {
        const s = this._settings;
        this._cfg = {
            capsFont: s.get_string('caps-font'),
            scriptFont: s.get_string('script-font'),
            uppercase: s.get_boolean('uppercase'),
            scriptMaxLetters: s.get_int('script-max-letters'),
            color: s.get_string('paint-color'),
            shadow: s.get_boolean('text-shadow'),
            heroSize: s.get_int('hero-size'),
            bigSize: s.get_int('big-size'),
            midSize: s.get_int('mid-size'),
            scriptSize: s.get_int('script-size'),
            wordGap: s.get_int('word-gap'),
            position: s.get_string('position'),
            margin: s.get_int('horizontal-margin'),
            verticalOffset: s.get_int('vertical-offset'),
            widthPercent: s.get_int('column-width'),
            maxWidth: s.get_int('max-width'),
            rowAlign: s.get_string('row-align'),
            hideInOverview: s.get_boolean('hide-in-overview'),
            wordByWord: s.get_boolean('word-by-word'),
            wordInMs: s.get_int('word-animation-ms'),
            spread: s.get_int('word-spread') / 100,
            fadeMs: s.get_int('line-fade-ms'),
            wobble: s.get_boolean('wobble'),
            offsetMs: s.get_int('lyrics-offset-ms'),
        };
    }

    _onSettingsChanged() {
        this._readConfig();
        this._reposition();
        // rebuild the current line with the new look
        if (this._lyrics && this._activeIndex >= 0)
            this._render(this._activeIndex);
    }

    // Register the fonts shipped in ./fonts with the shell's own font map, so
    // they work without being installed system-wide.
    _loadBundledFonts() {
        let fontMap = null;
        try {
            // every actor's Pango context shares the shell's font map
            fontMap = global.stage.get_pango_context().get_font_map();
        } catch (e) {
            console.warn(`[Kinetic Lyrics] no shell font map: ${e.message}`);
        }
        if (!fontMap?.add_font_file)
            return;
        const dir = this.dir.get_child('fonts');
        let iter;
        try {
            iter = dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
        } catch {
            return;
        }
        let info;
        while ((info = iter.next_file(null))) {
            const name = info.get_name();
            if (!/\.(ttf|otf)$/i.test(name))
                continue;
            try {
                fontMap.add_font_file(dir.get_child(name).get_path());
            } catch (e) {
                console.warn(`[Kinetic Lyrics] could not load ${name}: ${e.message}`);
            }
        }
        iter.close(null);
    }

    // ---- layout ---------------------------------------------------------

    _columnWidth() {
        const m = Main.layoutManager.primaryMonitor;
        return Math.min(this._cfg.maxWidth, Math.round(m.width * this._cfg.widthPercent / 100));
    }

    _reposition() {
        const m = Main.layoutManager.primaryMonitor;
        if (!m || !this._box)
            return;
        const width = this._columnWidth();
        let x;
        if (this._cfg.position === 'left')
            x = m.x + this._cfg.margin;
        else if (this._cfg.position === 'center')
            x = m.x + Math.round((m.width - width) / 2);
        else
            x = m.x + m.width - width - this._cfg.margin;
        this._box.set_size(width, m.height);
        this._box.set_position(x, m.y);
        this._centerContent();
    }

    _centerContent() {
        const m = Main.layoutManager.primaryMonitor;
        if (!m || !this._box || !this._content)
            return;
        const [, h] = this._content.get_preferred_height(this._box.width);
        this._content.set_position(0, Math.round((m.height - h) / 2 + this._cfg.verticalOffset));
    }

    _raiseSoon() {
        if (this._raiseId)
            return;
        this._raiseId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._raiseId = 0;
            if (this._box && this._box.get_parent() === this._bgGroup)
                this._bgGroup.set_child_above_sibling(this._box, null);
            return GLib.SOURCE_REMOVE;
        });
    }

    _refreshVisibility() {
        if (!this._box)
            return;
        const show = !!this._lyrics && this._lyrics.isSynced && !!this._activePlayer() &&
            !(this._cfg.hideInOverview && Main.overview.visible);
        if (show) {
            this._box.show();
            this._box.ease({
                opacity: 255, duration: this._cfg.fadeMs, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        } else {
            this._box.ease({
                opacity: 0, duration: this._cfg.fadeMs, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => {
                    if (this._box && this._box.opacity === 0)
                        this._box.hide();
                },
            });
        }
    }

    // ---- MPRIS ----------------------------------------------------------

    _startMpris() {
        this._bus = Gio.DBus.session;
        this._nameWatchId = this._bus.signal_subscribe(
            'org.freedesktop.DBus', 'org.freedesktop.DBus', 'NameOwnerChanged',
            '/org/freedesktop/DBus', null, Gio.DBusSignalFlags.NONE,
            (_c, _s, _p, _i, _n, params) => {
                const [name, , newOwner] = params.deepUnpack();
                if (!name.startsWith(MPRIS_PREFIX))
                    return;
                if (newOwner)
                    this._addPlayer(name);
                else
                    this._removePlayer(name);
            });
        this._bus.call(
            'org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'ListNames',
            null, null, Gio.DBusCallFlags.NONE, -1, null,
            (conn, res) => {
                try {
                    const [names] = conn.call_finish(res).deepUnpack();
                    for (const n of names) {
                        if (n.startsWith(MPRIS_PREFIX))
                            this._addPlayer(n);
                    }
                } catch (e) {
                    console.debug(`[Kinetic Lyrics] ListNames failed: ${e.message}`);
                }
            });
    }

    _stopMpris() {
        if (this._nameWatchId && this._bus) {
            this._bus.signal_unsubscribe(this._nameWatchId);
            this._nameWatchId = 0;
        }
        for (const name of [...(this._players?.keys() ?? [])])
            this._removePlayer(name);
    }

    _addPlayer(name) {
        if (!this._players || this._players.has(name))
            return;
        const p = {
            name,
            status: 'Stopped',
            metadata: {},
            position: 0,          // microseconds at positionTime
            positionTime: GLib.get_monotonic_time(),
            lastPlayed: 0,
            subId: 0,
        };
        this._players.set(name, p);
        p.subId = this._bus.signal_subscribe(
            name, 'org.freedesktop.DBus.Properties', 'PropertiesChanged', MPRIS_PATH, null,
            Gio.DBusSignalFlags.NONE,
            (_c, _s, _p, _i, _n, params) => {
                const [iface, changed] = params.deepUnpack();
                if (iface !== PLAYER_IFACE)
                    return;
                this._applyProps(p, changed);
            });
        this._getAllProps(p);
        this._getPosition(p);
    }

    _removePlayer(name) {
        const p = this._players?.get(name);
        if (!p)
            return;
        if (p.subId)
            this._bus.signal_unsubscribe(p.subId);
        this._players.delete(name);
        this._onPlayerStateChanged();
    }

    _getAllProps(p) {
        this._bus.call(
            p.name, MPRIS_PATH, 'org.freedesktop.DBus.Properties', 'GetAll',
            new GLib.Variant('(s)', [PLAYER_IFACE]), null, Gio.DBusCallFlags.NONE, -1, null,
            (conn, res) => {
                try {
                    const [props] = conn.call_finish(res).deepUnpack();
                    this._applyProps(p, props);
                } catch (e) {
                    console.debug(`[Kinetic Lyrics] GetAll failed for ${p.name}: ${e.message}`);
                }
            });
    }

    _getPosition(p) {
        this._bus.call(
            p.name, MPRIS_PATH, 'org.freedesktop.DBus.Properties', 'Get',
            new GLib.Variant('(ss)', [PLAYER_IFACE, 'Position']), null,
            Gio.DBusCallFlags.NONE, -1, null,
            (conn, res) => {
                try {
                    const [v] = conn.call_finish(res).deepUnpack();
                    p.position = Number(v.deepUnpack());
                    p.positionTime = GLib.get_monotonic_time();
                } catch {
                    // Some players don't expose Position; keep the interpolated value.
                }
            });
    }

    _applyProps(p, props) {
        if (!this._players)
            return;
        if (props.PlaybackStatus) {
            p.status = props.PlaybackStatus.deepUnpack();
            if (p.status === 'Playing')
                p.lastPlayed = GLib.get_monotonic_time();
            // re-anchor the clock whenever play/pause flips
            this._getPosition(p);
        }
        if (props.Metadata)
            p.metadata = props.Metadata.deepUnpack();
        if (props.Position) {
            p.position = Number(props.Position.deepUnpack());
            p.positionTime = GLib.get_monotonic_time();
        }
        this._onPlayerStateChanged();
    }

    _activePlayer() {
        let best = null;
        for (const p of this._players?.values() ?? []) {
            if (p.status === 'Playing' && (!best || p.lastPlayed > best.lastPlayed))
                best = p;
        }
        return best;
    }

    _positionMs(p) {
        let pos = p.position;
        if (p.status === 'Playing')
            pos += GLib.get_monotonic_time() - p.positionTime;
        return pos / 1000 + this._cfg.offsetMs;
    }

    // ---- lyrics ---------------------------------------------------------

    _trackInfo(p) {
        const md = p.metadata;
        const unpack = k => md[k]?.deepUnpack?.() ?? md[k];
        const title = unpack('xesam:title') ?? '';
        let artist = unpack('xesam:artist') ?? '';
        if (Array.isArray(artist))
            artist = artist.join(', ');
        const album = unpack('xesam:album') ?? '';
        const lengthUs = Number(unpack('mpris:length') ?? 0);
        const trackId = String(unpack('mpris:trackid') ?? '');
        return {title, artist, album, duration: lengthUs / 1e6, trackId};
    }

    _onPlayerStateChanged() {
        const p = this._activePlayer();
        if (!p) {
            this._refreshVisibility();
            return;
        }
        const t = this._trackInfo(p);
        const key = `${t.title}|${t.artist}|${t.album}|${t.trackId}`;
        if (key !== this._trackKey) {
            this._trackKey = key;
            this._lyrics = null;
            this._activeIndex = -2;
            this._lastPosMs = undefined;
            this._clearContent();
            this._refreshVisibility();
            if (t.title || t.artist)
                this._fetchLyrics(t, key);
        } else {
            this._refreshVisibility();
        }
    }

    async _fetchLyrics(t, key) {
        const token = ++this._fetchToken;
        let res = null;
        try {
            res = await this._client.getLyrics(t.title, t.artist, t.album, t.duration);
        } catch (e) {
            console.debug(`[Kinetic Lyrics] fetch failed: ${e.message}`);
        }
        if (!this._client || token !== this._fetchToken || key !== this._trackKey)
            return;
        this._lyrics = res && res.lines?.length ? res : null;
        this._activeIndex = -2;
        this._lastPosMs = undefined;
        this._lastResync = 0;
        this._refreshVisibility();
        this._tick();
    }

    // ---- sync -----------------------------------------------------------

    _tick() {
        if (!this._box || !this._lyrics || !this._lyrics.isSynced)
            return;
        const p = this._activePlayer();
        if (!p)
            return;

        const now = GLib.get_monotonic_time() / 1000;
        if (!this._lastResync || now - this._lastResync > RESYNC_MS) {
            this._lastResync = now;
            this._getPosition(p);
        }

        let posMs = this._positionMs(p);
        // Players report position a little unevenly; never step back by a small
        // amount (that re-drew the line), only on a real seek backwards.
        if (this._lastPosMs !== undefined && posMs < this._lastPosMs &&
            this._lastPosMs - posMs < SEEK_BACK_MS)
            posMs = this._lastPosMs;
        this._lastPosMs = posMs;

        const lines = this._lyrics.lines;
        let idx = -1;
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].time <= posMs)
                idx = i;
            else
                break;
        }
        if (idx !== this._activeIndex) {
            this._activeIndex = idx;
            this._render(idx);
        }
    }

    _cancelReveals() {
        for (const id of this._revealIds ?? [])
            GLib.source_remove(id);
        this._revealIds = [];
    }

    _clearContent() {
        this._cancelReveals();
        const old = this._content;
        this._content = null;
        if (!old)
            return;
        old.ease({
            opacity: 0, duration: 180, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => old.destroy(),
        });
    }

    _tokens(text) {
        return text
            .split(/\s+/)
            .map(t => t.replace(/^[("“‘[]+/, '').replace(/[,.;:!?"”’)\]]+$/, ''))
            .filter(t => t.length > 0);
    }

    // When to show each token (ms, absolute track time).
    _tokenTimes(line, tokens, nextTime) {
        if (line.words?.length) {
            let joined = '';
            const starts = [];
            for (const w of line.words) {
                starts.push([joined.length, w.time]);
                joined += w.text ?? '';
            }
            const times = [];
            let cursor = 0;
            for (const tok of tokens) {
                const at = joined.indexOf(tok, cursor);
                if (at < 0) {
                    times.push(null);
                    continue;
                }
                cursor = at + tok.length;
                let t = line.time;
                for (const [off, time] of starts) {
                    if (off <= at)
                        t = time;
                    else
                        break;
                }
                times.push(t);
            }
            if (times.every(t => t !== null))
                return times;
        }
        const span = Math.max(600, Math.min((nextTime - line.time) * this._cfg.spread, 4500));
        return tokens.map((_, i) => line.time + (tokens.length > 1 ? span * i / (tokens.length - 1) : 0));
    }

    _hash(str) {
        let h = 0;
        for (let i = 0; i < str.length; i++)
            h = (h * 31 + str.charCodeAt(i)) | 0;
        return Math.abs(h);
    }

    _wordStyle(isScript, size) {
        const c = this._cfg;
        return `font-family: '${isScript ? c.scriptFont : c.capsFont}'; ` +
            `font-size: ${Math.round(size)}px; color: ${c.color};` +
            (c.shadow ? '' : ' text-shadow: none;');
    }

    _makeWord(tok, style) {
        const isScript = style.script;
        const text = isScript || !this._cfg.uppercase ? tok : tok.toUpperCase();
        const label = new St.Label({
            text,
            style_class: 'kinetic-lyrics-word',
            y_align: Clutter.ActorAlign.END,
        });
        label.style = this._wordStyle(isScript, style.size);
        label.clutter_text.set_ellipsize(Pango.EllipsizeMode.NONE);
        label.set_pivot_point(0.5, 0.7);
        label._size = style.size;
        label._script = isScript;
        return label;
    }

    _render(idx) {
        this._clearContent();
        const c = this._cfg;
        const lines = this._lyrics?.lines;
        const line = lines?.[idx];
        if (!line || !line.text?.trim())
            return;

        const tokens = this._tokens(line.text);
        if (tokens.length === 0)
            return;

        // --- decide each word's look -------------------------------------
        const letters = t => t.replace(/[^\p{L}\p{N}]/gu, '');
        const lens = tokens.map(t => letters(t).length);
        const shrink = Math.max(0.55, Math.min(1, 7 / tokens.length));
        let hero = -1;
        lens.forEach((l, i) => {
            if (l > c.scriptMaxLetters && (hero < 0 || l > lens[hero]))
                hero = i;
        });
        const styles = tokens.map((t, i) => {
            if (lens[i] <= c.scriptMaxLetters && tokens.length > 1)
                return {script: true, size: c.scriptSize * shrink};
            if (i === hero)
                return {script: false, size: c.heroSize * shrink};
            return {script: false, size: (lens[i] >= 5 ? c.bigSize : c.midSize) * shrink};
        });

        const maxW = this._columnWidth();
        const content = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        content.set_width(maxW);
        this._box.add_child(content);
        this._content = content;

        // --- measure, shrinking any word wider than the column -----------
        const labels = tokens.map((t, i) => this._makeWord(t, styles[i]));
        const probe = new St.BoxLayout({opacity: 0});
        content.add_child(probe);
        for (const l of labels)
            probe.add_child(l);
        const widths = labels.map(l => {
            l.ensure_style();
            let w = l.get_preferred_width(-1)[1];
            if (w > maxW) {
                l._size *= maxW / w;
                l.style = this._wordStyle(l._script, l._size);
                l.ensure_style();
                w = l.get_preferred_width(-1)[1];
            }
            return w;
        });
        for (const l of labels)
            probe.remove_child(l);
        content.remove_child(probe);
        probe.destroy();

        // --- greedy row filling -------------------------------------------
        const rows = [];
        let cur = [], curW = 0;
        labels.forEach((l, i) => {
            const need = widths[i] + (cur.length ? c.wordGap : 0);
            if (cur.length && curW + need > maxW) {
                rows.push(cur);
                cur = [];
                curW = 0;
            }
            curW += widths[i] + (cur.length ? c.wordGap : 0);
            cur.push(l);
        });
        if (cur.length)
            rows.push(cur);

        for (const r of rows) {
            const row = new St.BoxLayout({
                x_align: ALIGN[c.rowAlign] ?? Clutter.ActorAlign.END,
                style: `spacing: ${c.wordGap}px;`,
            });
            for (const l of r)
                row.add_child(l);
            content.add_child(row);
        }

        // --- hand-painted wobble + kinetic reveal -------------------------
        const player = this._activePlayer();
        const now = player ? this._positionMs(player) : line.time;
        const nextTime = lines[idx + 1]?.time ?? line.time + 5000;
        const times = c.wordByWord
            ? this._tokenTimes(line, tokens, nextTime)
            : tokens.map(() => line.time);
        labels.forEach((l, i) => {
            const h = this._hash(tokens[i] + i);
            const jitterY = c.wobble ? (h % 9) - 4 : 0;
            l.rotation_angle_z = c.wobble ? ((h >> 3) % 7 - 3) * 0.7 : 0;
            l.opacity = 0;
            l.set_scale(0.8, 0.8);
            l.translation_y = jitterY + 18;
            const show = () => {
                if (!l.get_stage())
                    return;
                // Opacity gets a plain curve: a "back" curve overshoots past 255
                // and wraps around, which made words blink. Only the scale bounces.
                l.ease({
                    opacity: 255,
                    duration: Math.round(c.wordInMs * 0.6), mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
                l.ease({
                    scale_x: 1, scale_y: 1, translation_y: jitterY,
                    duration: c.wordInMs, mode: Clutter.AnimationMode.EASE_OUT_BACK,
                });
            };
            const delay = times[i] - now;
            if (delay < -c.wordInMs) {
                // already sung (e.g. after a seek or a settings change): just show it
                l.opacity = 255;
                l.set_scale(1, 1);
                l.translation_y = jitterY;
            } else if (delay <= 30) {
                show();
            } else {
                const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.round(delay), () => {
                    this._revealIds = this._revealIds.filter(x => x !== id);
                    show();
                    return GLib.SOURCE_REMOVE;
                });
                this._revealIds.push(id);
            }
        });

        this._centerContent();
    }
}
