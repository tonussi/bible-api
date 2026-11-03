const textSimilarity = require('text-similarity-node')

const WORD_PATTERN = /[\p{L}\p{M}\p{N}]+/gu
const DIACRITIC_PATTERN = /\p{M}/gu

function normalizeWord(word) {
  return word
    .normalize('NFD')
    .replace(DIACRITIC_PATTERN, '')
    .toLocaleLowerCase('el')
}

/**
 * Tokenize text into words, removing punctuation.
 * Handles Unicode letters, combining marks, and digits.
 * @param {string} text
 * @returns {string[]}
 */
function tokenize(text) {
  if (!text) return []
  return (text.match(WORD_PATTERN) || []).map((word) =>
    word.toLocaleLowerCase('el')
  )
}

function wordsAreEqual(word1, word2) {
  return normalizeWord(word1) === normalizeWord(word2)
}

function selectNonOverlappingMatches(matches) {
  const selected = []
  const usedWords1 = new Set()
  const usedWords2 = new Set()
  const candidates = [...matches].sort(
    (a, b) => b.length - a.length || a.start1 - b.start1 || a.start2 - b.start2
  )

  for (const match of candidates) {
    const overlapsFirst = Array.from(
      { length: match.length },
      (_, offset) => match.start1 + offset
    ).some((index) => usedWords1.has(index))
    const overlapsSecond = Array.from(
      { length: match.length },
      (_, offset) => match.start2 + offset
    ).some((index) => usedWords2.has(index))

    if (overlapsFirst || overlapsSecond) continue

    selected.push(match)
    for (let offset = 0; offset < match.length; offset++) {
      usedWords1.add(match.start1 + offset)
      usedWords2.add(match.start2 + offset)
    }
  }

  return selected.sort((a, b) => a.start1 - b.start1 || a.start2 - b.start2)
}

/**
 * Build a word-to-verse mapping for tracking verse references.
 * @param {Array<{verse: number, text: string}>} verses
 * @returns {{word: string, verse: number, wordIdx: number}[]}
 */
function buildVerseWordMap(verses) {
  const result = []
  let wordIdx = 0
  verses.forEach((v) => {
    const words = tokenize(v.text)
    words.forEach((w) => {
      result.push({
        word: w,
        book: v.book || v.verse_book,
        chapter: v.chapter || v.verse_chapter,
        verse: v.verse,
        wordIdx: wordIdx++,
      })
    })
  })
  return result
}

/**
 * Find verse reference for a word position.
 * @param {Array} verseWordMap
 * @param {number} wordIdx
 * @returns {Object} {book, chapter, verse}
 */
function getVerseAtWordIdx(verseWordMap, wordIdx) {
  let ref = { book: null, chapter: null, verse: 1 }
  for (let i = verseWordMap.length - 1; i >= 0; i--) {
    if (verseWordMap[i].wordIdx <= wordIdx) {
      ref = {
        book: verseWordMap[i].book,
        chapter: verseWordMap[i].chapter,
        verse: verseWordMap[i].verse,
      }
      break
    }
  }
  return ref
}

/**
 * Check if two words are similar using text-similarity-node's native
 * Levenshtein similarity (0–1 score).
 * For very short words (≤3 chars), requires at most 1 edit distance.
 * @param {string} word1
 * @param {string} word2
 * @param {number} threshold - minimum similarity ratio (default 0.8, i.e. 1 - 0.2)
 * @returns {{isSimilar: boolean, similarity: number}}
 */
function areSimilar(word1, word2, threshold = 0.8) {
  const normalizedWord1 = normalizeWord(word1)
  const normalizedWord2 = normalizeWord(word2)

  if (normalizedWord1 === normalizedWord2) {
    return { isSimilar: true, similarity: 1 }
  }

  const maxLen = Math.max(normalizedWord1.length, normalizedWord2.length)
  if (maxLen === 0) return { isSimilar: true, similarity: 1 }

  // For very short words, be stricter — at most 1 edit
  if (maxLen <= 3) {
    const dist = textSimilarity.distance.levenshtein(
      normalizedWord1,
      normalizedWord2,
      true
    )
    return {
      isSimilar: dist <= 1,
      similarity: maxLen === 0 ? 1 : 1 - dist / maxLen,
    }
  }

  // Use native Levenshtein similarity (returns 0–1)
  const sim = textSimilarity.similarity.levenshtein(
    normalizedWord1,
    normalizedWord2,
    true
  )
  return {
    isSimilar: sim >= threshold,
    similarity: sim,
  }
}

/**
 * Find all sequences of N consecutive identical words between two texts (exact mode).
 * @param {string[]} words1
 * @param {string[]} words2
 * @param {number} minLength
 * @param {Array} verseWordMap1
 * @param {Array} verseWordMap2
 * @returns {Array<{words: string[], length: number, start1: number, start2: number, verse1: number, verse2: number}>}
 */
function findMatchingSequences(
  words1,
  words2,
  minLength = 3,
  verseWordMap1 = [],
  verseWordMap2 = []
) {
  const matches = []

  if (words1.length < minLength || words2.length < minLength) {
    return matches
  }

  for (let i = 0; i <= words1.length - minLength; i++) {
    for (let j = 0; j <= words2.length - minLength; j++) {
      if (
        i > 0 &&
        j > 0 &&
        wordsAreEqual(words1[i - 1], words2[j - 1])
      ) {
        continue
      }

      let matchLen = 0
      while (
        i + matchLen < words1.length &&
        j + matchLen < words2.length &&
        wordsAreEqual(words1[i + matchLen], words2[j + matchLen])
      ) {
        matchLen++
      }

      if (matchLen >= minLength) {
        const ref1 = getVerseAtWordIdx(verseWordMap1, i)
        const ref2 = getVerseAtWordIdx(verseWordMap2, j)
        matches.push({
          words: words1.slice(i, i + matchLen),
          length: matchLen,
          start1: i,
          start2: j,
          book1: ref1.book,
          chapter1: ref1.chapter,
          verse1: ref1.verse,
          book2: ref2.book,
          chapter2: ref2.chapter,
          verse2: ref2.verse,
        })
      }
    }
  }

  return selectNonOverlappingMatches(matches)
}

/**
 * Find all sequences of N consecutive similar words between two texts (relaxed mode).
 * Uses text-similarity-node for native C++ Levenshtein similarity per word pair.
 * @param {string[]} words1
 * @param {string[]} words2
 * @param {number} minLength
 * @param {Array} verseWordMap1
 * @param {Array} verseWordMap2
 * @param {number} similarityThreshold - minimum similarity ratio (0–1, default 0.8)
 * @returns {Array<{words: string[], words2: string[], length: number, start1: number, start2: number, verse1: number, verse2: number, similarity: number}>}
 */
function findRelaxedMatchingSequences(
  words1,
  words2,
  minLength = 3,
  verseWordMap1 = [],
  verseWordMap2 = [],
  similarityThreshold = 0.8
) {
  const matches = []

  if (words1.length < minLength || words2.length < minLength) {
    return matches
  }

  for (let i = 0; i <= words1.length - minLength; i++) {
    for (let j = 0; j <= words2.length - minLength; j++) {
      if (
        i > 0 &&
        j > 0 &&
        areSimilar(words1[i - 1], words2[j - 1], similarityThreshold)
          .isSimilar
      ) {
        continue
      }

      let matchLen = 0
      let totalSimilarity = 0

      while (i + matchLen < words1.length && j + matchLen < words2.length) {
        const w1 = words1[i + matchLen]
        const w2 = words2[j + matchLen]
        const { isSimilar, similarity } = areSimilar(
          w1,
          w2,
          similarityThreshold
        )

        if (isSimilar) {
          totalSimilarity += similarity
          matchLen++
        } else {
          break
        }
      }

      if (matchLen >= minLength) {
        const avgSimilarity = totalSimilarity / matchLen
        const ref1 = getVerseAtWordIdx(verseWordMap1, i)
        const ref2 = getVerseAtWordIdx(verseWordMap2, j)
        matches.push({
          words: words1.slice(i, i + matchLen),
          words2: words2.slice(j, j + matchLen),
          length: matchLen,
          start1: i,
          start2: j,
          book1: ref1.book,
          chapter1: ref1.chapter,
          verse1: ref1.verse,
          book2: ref2.book,
          chapter2: ref2.chapter,
          verse2: ref2.verse,
          similarity: Math.round(avgSimilarity * 100),
        })
      }
    }
  }

  return selectNonOverlappingMatches(matches)
}

/**
 * Compute word-sequence statistics across gospel comparison pairs.
 *
 * @param {Object} gospelsWithVerses - { matthew: {text, verses}, mark: {text, verses}, ... }
 * @param {number} minLength - minimum sequence length (default 3)
 * @param {string} mode - 'exact' or 'relaxed'
 * @param {number} similarityThreshold - for relaxed mode, max edit distance ratio (0–1, default 0.2)
 * @returns {Object} statistics matching the output schema documented above
 */
function computeStatistics(
  gospelsWithVerses,
  minLength = 3,
  mode = 'exact',
  similarityThreshold = 0.2
) {
  // Convert the threshold: the caller sends the *distance* ratio (e.g. 0.2 = 20% edits allowed).
  // areSimilar expects a *similarity* threshold (e.g. 0.8).
  const simThreshold = 1 - similarityThreshold

  const gospelList = ['matthew', 'mark', 'luke', 'john'].filter(
    (g) => gospelsWithVerses[g]
  )
  const tokenized = {}
  const verseWordMaps = {}

  gospelList.forEach((g) => {
    const gData = gospelsWithVerses[g]
    const text = typeof gData === 'string' ? gData : gData?.text || ''
    const verses =
      typeof gData === 'object' && Array.isArray(gData?.verses)
        ? gData.verses
        : []
    tokenized[g] = tokenize(text)
    verseWordMaps[g] = buildVerseWordMap(verses)
  })

  const statistics = {
    totalWords: {},
    summary: {
      totalMatches: 0,
      totalMatchingWords: 0,
      uniqueSequences: [],
    },
    pairs: {},
    mode: mode,
  }

  gospelList.forEach((g) => {
    statistics.totalWords[g] = tokenized[g].length
  })

  // Compare every gospel pair
  for (let i = 0; i < gospelList.length; i++) {
    for (let j = i + 1; j < gospelList.length; j++) {
      const g1 = gospelList[i]
      const g2 = gospelList[j]
      const pairKey = `${g1}-${g2}`

      const matches =
        mode === 'relaxed'
          ? findRelaxedMatchingSequences(
              tokenized[g1],
              tokenized[g2],
              minLength,
              verseWordMaps[g1],
              verseWordMaps[g2],
              simThreshold
            )
          : findMatchingSequences(
              tokenized[g1],
              tokenized[g2],
              minLength,
              verseWordMaps[g1],
              verseWordMaps[g2]
            )

      const totalMatchingWords = matches.reduce(
        (total, match) => total + match.length,
        0
      )

      statistics.pairs[pairKey] = {
        count: matches.length,
        totalWords: totalMatchingWords,
        sequences: matches,
        matchPercentage: {
          [g1]: tokenized[g1].length
            ? ((totalMatchingWords / tokenized[g1].length) * 100).toFixed(1)
            : '0.0',
          [g2]: tokenized[g2].length
            ? ((totalMatchingWords / tokenized[g2].length) * 100).toFixed(1)
            : '0.0',
        },
      }
    }
  }

  // Compute cross-gospel summary (sequences common to ALL gospels)
  if (gospelList.length >= 2) {
    let commonSequences =
      statistics.pairs[`${gospelList[0]}-${gospelList[1]}`]?.sequences || []

    for (let i = 2; i < gospelList.length; i++) {
      const g = gospelList[i]
      const pairKey = `${gospelList[0]}-${g}`
      const nextSequences = statistics.pairs[pairKey]?.sequences || []

      const wordsJoin = (seq) => seq.words.join(' ')

      commonSequences = commonSequences
        .filter((seq1) =>
          nextSequences.some((seq2) => wordsJoin(seq1) === wordsJoin(seq2))
        )
        .map((seq1) => {
          const matchingSeq = nextSequences.find(
            (seq2) => wordsJoin(seq1) === wordsJoin(seq2)
          )
          return {
            ...seq1,
            [`verse_${g}`]: matchingSeq?.verse2 || null,
            [`book_${g}`]: matchingSeq?.book2 || null,
            [`chapter_${g}`]: matchingSeq?.chapter2 || null,
          }
        })
    }

    const enhancedCommon = commonSequences.map((seq) => {
      const result = { ...seq }
      gospelList.forEach((g, idx) => {
        const verseProp =
          idx === 0
            ? 'verse1'
            : idx === 1
              ? 'verse2'
              : idx === 2
                ? 'verse3'
                : 'verse4'
        const bookProp =
          idx === 0
            ? 'book1'
            : idx === 1
              ? 'book2'
              : idx === 2
                ? 'book3'
                : 'book4'
        const chapterProp =
          idx === 0
            ? 'chapter1'
            : idx === 1
              ? 'chapter2'
              : idx === 2
                ? 'chapter3'
                : 'chapter4'
        result[`verse_${g}`] = result[`verse_${g}`] || seq[verseProp] || null
        result[`book_${g}`] = result[`book_${g}`] || seq[bookProp] || null
        result[`chapter_${g}`] =
          result[`chapter_${g}`] || seq[chapterProp] || null
      })
      return result
    })

    if (enhancedCommon.length > 0) {
      statistics.summary.uniqueSequences = enhancedCommon
      statistics.summary.totalMatches = enhancedCommon.length
      statistics.summary.totalMatchingWords = enhancedCommon.reduce(
        (sum, m) => sum + m.length,
        0
      )
    }
  }

  return statistics
}

class ComputeStatisticsWorker {
  /**
   * Process a compute-statistics job.
   *
   * @param {Object} params
   * @param {Array<{id: string, title: string, passages: Array<{gospel: string, verses: Array<{verse: number, text: string}>}>}>} params.verses - sections with passages
   * @param {number} [params.minLength=3] - minimum word-sequence length to report
   * @param {string} [params.mode='exact'] - 'exact' or 'relaxed'
   * @param {number} [params.similarityThreshold=0.2] - max edit-distance ratio for relaxed mode
   * @returns {Array} array of per-section statistics objects
   */
  static async perform({
    verses,
    minLength = 3,
    mode = 'exact',
    similarityThreshold = 0.2,
  }) {
    const sections = Array.isArray(verses) ? verses : []

    const results = sections.map((section) => {
      const gospelsWithVerses = {}

      section.passages?.forEach((passage) => {
        if (passage.verses && Array.isArray(passage.verses)) {
          gospelsWithVerses[passage.gospel] = {
            text: passage.verses.map((v) => v.text).join(' '),
            verses: passage.verses,
          }
        }
      })

      const stats = computeStatistics(
        gospelsWithVerses,
        minLength,
        mode,
        similarityThreshold
      )

      return {
        sectionId: section.id,
        sectionTitle: section.title,
        ...stats,
      }
    })

    return results
  }
}

module.exports = ComputeStatisticsWorker
