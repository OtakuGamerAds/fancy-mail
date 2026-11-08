/**
 * "rtl" when most of the letters are Arabic/Hebrew/etc., so Arabic that starts with an
 * English word ("Oh, oh, الله يسلمك…") still reads right to left. A tie goes to the first letter.
 * (From Fancy Dictator.)
 */
export function textDirection(text: string): "rtl" | "ltr" {
  const letters = text.match(/\p{L}/gu) ?? [];
  let rtl = 0;
  for (const letter of letters) if (RTL_LETTER.test(letter)) rtl++;
  const ltr = letters.length - rtl;
  if (rtl !== ltr) return rtl > ltr ? "rtl" : "ltr";
  return letters[0] !== undefined && RTL_LETTER.test(letters[0]) ? "rtl" : "ltr";
}

const RTL_LETTER = /[֐-ࣿיִ-﷿ﹰ-﻿]/u;
