'use strict';

(() => {
  const DENSITY_RAMP = ' ·:-+=*#%@░▒▓█';
  const CONTOUR_RAMP = '·:-=+*#%@';
  const SCRAMBLE_CHARS = '@#$%&*+=-~<>/?01';
  const RAIL_GLYPHS = '░▒▓█*+';
  const CELL_W = 16;
  const CELL_H = 22;
  const MAX_DPR = 2;
  const SCRAMBLE_DURATION_MS = 200;
  const BOOT_ORBIT_MS = 1000;
  const BOOT_THROW_MS = 1200;
  const BOOT_FLICKER_MS = 280;
  const BOOT_TOTAL_MS = BOOT_ORBIT_MS + BOOT_THROW_MS + BOOT_FLICKER_MS;
  const BOOT_FLICKER_STEP_MS = 45;
  const BOOT_GLYPHS = '░▒▓█@#$%&*+=-~<>/?01';

  let bootActive = false;
  let bootController = null;

  const canvas = document.getElementById('ascii-bg');
  const ctx = canvas ? canvas.getContext('2d', { alpha: true }) : null;
  const scrambleTargets = Array.from(document.querySelectorAll('[data-ascii-scramble]'));
  const techNotesDetails = Array.from(document.querySelectorAll('.tech-notes'));
  const textBoxElements = Array.from(document.querySelectorAll('.card, .hero-intro, .hero-meta-row'));
  const textBoxRects = [];

  const state = {
    theme: document.documentElement.getAttribute('data-theme') === 'paper' ? 'paper' : 'terminal',
    width: window.innerWidth,
    height: window.innerHeight,
    cols: 0,
    rows: 0,
    dpr: 1,
    mouseX: -9999,
    mouseY: -9999,
    smoothMouseX: -9999,
    smoothMouseY: -9999,
    lastMouseX: -9999,
    lastMouseY: -9999,
    pointerEnergy: 0,
    rippleRadius: 0,
    scrollY: window.scrollY || 0,
    lastScrollY: window.scrollY || 0,
    scrollVelocity: 0,
    time: 0,
    rafId: 0,
    lastTelemetry: '',
    maxScroll: 1
  };

  function updateMaxScroll() {
    state.maxScroll = Math.max(document.documentElement.scrollHeight - window.innerHeight, 1);
  }

  // Pre-store canonical strings on scramble elements so rapid hovers never corrupt text
  const scrambleTimers = new WeakMap();
  for (const el of scrambleTargets) {
    el.dataset.originalText = el.textContent;
  }

  // Measure monospace glyph width once per style key on an offscreen context (zero DOM reflow)
  const measureCtx = document.createElement('canvas').getContext('2d');
  const cachedCharWidths = Object.create(null);

  function getCharWidth(el, styleKey) {
    if (cachedCharWidths[styleKey] > 0) return cachedCharWidths[styleKey];
    if (!measureCtx) return 7.8;
    const style = window.getComputedStyle(el);
    measureCtx.font = `${style.fontSize} ${style.fontFamily}`;
    const width = Math.max(measureCtx.measureText('M').width, 6);
    cachedCharWidths[styleKey] = width;
    return width;
  }

  // ---------------------------------------------------------------------------
  // Dynamic ASCII Section Dividers & Card Rails
  // ---------------------------------------------------------------------------
  const railEntries = [];
  const sideRailPairs = [];

  function buildDividerBase(label, charCap) {
    const tag = `+══[ ${label} ]`;
    const minCap = tag.length + 2;
    if (charCap <= minCap) {
      return `${tag}+`.slice(0, Math.max(charCap, 16));
    }
    const fillLen = charCap - tag.length - 1;
    return `${tag}${'═'.repeat(fillLen)}+`;
  }

  function buildTopRailBase(label, charCap) {
    const tag = label ? `┌──[ ${label} ]` : '┌──';
    if (charCap <= tag.length + 2) {
      return `${tag}┐`.slice(0, Math.max(charCap, 12));
    }
    const fillLen = charCap - tag.length - 1;
    return `${tag}${'─'.repeat(fillLen)}┐`;
  }

  function buildBottomRailBase(charCap) {
    if (charCap <= 2) return '└┘';
    return `└${'─'.repeat(charCap - 2)}┘`;
  }

  function buildHeaderRuleBase(charCap) {
    if (charCap <= 2) return '══';
    return `+${'═'.repeat(charCap - 2)}+`;
  }

  function initRails() {
    railEntries.length = 0;

    const headerRule = document.querySelector('.ascii-header-rule');
    if (headerRule) {
      railEntries.push({
        el: headerRule,
        kind: 'headerRule',
        styleKey: 'rail',
        label: '',
        protectedPrefixLen: 1,
        baseChars: [],
        chars: [],
        visible: true,
        pageY: 0,
        pageX: 0,
        rectTop: 0,
        rectLeft: 0,
        rectWidth: 0
      });
    }

    const dividers = Array.from(document.querySelectorAll('.ascii-divider'));
    for (const el of dividers) {
      railEntries.push({
        el,
        kind: 'divider',
        styleKey: 'divider',
        label: el.dataset.label || '',
        protectedPrefixLen: (`+══[ ${el.dataset.label || ''} ]`).length,
        baseChars: [],
        chars: [],
        visible: true,
        pageY: 0,
        pageX: 0,
        rectTop: 0,
        rectLeft: 0,
        rectWidth: 0
      });
    }

    sideRailPairs.length = 0;
    const cards = Array.from(document.querySelectorAll('.card'));
    for (const card of cards) {
      const label = card.dataset.railLabel || '';
      const topRail = card.querySelector('.ascii-card-rail-top');
      const bottomRail = card.querySelector('.ascii-card-rail-bottom');
      const cardBody = card.querySelector('.card-body');

      if (cardBody) {
        let frame = card.querySelector('.card-frame');
        let leftSide = card.querySelector('.ascii-card-side-left');
        let rightSide = card.querySelector('.ascii-card-side-right');

        if (!frame) {
          frame = document.createElement('div');
          frame.className = 'card-frame';
          leftSide = document.createElement('div');
          leftSide.className = 'ascii-card-side ascii-card-side-left';
          leftSide.setAttribute('aria-hidden', 'true');
          rightSide = document.createElement('div');
          rightSide.className = 'ascii-card-side ascii-card-side-right';
          rightSide.setAttribute('aria-hidden', 'true');

          card.insertBefore(frame, cardBody);
          frame.appendChild(leftSide);
          frame.appendChild(cardBody);
          frame.appendChild(rightSide);
        }

        sideRailPairs.push({ card, frame, cardBody, leftSide, rightSide });
      }

      if (topRail) {
        const prefixLen = label ? (`┌──[ ${label} ]`).length : 3;
        railEntries.push({
          el: topRail,
          kind: 'top',
          styleKey: 'rail',
          label,
          protectedPrefixLen: prefixLen,
          baseChars: [],
          chars: [],
          visible: true,
          pageY: 0,
          pageX: 0,
          rectTop: 0,
          rectLeft: 0,
          rectWidth: 0
        });
      }

      if (bottomRail) {
        railEntries.push({
          el: bottomRail,
          kind: 'bottom',
          styleKey: 'rail',
          label: '',
          protectedPrefixLen: 1,
          baseChars: [],
          chars: [],
          visible: true,
          pageY: 0,
          pageX: 0,
          rectTop: 0,
          rectLeft: 0,
          rectWidth: 0
        });
      }
    }
  }

  // Batch DOM reads first, cache document-relative offsets, then batch DOM writes
  function measureAndRenderRails() {
    const currentScrollY = window.scrollY || 0;
    const currentScrollX = window.scrollX || 0;
    const measurements = [];

    for (const entry of railEntries) {
      const rect = entry.el.getBoundingClientRect();
      const widthPx = rect.width;
      const charW = widthPx > 0 ? getCharWidth(entry.el, entry.styleKey) : 7.8;
      measurements.push({ entry, rect, widthPx, charW });
    }

    const sideMeasurements = [];
    for (const pair of sideRailPairs) {
      const frameRect = pair.frame.getBoundingClientRect();
      const lineH = parseFloat(getComputedStyle(pair.leftSide).lineHeight) || 15;
      sideMeasurements.push({ pair, heightPx: frameRect.height, lineH });
    }

    for (const { entry, rect, widthPx, charW } of measurements) {
      if (widthPx <= 0) {
        entry.rectWidth = 0;
        continue;
      }
      const charCap = Math.max(Math.floor(widthPx / charW), 16);
      let base = '';
      if (entry.kind === 'divider') {
        base = buildDividerBase(entry.label, charCap);
      } else if (entry.kind === 'headerRule') {
        base = buildHeaderRuleBase(charCap);
      } else if (entry.kind === 'top') {
        base = buildTopRailBase(entry.label, charCap);
      } else {
        base = buildBottomRailBase(charCap);
      }

      entry.baseChars = Array.from(base);
      entry.chars = entry.baseChars.slice();
      entry.pageY = rect.top + currentScrollY;
      entry.pageX = rect.left + currentScrollX;
      entry.rectTop = rect.top;
      entry.rectLeft = rect.left;
      entry.rectWidth = rect.width;
      entry.el.textContent = base;
    }

    for (const { pair, heightPx, lineH } of sideMeasurements) {
      if (heightPx <= 0) continue;
      const rows = Math.max(1, Math.ceil(heightPx / lineH) + 1);
      const wall = Array(rows).fill('│').join('\n');
      pair.leftSide.textContent = wall;
      pair.rightSide.textContent = wall;
    }

    textBoxRects.length = 0;
    for (const boxEl of textBoxElements) {
      const r = boxEl.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      textBoxRects.push({
        pageTop: r.top + currentScrollY,
        pageBottom: r.bottom + currentScrollY,
        left: r.left,
        right: r.right
      });
    }

    updateMaxScroll();
  }

  function refreshRailPositions() {
    const scrollY = state.scrollY;
    for (let i = 0; i < railEntries.length; i++) {
      const entry = railEntries[i];
      if (!entry.visible || entry.rectWidth <= 0) continue;
      entry.rectTop = entry.pageY - scrollY;
      entry.rectLeft = entry.pageX;
    }
  }

  function updateDynamicRails(nowSec) {
    if (bootActive) return;

    const hasPointer = state.smoothMouseX > -500;
    const scrollBoost = Math.min(Math.abs(state.scrollVelocity) * 0.08, 1);

    for (let idx = 0; idx < railEntries.length; idx++) {
      const entry = railEntries[idx];
      if (!entry.visible || entry.rectWidth <= 0 || entry.baseChars.length === 0) continue;

      const len = entry.baseChars.length;
      const start = Math.min(entry.protectedPrefixLen, len - 1);
      const end = len - 1;
      const dy = hasPointer ? Math.abs(state.smoothMouseY - entry.rectTop) : 9999;
      const cursorInRange = hasPointer && dy < 180;
      const cursorRatio = cursorInRange
        ? (state.smoothMouseX - entry.rectLeft) / Math.max(entry.rectWidth, 1)
        : -1;
      const cursorCharIdx = Math.round(cursorRatio * len);

      let changed = false;
      for (let i = 0; i < len; i++) {
        let nextChar = entry.baseChars[i];

        if (i >= start && i < end) {
          if (cursorInRange && cursorRatio >= -0.1 && cursorRatio <= 1.1) {
            const dist = Math.abs(i - cursorCharIdx);
            if (dist < 8) {
              const proximity = (1 - dist / 8) * (1 - dy / 180);
              const wave = Math.sin(i * 0.55 - nowSec * 9 + idx);
              if (proximity > 0.28 || (proximity > 0.14 && wave > 0.25)) {
                const gIdx = Math.min(
                  RAIL_GLYPHS.length - 1,
                  Math.max(0, Math.floor(proximity * RAIL_GLYPHS.length))
                );
                nextChar = RAIL_GLYPHS[gIdx];
              }
            }
          } else if (scrollBoost > 0.18) {
            const pulse = Math.sin(i * 0.35 + nowSec * 12 + idx * 1.7);
            if (pulse > 0.84 - scrollBoost * 0.35) {
              nextChar = entry.kind === 'divider' ? '▓' : '░';
            }
          }
        }

        if (entry.chars[i] !== nextChar) {
          entry.chars[i] = nextChar;
          changed = true;
        }
      }

      if (changed) {
        entry.el.textContent = entry.chars.join('');
      }
    }
  }

  function resetRailsToBaseline() {
    if (bootActive) return;
    for (const entry of railEntries) {
      if (entry.baseChars.length === 0) continue;
      const baseline = entry.baseChars.join('');
      if (entry.el.textContent !== baseline) {
        entry.chars = entry.baseChars.slice();
        entry.el.textContent = baseline;
      }
    }
  }

  // Track rail visibility via IntersectionObserver to skip offscreen updates
  const railMap = new WeakMap();
  let railObserver = null;
  if ('IntersectionObserver' in window) {
    railObserver = new IntersectionObserver(
      (entries) => {
        for (const obs of entries) {
          const item = railMap.get(obs.target);
          if (!item) continue;
          item.visible = obs.isIntersecting;
          if (!bootActive && !obs.isIntersecting && item.baseChars.length > 0) {
            const baseline = item.baseChars.join('');
            if (item.el.textContent !== baseline) {
              item.chars = item.baseChars.slice();
              item.el.textContent = baseline;
            }
          }
        }
      },
      { rootMargin: '120px 0px' }
    );
  }

  // ---------------------------------------------------------------------------
  // Scroll & Hover Text Decryption ([data-ascii-scramble])
  // ---------------------------------------------------------------------------
  function triggerScramble(el, durationMs = SCRAMBLE_DURATION_MS) {
    if (bootActive) return;
    const original = el.dataset.originalText;
    if (!original) return;

    const existing = scrambleTimers.get(el);
    if (existing) {
      cancelAnimationFrame(existing);
      scrambleTimers.delete(el);
    }

    const startTime = performance.now();
    const len = original.length;

    function step(now) {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / durationMs, 1);
      const lockedCount = Math.floor(progress * len);

      if (progress >= 1) {
        el.textContent = original;
        scrambleTimers.delete(el);
        return;
      }

      let out = '';
      for (let i = 0; i < len; i++) {
        const ch = original[i];
        if (i < lockedCount || ch === ' ' || ch === '\n') {
          out += ch;
        } else {
          const randIdx = Math.floor(Math.random() * SCRAMBLE_CHARS.length);
          out += SCRAMBLE_CHARS[randIdx];
        }
      }
      el.textContent = out;
      scrambleTimers.set(el, requestAnimationFrame(step));
    }

    scrambleTimers.set(el, requestAnimationFrame(step));
  }

  function restoreScrambleTargets() {
    for (const el of scrambleTargets) {
      const timerId = scrambleTimers.get(el);
      if (timerId) {
        cancelAnimationFrame(timerId);
        scrambleTimers.delete(el);
      }
      if (el.dataset.originalText && el.textContent !== el.dataset.originalText) {
        el.textContent = el.dataset.originalText;
      }
    }
  }

  for (const el of scrambleTargets) {
    el.addEventListener('mouseenter', () => triggerScramble(el));
  }

  // ---------------------------------------------------------------------------
  // Boot Circle-and-Throw ASCII Assembly Animation
  // ---------------------------------------------------------------------------
  function randomBootGlyph() {
    return BOOT_GLYPHS[(Math.random() * BOOT_GLYPHS.length) | 0];
  }

  function randomGlyphString(len) {
    let out = '';
    for (let i = 0; i < len; i++) {
      out += SCRAMBLE_CHARS[(Math.random() * SCRAMBLE_CHARS.length) | 0];
    }
    return out;
  }

  function collectBootTargets(scheduleFlicker) {
    const viewportBottomCutoff = state.height + 160;
    const particles = [];

    // Phase 1: Read DOM geometry before any mutations
    const heroPre = document.querySelector('.ascii-hero-name pre');
    const heroOriginal = heroPre ? heroPre.textContent : '';
    let heroData = null;

    if (heroPre && heroOriginal) {
      const preRect = heroPre.getBoundingClientRect();
      if (
        preRect.width > 0 &&
        preRect.height > 0 &&
        preRect.top <= viewportBottomCutoff &&
        preRect.bottom >= -40
      ) {
        const heroLines = heroOriginal.split('\n');
        const heroStyle = window.getComputedStyle(heroPre);
        let charW = 7.5;
        if (measureCtx) {
          measureCtx.font = `${heroStyle.fontSize} ${heroStyle.fontFamily}`;
          charW = Math.max(measureCtx.measureText('█').width, 4);
        }
        const lineH = preRect.height / Math.max(heroLines.length, 1);
        heroData = { heroPre, heroOriginal, preRect, heroLines, charW, lineH };
      }
    }

    const railReadList = [];
    for (let i = 0; i < railEntries.length; i++) {
      const entry = railEntries[i];
      if (entry.rectWidth <= 0 || entry.baseChars.length === 0) continue;
      if (entry.rectTop > viewportBottomCutoff || entry.rectTop < -40) continue;
      railReadList.push({
        entry,
        sticky: Boolean(entry.el.closest('.site-header'))
      });
    }

    const sideReadList = [];
    for (let i = 0; i < sideRailPairs.length; i++) {
      const pair = sideRailPairs[i];
      const rows = pair.leftSide.textContent ? pair.leftSide.textContent.split('\n').length : 0;
      if (rows <= 0) continue;
      const leftRect = pair.leftSide.getBoundingClientRect();
      const rightRect = pair.rightSide.getBoundingClientRect();
      if (leftRect.height <= 0 || leftRect.bottom < -40 || leftRect.top > viewportBottomCutoff) {
        continue;
      }
      sideReadList.push({ pair, rows, leftRect, rightRect });
    }

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        const tag = parent.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') {
          return NodeFilter.FILTER_REJECT;
        }
        if (
          parent.closest(
            '.ascii-hero-name, .ascii-card-rail, .ascii-header-rule, .ascii-card-side, .is-hidden'
          )
        ) {
          return NodeFilter.FILTER_REJECT;
        }
        const detailsParent = parent.closest('details');
        if (detailsParent && !detailsParent.open && !parent.closest('summary')) {
          return NodeFilter.FILTER_REJECT;
        }
        if (!node.nodeValue || !node.nodeValue.trim()) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    const textEntries = [];
    let current = walker.nextNode();
    while (current) {
      const parent = current.parentElement;
      const pRect = parent.getBoundingClientRect();
      if (
        pRect.width > 0 &&
        pRect.height > 0 &&
        pRect.top <= viewportBottomCutoff &&
        pRect.bottom >= -40
      ) {
        textEntries.push({
          node: current,
          parent,
          text: current.nodeValue,
          isCompact: Boolean(
            parent.closest('h1, h2, h3, nav, .site-title, .tag, .link-pill, .nav-cta, dt, .subhead, .mono-meta')
          ),
          isAccent: Boolean(
            parent.closest('.site-title, .nav-cta, .link-pill, h2, h3, .subhead, dt, strong')
          ),
          sticky: Boolean(parent.closest('.site-header')),
          chromeParent: parent.closest('.tag, .link-pill, .meta-bar li, .bullet-list li, .tech-notes')
        });
      }
      current = walker.nextNode();
    }

    // Phase 2: Mask DOM content in-place (zero layout reflow)
    let heroMaskedGrid = null;
    const heroState = { dirty: false, rowStrings: null, dirtyRows: null };
    if (heroData) {
      heroMaskedGrid = heroData.heroLines.map((line) =>
        Array.from(line, (ch) => (ch === ' ' || ch === '\r' ? ch : ' '))
      );
      heroState.rowStrings = new Array(heroData.heroLines.length);
      heroState.dirtyRows = new Uint8Array(heroData.heroLines.length);
      for (let r = 0; r < heroData.heroLines.length; r++) {
        heroState.rowStrings[r] = heroMaskedGrid[r].join('');
        const rowChars = Array.from(heroData.heroLines[r]);
        for (let c = 0; c < rowChars.length; c++) {
          const ch = rowChars[c];
          if (ch === ' ' || ch === '\r') continue;
          const tx = Math.min(Math.max(heroData.preRect.left + c * heroData.charW, 4), state.width - 14);
          const ty = heroData.preRect.top + r * heroData.lineH;
          particles.push({
            tx,
            ty,
            char: ch,
            colorBucket: 0,
            sticky: false,
            onLand(nowMs) {
              scheduleFlicker(
                nowMs,
                () => {
                  heroMaskedGrid[r][c] = randomBootGlyph();
                  heroState.dirtyRows[r] = 1;
                  heroState.dirty = true;
                },
                () => {
                  heroMaskedGrid[r][c] = ch;
                  heroState.dirtyRows[r] = 1;
                  heroState.dirty = true;
                }
              );
            }
          });
        }
      }
      heroData.heroPre.textContent = heroState.rowStrings.join('\n');
    }

    const maskedRails = [];
    for (let i = 0; i < railReadList.length; i++) {
      const { entry, sticky } = railReadList[i];
      const len = entry.baseChars.length;
      const charW = entry.rectWidth / len;
      entry.chars = new Array(len).fill(' ');
      entry.bootMasked = true;
      entry.bootDirty = false;
      maskedRails.push(entry);

      for (let k = 0; k < len; k += 2) {
        const kEnd = Math.min(k + 2, len);
        let leadChar = '';
        for (let j = k; j < kEnd; j++) {
          if (entry.baseChars[j] !== ' ') {
            leadChar = entry.baseChars[j];
            break;
          }
        }
        if (!leadChar) {
          for (let j = k; j < kEnd; j++) entry.chars[j] = entry.baseChars[j];
          continue;
        }
        particles.push({
          tx: entry.rectLeft + k * charW,
          ty: entry.rectTop,
          char: leadChar,
          colorBucket: entry.kind === 'divider' || entry.kind === 'headerRule' ? 0 : 1,
          sticky,
          onLand(nowMs) {
            scheduleFlicker(
              nowMs,
              () => {
                for (let j = k; j < kEnd; j++) {
                  entry.chars[j] = entry.baseChars[j] === ' ' ? ' ' : randomBootGlyph();
                }
                entry.bootDirty = true;
              },
              () => {
                for (let j = k; j < kEnd; j++) {
                  entry.chars[j] = entry.baseChars[j];
                }
                entry.bootDirty = true;
              }
            );
          }
        });
      }
      entry.el.textContent = entry.chars.join('');
    }

    const sideMaskState = [];
    for (let i = 0; i < sideReadList.length; i++) {
      const { pair, rows, leftRect, rightRect } = sideReadList[i];
      const lineH = leftRect.height / Math.max(rows, 1);
      const leftArr = new Array(rows).fill(' ');
      const rightArr = new Array(rows).fill(' ');
      const sideItem = { pair, rows, leftArr, rightArr, leftDirty: false, rightDirty: false };
      sideMaskState.push(sideItem);

      for (let r = 0; r < rows; r++) {
        const ty = leftRect.top + r * lineH;
        if (ty < -40 || ty > viewportBottomCutoff) {
          leftArr[r] = '│';
          rightArr[r] = '│';
        } else {
          particles.push({
            tx: leftRect.left,
            ty,
            char: '│',
            colorBucket: 1,
            sticky: false,
            onLand(nowMs) {
              scheduleFlicker(
                nowMs,
                () => {
                  sideItem.leftArr[r] = randomBootGlyph();
                  sideItem.leftDirty = true;
                },
                () => {
                  sideItem.leftArr[r] = '│';
                  sideItem.leftDirty = true;
                }
              );
            }
          });
          particles.push({
            tx: rightRect.left,
            ty,
            char: '│',
            colorBucket: 1,
            sticky: false,
            onLand(nowMs) {
              scheduleFlicker(
                nowMs,
                () => {
                  sideItem.rightArr[r] = randomBootGlyph();
                  sideItem.rightDirty = true;
                },
                () => {
                  sideItem.rightArr[r] = '│';
                  sideItem.rightDirty = true;
                }
              );
            }
          });
        }
      }
      pair.leftSide.textContent = leftArr.join('\n');
      pair.rightSide.textContent = rightArr.join('\n');
    }

    const allSpans = [];
    const mutatedParents = new Set();
    const tokenWrappers = [];
    const settledElements = new Set();

    for (let i = 0; i < textEntries.length; i++) {
      const item = textEntries[i];
      const parts = item.text.split(/(\s+)/);
      const frag = document.createDocumentFragment();

      for (let j = 0; j < parts.length; j++) {
        const part = parts[j];
        if (!part) continue;
        if (/^\s+$/.test(part)) {
          frag.appendChild(document.createTextNode(part));
          continue;
        }
        if (item.isCompact) {
          const chars = Array.from(part);
          for (let c = 0; c < chars.length; c += 3) {
            const chunk = chars.slice(c, c + 3).join('');
            const span = document.createElement('span');
            span.className = 'boot-token-hidden';
            span.textContent = chunk;
            frag.appendChild(span);
            allSpans.push(span);
            tokenWrappers.push({
              span,
              text: chunk,
              char: chars[c],
              colorBucket: item.isAccent ? 0 : 2,
              sticky: item.sticky,
              chromeParent: item.chromeParent
            });
          }
        } else {
          const firstChar = Array.from(part)[0] || '*';
          const span = document.createElement('span');
          span.className = 'boot-token-hidden';
          span.textContent = part;
          frag.appendChild(span);
          allSpans.push(span);
          tokenWrappers.push({
            span,
            text: part,
            char: firstChar,
            colorBucket: item.isAccent ? 0 : 2,
            sticky: item.sticky,
            chromeParent: item.chromeParent
          });
        }
      }

      if (item.node.parentNode) {
        item.node.parentNode.replaceChild(frag, item.node);
        mutatedParents.add(item.parent);
      }
    }

    // Phase 3: Batched read of wrapped token bounding rects (Zero layout thrashing)
    const culledTokens = [];
    for (let i = 0; i < tokenWrappers.length; i++) {
      const tok = tokenWrappers[i];
      const rect = tok.span.getBoundingClientRect();
      if (rect.width <= 0 || rect.top > viewportBottomCutoff || rect.bottom < -40) {
        culledTokens.push(tok);
        continue;
      }
      const glyphLen = Array.from(tok.text).length;
      particles.push({
        tx: rect.left,
        ty: rect.top,
        char: tok.char,
        colorBucket: tok.colorBucket,
        sticky: tok.sticky,
        onLand(nowMs) {
          tok.span.classList.remove('boot-token-hidden');
          if (tok.chromeParent) {
            tok.chromeParent.classList.add('boot-settled');
            settledElements.add(tok.chromeParent);
          }
          scheduleFlicker(
            nowMs,
            () => {
              tok.span.textContent = randomGlyphString(glyphLen);
            },
            () => {
              tok.span.textContent = tok.text;
            }
          );
        }
      });
    }

    // Phase 4: Batch DOM writes for culled out-of-viewport tokens
    for (let i = 0; i < culledTokens.length; i++) {
      const tok = culledTokens[i];
      tok.span.classList.remove('boot-token-hidden');
      if (tok.chromeParent) {
        tok.chromeParent.classList.add('boot-settled');
        settledElements.add(tok.chromeParent);
      }
    }

    return {
      particles,
      heroData,
      heroMaskedGrid,
      heroState,
      maskedRails,
      sideMaskState,
      allSpans,
      mutatedParents,
      settledElements
    };
  }

  function runCircleThrowBoot() {
    if (document.hidden) {
      return null;
    }

    bootActive = true;
    document.body.classList.add('boot-assembling');

    const bootCanvas = document.createElement('canvas');
    bootCanvas.className = 'ascii-boot-canvas';
    bootCanvas.setAttribute('aria-hidden', 'true');
    document.body.appendChild(bootCanvas);

    const bootCtx = bootCanvas.getContext('2d', { alpha: true });
    if (!bootCtx) {
      bootCanvas.remove();
      document.body.classList.remove('boot-assembling');
      bootActive = false;
      return null;
    }

    bootCanvas.width = Math.floor(state.width * state.dpr);
    bootCanvas.height = Math.floor(state.height * state.dpr);
    bootCtx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
    bootCtx.font = '13px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';
    bootCtx.textBaseline = 'top';

    const activeFlickers = [];
    function scheduleFlicker(nowMs, stepFn, restoreFn) {
      stepFn();
      activeFlickers.push({
        startMs: nowMs,
        lastSwapMs: nowMs,
        step: stepFn,
        restore: restoreFn
      });
    }

    const targets = collectBootTargets(scheduleFlicker);
    const {
      particles,
      heroData,
      heroMaskedGrid,
      heroState,
      maskedRails,
      sideMaskState,
      allSpans,
      mutatedParents,
      settledElements
    } = targets;

    let bootFinished = false;
    let bootRafId = 0;

    function finish() {
      if (bootFinished) return;
      bootFinished = true;
      if (bootRafId) {
        cancelAnimationFrame(bootRafId);
        bootRafId = 0;
      }

      for (let i = 0; i < activeFlickers.length; i++) {
        activeFlickers[i].restore();
      }
      activeFlickers.length = 0;

      if (heroData && heroData.heroPre) {
        heroData.heroPre.textContent = heroData.heroOriginal;
      }
      for (let i = 0; i < maskedRails.length; i++) {
        const entry = maskedRails[i];
        entry.chars = entry.baseChars.slice();
        entry.el.textContent = entry.baseChars.join('');
        entry.bootMasked = false;
        entry.bootDirty = false;
      }
      for (let i = 0; i < sideMaskState.length; i++) {
        const s = sideMaskState[i];
        const wall = Array(s.rows).fill('│').join('\n');
        s.pair.leftSide.textContent = wall;
        s.pair.rightSide.textContent = wall;
      }
      for (let i = 0; i < allSpans.length; i++) {
        const span = allSpans[i];
        const parent = span.parentNode;
        if (!parent) continue;
        while (span.firstChild) {
          parent.insertBefore(span.firstChild, span);
        }
        parent.removeChild(span);
      }
      for (const p of mutatedParents) {
        p.normalize();
      }
      for (const el of settledElements) {
        el.classList.remove('boot-settled');
      }

      if (bootCanvas.parentNode) {
        bootCanvas.parentNode.removeChild(bootCanvas);
      }
      document.body.classList.remove('boot-assembling');
      bootActive = false;
      bootController = null;
    }

    if (particles.length === 0) {
      finish();
      return null;
    }

    // Cap active boot particles uniformly while preserving synchronized reveal
    const MAX_BOOT_PARTICLES = 450;
    if (particles.length > MAX_BOOT_PARTICLES) {
      const budgeted = [];
      const step = particles.length / MAX_BOOT_PARTICLES;
      let nextPick = 0;
      for (let i = 0; i < particles.length; i++) {
        if (i >= nextPick && budgeted.length < MAX_BOOT_PARTICLES) {
          budgeted.push(particles[i]);
          nextPick += step;
        } else {
          const host = budgeted[budgeted.length - 1];
          if (!host.extraLands) host.extraLands = [];
          host.extraLands.push(particles[i].onLand);
        }
      }
      particles.length = 0;
      particles.push(...budgeted);
    }

    const cx = state.width * 0.5;
    const cy = state.height * 0.5;
    const minDim = Math.min(state.width, state.height);
    const total = particles.length;
    const bootInitialScrollY = state.scrollY;

    for (let idx = 0; idx < total; idx++) {
      const p = particles[idx];
      const dx = p.tx - cx;
      const dy = p.ty - cy;
      const targetDist = Math.hypot(dx, dy);
      const targetAngle = Math.atan2(dy, dx);
      const band = idx % 3;
      const jitterA = ((idx * 1.6180339) % 1) - 0.5;
      const jitterB = ((idx * 2.7182818) % 1) - 0.5;
      const jitterC = ((idx * 3.1415926) % 1) * 35;
      const ratio = total > 1 ? idx / (total - 1) : 0;

      p.band = band;
      p.targetDist = targetDist;
      p.ringRadius = Math.max(28, minDim * (0.075 + band * 0.045) + jitterA * 14);
      p.omega = 3.5 + band * 0.55 + jitterB * 0.45;
      p.theta0 = targetAngle - 3.9 + jitterA * 0.45;
      p.launchMs = BOOT_ORBIT_MS + ratio * 460 + jitterC;
      p.flightMs = 560 + Math.min(targetDist * 0.16, 130);
      p.glyphPeriod = 50 + (idx % 5) * 11;
      p.launched = false;
      p.landed = false;
      p.startX = 0;
      p.startY = 0;
      p.ctrlX = 0;
      p.ctrlY = 0;
    }

    const palette = getPalette();
    const bucketColors = [
      `rgba(${palette.accentRgb}, 0.96)`,
      `rgba(${palette.amberRgb}, 0.92)`,
      state.theme === 'paper' ? 'rgba(15, 23, 42, 0.90)' : 'rgba(226, 240, 255, 0.92)'
    ];
    const bucketX = [new Float32Array(total), new Float32Array(total), new Float32Array(total)];
    const bucketY = [new Float32Array(total), new Float32Array(total), new Float32Array(total)];
    const bucketChars = [new Array(total), new Array(total), new Array(total)];
    const bucketCounts = [0, 0, 0];
    const bootStartTime = performance.now();

    function stepBoot(nowMs) {
      if (bootFinished) return;
      const elapsed = nowMs - bootStartTime;
      const scrollDelta = state.scrollY - bootInitialScrollY;

      bootCtx.clearRect(0, 0, state.width, state.height);
      bucketCounts[0] = 0;
      bucketCounts[1] = 0;
      bucketCounts[2] = 0;

      let activeCount = 0;
      const tSec = elapsed / 1000;

      for (let idx = 0; idx < total; idx++) {
        const p = particles[idx];
        if (p.landed) continue;

        let drawX = 0;
        let drawY = 0;
        let ch = '';

        if (elapsed < p.launchMs) {
          const theta = p.theta0 + p.omega * tSec + 0.35 * tSec * tSec;
          const r = p.ringRadius * (1 + 0.06 * Math.sin(tSec * 6 + p.band));
          drawX = cx + Math.cos(theta) * r;
          drawY = cy + Math.sin(theta) * r;
          const glyphStep = Math.floor(elapsed / p.glyphPeriod) + idx * 7;
          ch = BOOT_GLYPHS[glyphStep % BOOT_GLYPHS.length];
          activeCount++;
        } else {
          if (!p.launched) {
            const tLaunchSec = p.launchMs / 1000;
            const thetaL = p.theta0 + p.omega * tLaunchSec + 0.35 * tLaunchSec * tLaunchSec;
            const rL = p.ringRadius * (1 + 0.06 * Math.sin(tLaunchSec * 6 + p.band));
            const cosL = Math.cos(thetaL);
            const sinL = Math.sin(thetaL);
            p.startX = cx + cosL * rL;
            p.startY = cy + sinL * rL;
            const bend = Math.min(p.targetDist * 0.38, 160);
            p.ctrlX = p.startX + (-sinL * 0.85 + cosL * 0.35) * bend;
            p.ctrlY = p.startY + (cosL * 0.85 + sinL * 0.35) * bend;
            p.launched = true;
          }

          const rawP = (elapsed - p.launchMs) / p.flightMs;
          if (rawP >= 1) {
            p.landed = true;
            p.onLand(nowMs);
            if (p.extraLands) {
              for (let k = 0; k < p.extraLands.length; k++) {
                p.extraLands[k](nowMs);
              }
            }
            continue;
          }

          const u = 1 - Math.pow(1 - rawP, 3);
          const oneMinusU = 1 - u;
          const destY = p.sticky ? p.ty : p.ty - scrollDelta;
          drawX = oneMinusU * oneMinusU * p.startX + 2 * oneMinusU * u * p.ctrlX + u * u * p.tx;
          drawY = oneMinusU * oneMinusU * p.startY + 2 * oneMinusU * u * p.ctrlY + u * u * destY;

          if (rawP >= 0.68) {
            ch = p.char;
          } else {
            const glyphStep = Math.floor(elapsed / p.glyphPeriod) + idx * 7;
            ch = BOOT_GLYPHS[glyphStep % BOOT_GLYPHS.length];
          }
          activeCount++;
        }

        const bIdx = p.colorBucket;
        const slot = bucketCounts[bIdx]++;
        bucketX[bIdx][slot] = drawX;
        bucketY[bIdx][slot] = drawY;
        bucketChars[bIdx][slot] = ch;
      }

      for (let i = activeFlickers.length - 1; i >= 0; i--) {
        const f = activeFlickers[i];
        if (nowMs - f.startMs >= BOOT_FLICKER_MS) {
          f.restore();
          const last = activeFlickers.length - 1;
          if (i !== last) activeFlickers[i] = activeFlickers[last];
          activeFlickers.pop();
        } else if (nowMs - f.lastSwapMs >= BOOT_FLICKER_STEP_MS) {
          f.lastSwapMs = nowMs;
          f.step();
        }
      }

      if (heroState.dirty && heroData) {
        for (let r = 0; r < heroMaskedGrid.length; r++) {
          if (heroState.dirtyRows[r]) {
            heroState.rowStrings[r] = heroMaskedGrid[r].join('');
            heroState.dirtyRows[r] = 0;
          }
        }
        heroData.heroPre.textContent = heroState.rowStrings.join('\n');
        heroState.dirty = false;
      }
      for (let i = 0; i < maskedRails.length; i++) {
        const entry = maskedRails[i];
        if (entry.bootDirty) {
          entry.el.textContent = entry.chars.join('');
          entry.bootDirty = false;
        }
      }
      for (let i = 0; i < sideMaskState.length; i++) {
        const s = sideMaskState[i];
        if (s.leftDirty) {
          s.pair.leftSide.textContent = s.leftArr.join('\n');
          s.leftDirty = false;
        }
        if (s.rightDirty) {
          s.pair.rightSide.textContent = s.rightArr.join('\n');
          s.rightDirty = false;
        }
      }

      for (let b = 0; b < 3; b++) {
        const count = bucketCounts[b];
        if (count === 0) continue;
        bootCtx.fillStyle = bucketColors[b];
        const xs = bucketX[b];
        const ys = bucketY[b];
        const chars = bucketChars[b];
        for (let i = 0; i < count; i++) {
          bootCtx.fillText(chars[i], xs[i], ys[i]);
        }
      }

      if ((activeCount === 0 && activeFlickers.length === 0) || elapsed >= BOOT_TOTAL_MS) {
        finish();
        return;
      }

      bootRafId = requestAnimationFrame(stepBoot);
    }

    bootRafId = requestAnimationFrame(stepBoot);
    return { finish };
  }

  // ---------------------------------------------------------------------------
  // Background Cursor + Scroll Reactive ASCII Field (#ascii-bg)
  // ---------------------------------------------------------------------------
  function getPalette() {
    if (state.theme === 'paper') {
      return {
        baseRgb: '71, 85, 105',
        accentRgb: '29, 78, 216',
        amberRgb: '2, 132, 199',
        cyanRgb: '79, 70, 229',
        baseAlpha: 0.07
      };
    }
    return {
      baseRgb: '139, 163, 199',
      accentRgb: '56, 189, 248',
      amberRgb: '96, 165, 250',
      cyanRgb: '129, 140, 248',
      baseAlpha: 0.08
    };
  }

  let cachedPaletteTheme = '';
  let cachedBaseLut = [];

  function getBasePaletteLut(palette) {
    if (cachedPaletteTheme === state.theme && cachedBaseLut.length > 0) {
      return cachedBaseLut;
    }
    cachedPaletteTheme = state.theme;
    cachedBaseLut = [];
    const rampLen = DENSITY_RAMP.length;
    for (let i = 0; i < rampLen; i++) {
      const clamped = i / (rampLen - 1);
      const alpha = (palette.baseAlpha + clamped * 0.12).toFixed(3);
      cachedBaseLut.push(`rgba(${palette.baseRgb}, ${alpha})`);
    }
    return cachedBaseLut;
  }

  function resizeCanvas() {
    if (!canvas || !ctx) return;
    state.width = window.innerWidth;
    state.height = window.innerHeight;
    state.dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);

    canvas.width = Math.floor(state.width * state.dpr);
    canvas.height = Math.floor(state.height * state.dpr);

    ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
    ctx.font = '13px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';
    ctx.textBaseline = 'top';

    state.cols = Math.ceil(state.width / CELL_W) + 1;
    state.rows = Math.ceil(state.height / CELL_H) + 1;
  }

  function isInsideTextBox(x, y, scrollY) {
    for (let i = 0; i < textBoxRects.length; i++) {
      const b = textBoxRects[i];
      if (x >= b.left && x <= b.right && y >= b.pageTop - scrollY && y <= b.pageBottom - scrollY) {
        return true;
      }
    }
    return false;
  }

  function drawBackgroundFrame(nowSec, isCalmStatic) {
    if (!canvas || !ctx) return;
    ctx.clearRect(0, 0, state.width, state.height);

    const palette = getPalette();
    const baseLut = getBasePaletteLut(palette);
    const scrollBoost = isCalmStatic ? 0 : Math.min(Math.abs(state.scrollVelocity) * 0.025, 0.85);
    const hasPointer = !isCalmStatic && state.smoothMouseX > -500;
    const radiusPx = 220;
    const radiusSq = radiusPx * radiusPx;
    const invRadius = 1 / radiusPx;
    const contourLevels = 7;
    const timeDriftA = nowSec * 0.18;
    const timeDriftB = nowSec * 0.14;
    let currentFillStyle = '';

    for (let row = 0; row < state.rows; row++) {
      const y = row * CELL_H;
      const wy = (y + state.scrollY) * 0.0085;
      const dy = hasPointer ? y - state.smoothMouseY : 9999;
      const rowNearPointer = hasPointer && Math.abs(dy) < radiusPx;
      const dySq = rowNearPointer ? dy * dy : 0;

      for (let col = 0; col < state.cols; col++) {
        const x = col * CELL_W;
        const wx = x * 0.0085;

        // Continuous 2D topographic elevation field in world coordinates
        const ridgeA = Math.sin(wx + timeDriftA) * Math.cos(wy - timeDriftB);
        const ridgeB = 0.5 * Math.sin(wx * 1.85 - wy * 1.35 + nowSec * 0.24);
        let elevation = (ridgeA + ridgeB + 1.5) / 3.0; // normalized ~[0, 1]

        let cursorInfluence = 0;
        let rippleInfluence = 0;
        const behindBox = isInsideTextBox(x, y, state.scrollY);
        const cursorScale = behindBox ? 0.22 : 1;

        if (rowNearPointer) {
          const dx = x - state.smoothMouseX;
          const distSq = dx * dx + dySq;

          if (distSq < radiusSq) {
            const dist = Math.sqrt(distSq);
            cursorInfluence = Math.pow(1 - dist * invRadius, 1.6) * cursorScale;
            elevation += cursorInfluence * (0.48 + state.pointerEnergy * 0.25);

            if (state.pointerEnergy > 0.05) {
              const ringDist = Math.abs(dist - state.rippleRadius);
              if (ringDist < 36) {
                rippleInfluence = (1 - ringDist / 36) * state.pointerEnergy * cursorScale;
                elevation += rippleInfluence * 0.32;
              }
            }
          }
        }

        if (scrollBoost > 0.08) {
          elevation += scrollBoost * 0.14 * Math.sin(wy * 2.5 - nowSec * 3);
        }

        const clamped = elevation > 1 ? 1 : (elevation < 0 ? 0 : elevation);
        const scaled = clamped * contourLevels;
        const band = Math.floor(scaled);
        const frac = scaled - band;
        const onContourLine = frac < 0.24;

        let ch = ' ';
        let targetFill = '';

        if (onContourLine) {
          const cIdx = Math.min(CONTOUR_RAMP.length - 1, Math.max(1, band + 1));
          ch = CONTOUR_RAMP[cIdx];

          if (rippleInfluence > 0.2) {
            targetFill = `rgba(${palette.amberRgb}, ${(0.24 + rippleInfluence * 0.5).toFixed(3)})`;
          } else if (cursorInfluence > 0.14) {
            targetFill = `rgba(${palette.accentRgb}, ${(0.20 + cursorInfluence * 0.52).toFixed(3)})`;
          } else if (scrollBoost > 0.2) {
            targetFill = `rgba(${palette.cyanRgb}, ${(0.16 + scrollBoost * 0.26).toFixed(3)})`;
          } else {
            const baseIdx = Math.min(DENSITY_RAMP.length - 1, Math.max(2, band + 2));
            targetFill = baseLut[baseIdx];
          }
        } else {
          if (clamped < 0.28) continue;
          ch = clamped > 0.62 ? ':' : '·';
          targetFill = baseLut[1];
        }

        if (targetFill !== currentFillStyle) {
          ctx.fillStyle = targetFill;
          currentFillStyle = targetFill;
        }

        ctx.fillText(ch, x, y);
      }
    }
  }

  // Keep cached page offsets & maxScroll synced when <details> accordions expand/collapse
  for (const detailsEl of techNotesDetails) {
    detailsEl.addEventListener('toggle', () => {
      if (bootController) bootController.finish();
      measureAndRenderRails();
    });
  }

  // ---------------------------------------------------------------------------
  // Main Animation Loop & Input Listeners
  // ---------------------------------------------------------------------------
  let lastFrameMs = performance.now();

  function tick(nowMs) {
    if (document.hidden) {
      state.rafId = 0;
      return;
    }

    const dt = Math.min((nowMs - lastFrameMs) / 1000, 0.05);
    lastFrameMs = nowMs;
    state.time += dt;

    if (state.mouseX > -500) {
      if (state.smoothMouseX < -500) {
        state.smoothMouseX = state.mouseX;
        state.smoothMouseY = state.mouseY;
      } else {
        state.smoothMouseX += (state.mouseX - state.smoothMouseX) * 0.28;
        state.smoothMouseY += (state.mouseY - state.smoothMouseY) * 0.28;
      }
    }

    state.pointerEnergy = Math.max(0, state.pointerEnergy - dt * 1.45);
    state.rippleRadius = (state.rippleRadius + dt * 210) % 195;
    state.scrollVelocity *= 0.86;
    if (Math.abs(state.scrollVelocity) < 0.05) state.scrollVelocity = 0;

    if (!bootActive) {
      drawBackgroundFrame(state.time, false);
      updateDynamicRails(state.time);
    }

    state.rafId = requestAnimationFrame(tick);
  }

  function startLoop() {
    if (document.hidden || state.rafId) return;
    lastFrameMs = performance.now();
    state.rafId = requestAnimationFrame(tick);
  }

  function stopLoop() {
    if (state.rafId) {
      cancelAnimationFrame(state.rafId);
      state.rafId = 0;
    }
  }

  window.addEventListener(
    'pointermove',
    (e) => {
      state.mouseX = e.clientX;
      state.mouseY = e.clientY;
      if (state.lastMouseX > -500) {
        const dx = e.clientX - state.lastMouseX;
        const dy = e.clientY - state.lastMouseY;
        const speed = Math.hypot(dx, dy);
        if (speed > 4) {
          state.pointerEnergy = Math.min(1, state.pointerEnergy + speed * 0.012);
        }
      }
      state.lastMouseX = e.clientX;
      state.lastMouseY = e.clientY;
    },
    { passive: true }
  );

  window.addEventListener(
    'pointerleave',
    () => {
      state.mouseX = -9999;
      state.mouseY = -9999;
      state.smoothMouseX = -9999;
      state.smoothMouseY = -9999;
      state.pointerEnergy = 0;
      resetRailsToBaseline();
    },
    { passive: true }
  );

  window.addEventListener(
    'scroll',
    () => {
      const currentY = window.scrollY || 0;
      const delta = currentY - state.lastScrollY;
      state.scrollY = currentY;
      state.lastScrollY = currentY;
      state.scrollVelocity = Math.max(-60, Math.min(60, state.scrollVelocity + delta * 0.45));
      refreshRailPositions();
    },
    { passive: true }
  );

  let resizeTimer = 0;
  window.addEventListener(
    'resize',
    () => {
      clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        if (bootController) bootController.finish();
        delete cachedCharWidths.divider;
        delete cachedCharWidths.rail;
        resizeCanvas();
        measureAndRenderRails();
      }, 120);
    },
    { passive: true }
  );

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (bootController) bootController.finish();
      restoreScrambleTargets();
      stopLoop();
    } else {
      startLoop();
    }
  });

  window.addEventListener('beforeprint', () => {
    if (bootController) bootController.finish();
    restoreScrambleTargets();
  });

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------
  initRails();
  for (const entry of railEntries) {
    railMap.set(entry.el, entry);
    if (railObserver) {
      railObserver.observe(entry.el);
    }
  }
  resizeCanvas();
  measureAndRenderRails();
  bootController = runCircleThrowBoot();
  startLoop();
})();
