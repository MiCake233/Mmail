'use strict';

/**
 * Validate a quiet-hours clock value. HTML time inputs submit "HH:MM".
 * Anything else, including hours past 23, falls back so a bad value cannot
 * shift the window by accident.
 */
function normalizeClock(value, fallback) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(value == null ? '' : value));
  if (!match) return fallback;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return fallback;
  return match[1] + ':' + match[2];
}

module.exports = { normalizeClock };
