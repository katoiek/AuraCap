# AuraCapアプリアイコンのソース画像を生成する / Generate the AuraCap app icon source
# ダークの角丸地 + 中央のオーラ(amber)グロー + ビューファインダーの四隅枠
# Dark rounded square + central amber "aura" glow + viewfinder corner brackets
from PIL import Image, ImageDraw, ImageFilter

S = 1024
AMBER = (251, 191, 36, 255)   # tailwind amber-400 / #fbbf24
DARK = (24, 24, 27, 255)      # tailwind zinc-900 / #18181b
MARGIN = 36
RADIUS = 200

# ベースは透明。角丸の枠でクリップする / Transparent base, clipped by a rounded mask
base = Image.new("RGBA", (S, S), (0, 0, 0, 0))

# 背景の角丸（上をわずかに明るくしたフラットダーク）/ Rounded dark background
bg = Image.new("RGBA", (S, S), (0, 0, 0, 0))
ImageDraw.Draw(bg).rounded_rectangle(
    [MARGIN, MARGIN, S - MARGIN, S - MARGIN], radius=RADIUS, fill=DARK
)
base.alpha_composite(bg)

# 中央のオーラグロー / Central amber glow ("aura")
glow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
cx = cy = S // 2
ImageDraw.Draw(glow).ellipse(
    [cx - 280, cy - 280, cx + 280, cy + 280], fill=(251, 191, 36, 110)
)
glow = glow.filter(ImageFilter.GaussianBlur(130))
base.alpha_composite(glow)

# ビューファインダーの四隅枠 / Viewfinder corner brackets
draw = ImageDraw.Draw(base)
FM = 300          # 枠の位置 / frame inset
ARM = 165         # 腕の長さ / arm length
TH = 46           # 太さ / thickness
r = TH // 2

def bracket(cxp, cyp, dx, dy):
    # (cxp,cyp)を角として、dx,dy方向へL字を描く / L-shape from the corner toward dx,dy
    hx0, hx1 = sorted([cxp, cxp + dx * ARM])
    draw.rounded_rectangle([hx0, cyp - r, hx1, cyp + r], radius=r, fill=AMBER)
    vy0, vy1 = sorted([cyp, cyp + dy * ARM])
    draw.rounded_rectangle([cxp - r, vy0, cxp + r, vy1], radius=r, fill=AMBER)

bracket(FM, FM, +1, +1)              # 左上 / top-left
bracket(S - FM, FM, -1, +1)          # 右上 / top-right
bracket(FM, S - FM, +1, -1)          # 左下 / bottom-left
bracket(S - FM, S - FM, -1, -1)      # 右下 / bottom-right

# 中央のターゲットドット / Center target dot
draw.ellipse([cx - 30, cy - 30, cx + 30, cy + 30], fill=AMBER)

# 角丸でクリップ（はみ出し防止） / Clip to the rounded square
mask = Image.new("L", (S, S), 0)
ImageDraw.Draw(mask).rounded_rectangle(
    [MARGIN, MARGIN, S - MARGIN, S - MARGIN], radius=RADIUS, fill=255
)
out = Image.new("RGBA", (S, S), (0, 0, 0, 0))
out.paste(base, (0, 0), mask)

out.save("src-tauri/icons/source.png")
print("wrote src-tauri/icons/source.png")
