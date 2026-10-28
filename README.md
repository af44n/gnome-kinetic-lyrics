# Kinetic Lyrics

GNOME extension that puts synced lyrics on your desktop, styled like those hand-lettered lyric videos. Big words get big, small words go script, and each word pops in as it's sung.

It sits above the wallpaper (live wallpapers too) and below your windows, and works with anything that shows up as a media player: Spotify, YouTube in the browser, mpv, etc.

Needs GNOME 49, 50 or 51.

# screenshot

<img width="1920" height="1200" alt="image" src="https://github.com/user-attachments/assets/34be42df-ce17-432f-a346-f6b40239538e" />


## Install

```sh
git clone https://github.com/af44n/gnome-kinetic-lyrics.git
cd gnome-kinetic-lyrics
./install.sh
```

On Wayland you'll have to log out and back in, then:

```sh
gnome-extensions enable kinetic-lyrics@af44n
```

## Settings

Open it from the Extensions app. You can change the fonts, colour, sizes, which side of the screen it's on, animation speed, word-by-word on/off and a timing offset if lyrics feel early or late.

## Credits

Lyrics fetching is borrowed from [Dynamic Music Pill](https://github.com/Andbal23/dynamic-music-pill) by Andbal23. Fonts are [League Gothic](https://github.com/theleagueof/league-gothic) and Nanum Brush Script, both under the OFL (licenses in `fonts/`).

GPL-3.0
