# MakeHuman heads

Made by `art/rider/mh.py` from [MakeHuman](http://www.makehumancommunity.org/) through MPFB 2, with the
MakeHuman system asset pack:

For each body (`male`, `female`):

- `<body>.obj`: the head of its proxy (`male1591`, `female1605`: the game mesh), the head of the base mesh (to bake
  from), the low-poly eyes and five brows (male `eyebrow008`, `eyebrow009`, `eyebrow003`, `eyebrow005`,
  `eyebrow007`; female `eyebrow002`, `eyebrow001`, `eyebrow011`, `eyebrow010`, `eyebrow004`).
- `<body>.json`: landmarks of that head (eyes, ear, skull centre, crown).
- `<body>.brow.<n>.png`: the brows' textures, in the order above.
- `<body>.skin.png`: `young_lightskinned_<body>_diffuse.png` at 1024 × 1024.
- `<body>.faces.json`: the face presets (`FACES` in `mh.py`: eyes, nose and mouth, each preset a set of MakeHuman
  targets over the head's own) as offsets of the `head` mesh's vertices, which the build turns into morph targets.

MakeHuman's assets are released under CC0 1.0 (public domain dedication).

`art/rider/build.py` only reads these files. To change a head (the settings in `MALE` or `FEMALE` in `mh.py`) and
export it again, install MPFB in a Blender profile of its own, get the asset pack, then run `mh.py` (made with
Blender 5.2.3 and MPFB 2.0.18):

```sh
export BLENDER_USER_RESOURCES=/tmp/mpfb-profile
B=/Applications/Blender.app/Contents/MacOS/Blender
$B --online-mode --command extension install -s -e mpfb
curl -LO https://files.makehumancommunity.org/asset_packs/makehuman_system_assets/makehuman_system_assets_cc0.zip
unzip -q makehuman_system_assets_cc0.zip -d /tmp/mh-assets
$B --background --python art/rider/mh.py -- --assets /tmp/mh-assets
# The face presets only (after changing FACES):
$B --background --python art/rider/mh.py -- --assets /tmp/mh-assets --faces
# One body only: add --body female (or male).
```
