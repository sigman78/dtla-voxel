"""Southern-California palette: sun-bleached stucco, terracotta, cool white roofs, dusty greens, golden dry grass.

Material ids match web/src/voxelMaterial.ts (inherited from warsaw-vibe-voxel, plus STUCCO).
"""
import colorsys
import hashlib
import re

(M_SOLID, M_WALL, M_GLASS, M_LEAF, M_WATER, M_LAMP, M_METAL, _M7, M_GRASS, M_MARK, M_SOIL, M_CAR, M_ROOF,
 M_CONCRETE, _M14, M_BRONZE, M_SIGN, _M17, M_SIGNBAND, M_RIBBON, M_CLASSIC, M_WINDOW, M_STUCCO) = range(23)


def hex_rgb(h):
    h = h.lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def soften(rgb, amt=0.10):
    """Grade toward sun-bleached cream (the SoCal light), keeping hue."""
    return tuple(v * (1 - amt) + w * amt for v, w in zip(rgb, (240, 228, 206)))


def stable_hash(*a):
    return int(hashlib.md5("/".join(map(str, a)).encode()).hexdigest()[:8], 16)


class Palette:
    def __init__(self):
        self.entries = [(0, 0, 0, 0)]
        self.index = {}

    def __call__(self, rgb, mat=M_SOLID, q=4):
        if isinstance(rgb, str):
            rgb = hex_rgb(rgb)
        r, g, b = (min(255, int(round(v / q)) * q) for v in rgb)
        key = (r, g, b, mat)
        if key not in self.index:
            self.index[key] = len(self.entries)
            self.entries.append(key)
        return self.index[key]


COLOUR_ALIASES = {"grey": "#9a9a9a", "gray": "#9a9a9a", "lightgrey": "#cfcfcc", "lightgray": "#cfcfcc",
                  "darkgrey": "#6e6f72", "darkgray": "#6e6f72", "cream": "#f1e6cc", "sand": "#dcc79c",
                  "beige": "#e0d2b4", "brick": "#a55a43", "terracotta": "#c46a45", "glass": "#7fa3ad",
                  "concrete": "#c9c3b7", "gold": "#cfae5c", "bronze": "#8c6c47", "copper": "#5f9c87",
                  "ochre": "#d4a256", "salmon": "#e8a189", "pink": "#ecbcb4", "white": "#f2ede2",
                  "black": "#3a3a3d", "red": "#b5513f", "brown": "#87634a", "yellow": "#e8cf73",
                  "green": "#7aa36a", "blue": "#6f95b5", "orange": "#e0925a", "silver": "#c3c6c9",
                  "tan": "#d2b48c", "maroon": "#7e3a33", "navy": "#3d4f6e", "purple": "#8a6a9a"}
NAMED = {"aqua": "#7fd4d0", "teal": "#4f9a96", "olive": "#8a8a4a", "lime": "#a6c45a", "khaki": "#d8cb8f",
         "ivory": "#f4efdc", "lavender": "#c6b8de", "turquoise": "#6cc9c0", "coral": "#ec8d72"}


def parse_colour(s):
    if not s:
        return None
    s = s.split(";")[0].strip().lower().replace(" ", "").replace("_", "")
    s = COLOUR_ALIASES.get(s) or NAMED.get(s) or s
    if not re.fullmatch(r"#?[0-9a-f]{6}|#?[0-9a-f]{3}", s):
        return None
    rgb = hex_rgb(s)
    h_, l_, s_ = colorsys.rgb_to_hls(*(v / 255 for v in rgb))
    if s_ > 0.6 and 0.12 < l_ < 0.9:  # paint is never neon
        s_ = 0.6
    l_ = max(l_, 0.3)  # nor black: dark granite and tinted glass still read as a colour in the sun
    return tuple(round(v * 255) for v in colorsys.hls_to_rgb(h_, l_, s_))


pal = Palette()
C = {
    # streets: sun-bleached asphalt, pale concrete sidewalks with a warm cast
    "paving": pal("#d8cfbf"), "paving2": pal("#cbc3b4"), "concrete": pal("#d3ccbe"), "kerb": pal("#e2dccf"),
    "asphalt": pal("#66676b"), "asphalt_l": pal("#7a7a7c"), "parking": pal("#7f7e80"), "fwy": pal("#727174"),
    "mark": pal("#f4f1e8", M_MARK), "mark_y": pal("#e9c357", M_MARK), "cycle": pal("#5f9e6e"),
    "brick_pave": pal("#b9775a"), "plaza_red": pal("#c98d6c"), "tile": pal("#c9a27e"),
    # soft ground
    "lawn": pal("#93b05a", M_GRASS), "lawn2": pal("#86a653", M_GRASS), "dry": pal("#cdb47a", M_GRASS),
    "dry2": pal("#bfa56b", M_GRASS), "olive": pal("#a5a764", M_GRASS), "turf": pal("#7fae55", M_GRASS),
    "dirt": pal("#c9a67a"), "dirt2": pal("#b8946a"), "gravel": pal("#dccbaa"), "sand": pal("#e4d1a6"),
    "mulch": pal("#9c7553"), "track": pal("#c0704c"),
    "bare": pal("#c7ad85", M_SOIL),  # lawn before its grass tile arrives
    # rail, river
    "ballast": pal("#a39789"), "rail": pal("#5b5a5c", M_METAL), "platform": pal("#cfc6b6"),
    "channel": pal("#cbc4b5", M_CONCRETE), "water": pal("#6f8b78", M_WATER), "reeds": pal("#7d9a55", M_LEAF),
    # diorama base
    "soil": pal("#b98a5e", M_SOIL), "trunk": pal("#7a5f47"), "palm_trunk": pal("#8f7a62"),
    "lamp": pal("#ffd9a0", M_LAMP), "pole": pal("#4a4c50", M_METAL),
    # structures
    "deck": pal("#cdc6b8"), "deck_side": pal("#bdb6a9"), "pier": pal("#c4bdb0"),  # plain: no shop windows on bridges
    "viaduct": pal("#eeebe4"), "barrier": pal("#ddd7cb"),
    "roof_default": pal("#d9d6cf", M_ROOF), "roof_tower": pal("#b8b8b4", M_ROOF), "garden_roof": pal("#86a653", M_GRASS),
}
# Trees: dusty, olive, sage and deep ficus greens (dry-climate foliage), light -> dark
LEAVES = [pal(c, M_LEAF) for c in ["#a8b46a", "#94a65c", "#7f9550", "#6b8546", "#56713c",
                                    "#9fb07d", "#8a9f72", "#748b63", "#5f7754", "#4b6246"]]
PALM_FRONDS = [pal(c, M_LEAF) for c in ["#9fae4f", "#8da046", "#a9b25a", "#7f9442"]]
PALM_SKIRT = pal("#b89d68", M_LEAF)
JACARANDA = pal("#9a86c4", M_LEAF)  # a few, for the LA street-tree touch
BOUGAINVILLEA = pal("#d0628f", M_LEAF)

STUCCO = ["#f1e9d8", "#f3dfc6", "#ecccad", "#eab9a2", "#e9d49c", "#dfe5d3", "#f1d6cc", "#d4e0e2",
          "#e8dfcf", "#f5eee2", "#e4c7a4", "#d9c3e0"]
CLASSIC = ["#e6d6b6", "#dcc39c", "#e9dfc9", "#cfb391", "#d9cbb2"]  # Beaux-Arts terracotta and limestone
BRICK = ["#a55a43", "#b0674d", "#94503d", "#b97a5c", "#8e5a48"]
INDUSTRIAL = ["#cfc8bb", "#bfb8aa", "#d8cdb6", "#c9b8a0", "#b6b9b4"]
GLASS = ["#6d9aa6", "#5d8496", "#7fa8b3", "#4f6b7a", "#8fb2b8", "#9a8a6a", "#a9b4ba", "#6a8f8a"]
