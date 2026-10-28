// Kinetic Lyrics — preferences window.
// SPDX-License-Identifier: GPL-3.0-or-later

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class KineticLyricsPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window._settings = settings;
        window.set_default_size(660, 820);
        window.search_enabled = true;
        this._registerBundledFonts();

        window.add(this._lookPage(settings));
        window.add(this._layoutPage(settings));
        window.add(this._motionPage(settings));
    }

    // Make the fonts shipped with the extension show up in the font pickers.
    _registerBundledFonts() {
        const fontMap = PangoCairo.FontMap.get_default();
        if (!fontMap?.add_font_file)
            return;
        const dir = this.dir.get_child('fonts');
        try {
            const iter = dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
            let info;
            while ((info = iter.next_file(null))) {
                if (/\.(ttf|otf)$/i.test(info.get_name()))
                    fontMap.add_font_file(dir.get_child(info.get_name()).get_path());
            }
            iter.close(null);
        } catch (e) {
            console.warn(`[Kinetic Lyrics] could not register bundled fonts: ${e.message}`);
        }
    }

    // ---- pages ------------------------------------------------------------

    _lookPage(s) {
        const page = new Adw.PreferencesPage({title: 'Look', icon_name: 'font-x-generic-symbolic'});

        const fonts = new Adw.PreferencesGroup({
            title: 'Fonts',
            description: 'League Gothic and Nanum Brush Script come with the extension.',
        });
        fonts.add(this._fontRow(s, 'caps-font', 'Big words', 'The tall, bold words of each line'));
        fonts.add(this._fontRow(s, 'script-font', 'Small words', 'Short words like "a", "to", "me"'));
        fonts.add(this._switchRow(s, 'uppercase', 'Capitalise big words'));
        fonts.add(this._spinRow(s, 'script-max-letters', 'Script words up to', 'Words with this many letters or fewer use the small-word font', 0, 6, 1, 'letters'));
        page.add(fonts);

        const colour = new Adw.PreferencesGroup({title: 'Colour'});
        colour.add(this._colorRow(s, 'paint-color', 'Lyrics colour'));
        colour.add(this._switchRow(s, 'text-shadow', 'Shadow', 'Soft shadow so the words stand out from the wallpaper'));
        page.add(colour);

        const sizes = new Adw.PreferencesGroup({
            title: 'Sizes',
            description: 'Long lines shrink automatically to fit.',
        });
        sizes.add(this._spinRow(s, 'hero-size', 'Longest word', null, 20, 400, 2, 'px'));
        sizes.add(this._spinRow(s, 'big-size', 'Other long words', null, 10, 400, 2, 'px'));
        sizes.add(this._spinRow(s, 'mid-size', 'Short words', null, 10, 400, 2, 'px'));
        sizes.add(this._spinRow(s, 'script-size', 'Script words', null, 10, 400, 2, 'px'));
        sizes.add(this._spinRow(s, 'word-gap', 'Space between words', null, 0, 120, 1, 'px'));
        page.add(sizes);

        page.add(this._resetGroup(s));
        return page;
    }

    _layoutPage(s) {
        const page = new Adw.PreferencesPage({title: 'Layout', icon_name: 'view-dual-symbolic'});

        const where = new Adw.PreferencesGroup({title: 'Position'});
        where.add(this._comboRow(s, 'position', 'Side of the screen', [
            ['left', 'Left'], ['center', 'Centre'], ['right', 'Right'],
        ]));
        where.add(this._spinRow(s, 'horizontal-margin', 'Distance from edge', 'Ignored when centred', 0, 1000, 5, 'px'));
        where.add(this._spinRow(s, 'vertical-offset', 'Vertical offset', 'Negative moves up, positive moves down', -1000, 1000, 5, 'px'));
        page.add(where);

        const column = new Adw.PreferencesGroup({title: 'Column'});
        column.add(this._spinRow(s, 'column-width', 'Width', 'Share of the screen width', 10, 100, 1, '%'));
        column.add(this._spinRow(s, 'max-width', 'Maximum width', null, 200, 4000, 10, 'px'));
        column.add(this._comboRow(s, 'row-align', 'Align rows', [
            ['start', 'Left'], ['center', 'Centre'], ['end', 'Right'],
        ]));
        page.add(column);

        const vis = new Adw.PreferencesGroup({title: 'Visibility'});
        vis.add(this._switchRow(s, 'hide-in-overview', 'Hide in Activities overview'));
        page.add(vis);
        return page;
    }

    _motionPage(s) {
        const page = new Adw.PreferencesPage({title: 'Animation & Sync', icon_name: 'media-playback-start-symbolic'});

        const sync = new Adw.PreferencesGroup({title: 'Sync'});
        sync.add(this._switchRow(s, 'word-by-word', 'Word-by-word', 'Reveal words as they are sung. Off shows each line all at once.'));
        sync.add(this._spinRow(s, 'lyrics-offset-ms', 'Timing offset', 'If lyrics run late, increase; if early, decrease', -10000, 10000, 50, 'ms'));
        sync.add(this._spinRow(s, 'word-spread', 'Word spread', 'For lyrics without per-word timing: how much of the line the words are spread across', 10, 100, 5, '%'));
        page.add(sync);

        const anim = new Adw.PreferencesGroup({title: 'Animation'});
        anim.add(this._spinRow(s, 'word-animation-ms', 'Word pop-in speed', 'Lower is snappier; 0 turns the pop off', 0, 2000, 10, 'ms'));
        anim.add(this._spinRow(s, 'line-fade-ms', 'Fade in/out', 'When lyrics appear or disappear', 0, 2000, 10, 'ms'));
        anim.add(this._switchRow(s, 'wobble', 'Hand-painted wobble', 'Slight tilt and bounce on each word'));
        page.add(anim);

        const about = new Adw.PreferencesGroup({
            title: 'About',
            description: 'Lyrics come from public providers (Apple Music, LRCLIB and others), queried in parallel. ' +
                'Fetching logic adapted from Dynamic Music Pill by Andbal23 (GPL-3.0).',
        });
        page.add(about);
        return page;
    }

    // ---- row helpers ------------------------------------------------------

    _switchRow(s, key, title, subtitle = null) {
        const row = new Adw.SwitchRow({title});
        if (subtitle)
            row.subtitle = subtitle;
        s.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
        return row;
    }

    _spinRow(s, key, title, subtitle, min, max, step, unit) {
        const row = Adw.SpinRow.new_with_range(min, max, step);
        row.title = unit ? `${title} (${unit})` : title;
        if (subtitle)
            row.subtitle = subtitle;
        s.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
        return row;
    }

    _comboRow(s, key, title, choices) {
        const row = new Adw.ComboRow({
            title,
            model: Gtk.StringList.new(choices.map(c => c[1])),
        });
        const sync = () => {
            const i = choices.findIndex(c => c[0] === s.get_string(key));
            if (i >= 0 && row.selected !== i)
                row.selected = i;
        };
        sync();
        row.connect('notify::selected', () => {
            const value = choices[row.selected]?.[0];
            if (value && value !== s.get_string(key))
                s.set_string(key, value);
        });
        s.connect(`changed::${key}`, sync);
        return row;
    }

    _fontRow(s, key, title, subtitle) {
        const row = new Adw.ActionRow({title, subtitle});
        const button = new Gtk.FontDialogButton({
            dialog: new Gtk.FontDialog({title: `Choose a font for ${title.toLowerCase()}`}),
            level: Gtk.FontLevel.FAMILY,
            use_font: true,
            valign: Gtk.Align.CENTER,
        });
        const sync = () => {
            const family = s.get_string(key);
            if (button.font_desc?.get_family() !== family)
                button.font_desc = Pango.FontDescription.from_string(family);
        };
        sync();
        button.connect('notify::font-desc', () => {
            const family = button.font_desc?.get_family();
            if (family && family !== s.get_string(key))
                s.set_string(key, family);
        });
        s.connect(`changed::${key}`, sync);

        const reset = new Gtk.Button({
            icon_name: 'edit-undo-symbolic',
            tooltip_text: 'Back to the bundled font',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        reset.connect('clicked', () => s.reset(key));

        row.add_suffix(button);
        row.add_suffix(reset);
        return row;
    }

    _colorRow(s, key, title) {
        const row = new Adw.ActionRow({title});
        const button = new Gtk.ColorDialogButton({
            dialog: new Gtk.ColorDialog({with_alpha: false}),
            valign: Gtk.Align.CENTER,
        });
        const sync = () => {
            const rgba = new Gdk.RGBA();
            if (rgba.parse(s.get_string(key)) && !rgba.equal(button.rgba))
                button.rgba = rgba;
        };
        sync();
        button.connect('notify::rgba', () => {
            const c = button.rgba;
            const hex = '#' + [c.red, c.green, c.blue]
                .map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
            if (hex !== s.get_string(key))
                s.set_string(key, hex);
        });
        s.connect(`changed::${key}`, sync);
        row.add_suffix(button);
        row.activatable_widget = button;
        return row;
    }

    _resetGroup(s) {
        const group = new Adw.PreferencesGroup();
        const row = new Adw.ButtonRow({title: 'Reset all settings'});
        row.add_css_class('destructive-action');
        row.connect('activated', () => {
            for (const key of s.settings_schema.list_keys())
                s.reset(key);
        });
        group.add(row);
        return group;
    }
}
