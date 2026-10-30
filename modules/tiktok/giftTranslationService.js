const giftTranslations = new Map([
  ['rose', 'Rosa'],
  ['tiktok universe', 'Universo de TikTok'],
  ['universe', 'Universo'],
  ['finger heart', 'Corazón con los dedos'],
  ['hand heart', 'Corazón con la mano'],
  ['love you', 'Te quiero'],
  ['love balloon', 'Globo de amor'],
  ['sunglasses', 'Gafas de sol'],
  ['doughnut', 'Dona'],
  ['donut', 'Dona'],
  ['money gun', 'Pistola de dinero'],
  ['whale diving', 'Ballena saltarina'],
  ['fireworks', 'Fuegos artificiales'],
  ['confetti', 'Confeti'],
  ['bouquet', 'Ramo'],
  ['ice cream', 'Helado'],
  ['football', 'Balón de fútbol'],
  ['swan', 'Cisne'],
  ['lion', 'León'],
  ['galaxy', 'Galaxia'],
  ['perfume', 'Perfume'],
  ['cap', 'Gorra'],
  ['heart', 'Corazón'],
  ['star', 'Estrella'],
]);

function normalizeGiftName(name) {
  return String(name || '').trim().normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase();
}

function translateGiftName(name) {
  const original = String(name || '').trim();
  if (!original) return '';
  return giftTranslations.get(normalizeGiftName(original)) || original;
}

module.exports = { translateGiftName };