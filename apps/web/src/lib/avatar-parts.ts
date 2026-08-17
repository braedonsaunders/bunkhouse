import type { AvatarPartCategory } from '@braedonsaunders/appkit-avatars/composition'

/**
 * The slots a figure is built from.
 *
 * These are code constants rather than tenant configuration on purpose. A
 * category is not a preference — it is the vocabulary the generation prompts,
 * the composer, and every stored composition all key off. Changing one
 * reinterprets every saved figure, which is exactly the kind of retroactive
 * config change the engineering standards forbid. What *is* tenant data is the
 * library itself: which parts exist in each slot, and how each person's figure
 * is arranged.
 *
 * Geometry is in canvas units on the shared 512 × 768 full-body stage (see
 * `@braedonsaunders/appkit-avatars/composition`). `frame` is a part's natural box at scale 1;
 * `defaultTransform` is where a freshly placed part lands, so a library drops
 * onto the stage already assembled and only needs nudging.
 *
 * The stage is laid out around a figure roughly 620 units tall standing on the
 * bottom edge: head from y≈40 to y≈220, torso to y≈470, legs to y≈760.
 */
export const AVATAR_PART_CATEGORIES: AvatarPartCategory[] = [
  {
    id: 'body',
    label: 'Body',
    layerOrder: 10,
    required: true,
    frame: { width: 300, height: 640 },
    defaultTransform: { x: 106, y: 120, scale: 1, rotation: 0 },
    promptAddition:
      'a full standing body seen head-on from the neck down, arms relaxed at the sides, ' +
      'plain skin tone, no clothing detail, feet together at the bottom edge of the frame',
  },
  {
    id: 'outfit',
    label: 'Outfit',
    layerOrder: 20,
    required: true,
    frame: { width: 300, height: 460 },
    defaultTransform: { x: 106, y: 196, scale: 1, rotation: 0 },
    promptAddition:
      'clothing only, worn shape with an empty open neckline and empty sleeves, ' +
      'nobody inside it — no body, no head, no arms, no feet',
  },
  {
    id: 'legs',
    label: 'Legs',
    layerOrder: 25,
    required: false,
    frame: { width: 260, height: 360 },
    defaultTransform: { x: 126, y: 400, scale: 1, rotation: 0 },
    promptAddition:
      'trousers or a skirt only, worn shape with an empty waist and empty leg openings, ' +
      'nobody inside them — no body, no torso, no feet',
  },
  {
    id: 'face',
    label: 'Face',
    layerOrder: 30,
    required: true,
    frame: { width: 190, height: 220 },
    defaultTransform: { x: 161, y: 36, scale: 1, rotation: 0 },
    promptAddition:
      'a bare head and neck facing forward, plain skin, no hair, no eyebrows, ' +
      'no eyes, no mouth — a blank head shape only',
  },
  {
    id: 'eyes',
    label: 'Eyes',
    layerOrder: 40,
    frame: { width: 130, height: 46 },
    defaultTransform: { x: 191, y: 112, scale: 1, rotation: 0 },
    promptAddition: 'a matched pair of eyes only, level and facing forward, nothing around them',
  },
  {
    id: 'brows',
    label: 'Brows',
    layerOrder: 50,
    frame: { width: 136, height: 30 },
    defaultTransform: { x: 188, y: 88, scale: 1, rotation: 0 },
    promptAddition: 'a matched pair of eyebrows only, level, nothing else in frame',
  },
  {
    id: 'mouth',
    label: 'Mouth',
    layerOrder: 60,
    frame: { width: 80, height: 40 },
    defaultTransform: { x: 216, y: 164, scale: 1, rotation: 0 },
    promptAddition: 'a mouth only, closed or lightly smiling, no chin, no nose, no face around it',
  },
  {
    id: 'facial-hair',
    label: 'Facial hair',
    layerOrder: 70,
    supportsColorVariants: true,
    frame: { width: 160, height: 130 },
    defaultTransform: { x: 176, y: 130, scale: 1, rotation: 0 },
    promptAddition:
      'facial hair only — beard, moustache, or stubble shape — hollow where the mouth sits, no face behind it',
  },
  {
    id: 'hair',
    label: 'Hair',
    layerOrder: 80,
    supportsColorVariants: true,
    frame: { width: 230, height: 200 },
    defaultTransform: { x: 141, y: 20, scale: 1, rotation: 0 },
    promptAddition:
      'a hairstyle only, hollow underside so it sits over a head, no face, no scalp, no head shape inside it',
  },
  {
    id: 'headwear',
    label: 'Headwear',
    layerOrder: 90,
    frame: { width: 230, height: 150 },
    defaultTransform: { x: 141, y: 6, scale: 1, rotation: 0 },
    promptAddition: 'a hat, cap, or helmet only, empty underneath, no head wearing it',
  },
  {
    id: 'accessory',
    label: 'Accessory',
    layerOrder: 100,
    frame: { width: 180, height: 180 },
    defaultTransform: { x: 166, y: 96, scale: 1, rotation: 0 },
    promptAddition:
      'a single wearable accessory only — glasses, earpiece, badge, or lanyard — nothing wearing it',
  },
]

export const AVATAR_PART_CATEGORY_IDS = AVATAR_PART_CATEGORIES.map((category) => category.id)

export function avatarPartCategory(id: string): AvatarPartCategory | undefined {
  return AVATAR_PART_CATEGORIES.find((category) => category.id === id)
}

/**
 * The house style shared by every part in a tenant's library. The per-category
 * `promptAddition` says what the part *is*; this says how the whole set is
 * drawn, so parts generated months apart still stack into one character.
 */
export const AVATAR_PART_STYLE =
  'flat vector illustration, warm modern palette, clean simple shapes, soft even lighting, bold readable silhouette'
