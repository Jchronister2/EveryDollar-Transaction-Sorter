from PIL import Image, ImageDraw

sizes = [16, 48, 128]

def draw_icon(size):
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    center = size // 2
    radius = int(size * 0.47)

    # Background circle
    draw.ellipse([center-radius, center-radius, center+radius, center+radius], fill='#43a047')

    # Swoosh curves (simplified as arcs/lines for small sizes)
    if size >= 48:
        # Top swoosh
        sw = max(1, size // 20)
        points1 = [(size*0.15, size*0.35), (size*0.35, size*0.18), (size*0.65, size*0.15), (size*0.85, size*0.25)]
        for i in range(len(points1)-1):
            draw.line([points1[i], points1[i+1]], fill=(255, 255, 255, 220), width=sw)

        # Middle swoosh
        points2 = [(size*0.12, size*0.45), (size*0.30, size*0.30), (size*0.55, size*0.28), (size*0.88, size*0.35)]
        for i in range(len(points2)-1):
            draw.line([points2[i], points2[i+1]], fill=(255, 255, 255, 180), width=sw)

        # Bottom swoosh
        points3 = [(size*0.10, size*0.55), (size*0.28, size*0.42), (size*0.50, size*0.40), (size*0.90, size*0.45)]
        for i in range(len(points3)-1):
            draw.line([points3[i], points3[i+1]], fill=(255, 255, 255, 140), width=sw)

    # Robot head (white rectangle)
    head_w = int(size * 0.38)
    head_h = int(size * 0.36)
    head_x = center - head_w // 2
    head_y = int(size * 0.48)
    draw.rounded_rectangle([head_x, head_y, head_x + head_w, head_y + head_h], radius=max(1, size//12), fill='white')

    # Robot antenna
    antenna_top = head_y - size // 8
    draw.line([center, head_y, center, antenna_top], fill='white', width=max(1, size // 24))
    ant_r = max(1, size // 20)
    draw.ellipse([center - ant_r, antenna_top - ant_r, center + ant_r, antenna_top + ant_r], fill='white')

    # Robot eyes
    eye_r = max(1, size // 16)
    eye_y = head_y + head_h // 3
    left_eye_x = center - head_w // 4
    right_eye_x = center + head_w // 4
    draw.ellipse([left_eye_x - eye_r, eye_y - eye_r, left_eye_x + eye_r, eye_y + eye_r], fill='#2e7d32')
    draw.ellipse([right_eye_x - eye_r, eye_y - eye_r, right_eye_x + eye_r, eye_y + eye_r], fill='#2e7d32')

    # Eye highlights
    if size >= 48:
        hl_r = max(1, eye_r // 3)
        draw.ellipse([left_eye_x - eye_r//2 - hl_r, eye_y - eye_r//2 - hl_r,
                      left_eye_x - eye_r//2 + hl_r, eye_y - eye_r//2 + hl_r], fill='white')
        draw.ellipse([right_eye_x - eye_r//2 - hl_r, eye_y - eye_r//2 - hl_r,
                      right_eye_x - eye_r//2 + hl_r, eye_y - eye_r//2 + hl_r], fill='white')

    # Robot mouth
    mouth_w = max(4, int(head_w * 0.5))
    mouth_h = max(2, size // 18)
    mouth_x = center - mouth_w // 2
    mouth_y = head_y + int(head_h * 0.68)
    if mouth_x + mouth_w > mouth_x and mouth_y + mouth_h > mouth_y:
        draw.rectangle([mouth_x, mouth_y, mouth_x + mouth_w, mouth_y + mouth_h], fill='#2e7d32')

    # Gold sparkles for AI
    if size >= 48:
        sparkle_color = '#FFD700'
        # Top right sparkle
        sx, sy = int(size * 0.82), int(size * 0.18)
        sr = max(1, size // 24)
        draw.line([(sx-sr*2, sy), (sx+sr*2, sy)], fill=sparkle_color, width=max(1, size//40))
        draw.line([(sx, sy-sr*2), (sx, sy+sr*2)], fill=sparkle_color, width=max(1, size//40))

        # Bottom left sparkle
        sx2, sy2 = int(size * 0.18), int(size * 0.75)
        draw.line([(sx2-sr, sy2), (sx2+sr, sy2)], fill=sparkle_color, width=max(1, size//48))
        draw.line([(sx2, sy2-sr), (sx2, sy2+sr)], fill=sparkle_color, width=max(1, size//48))

    return img

for size in sizes:
    img = draw_icon(size)
    img.save(f'icon{size}.png')
    print(f'Created icon{size}.png')

print('Done!')
