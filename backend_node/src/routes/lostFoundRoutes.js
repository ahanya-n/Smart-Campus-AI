const express = require('express');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { ObjectId } = require('mongodb');

const ID_PATTERN = /^[a-f\d]{24}$/i;
const REPORT_TYPES = Object.freeze(['lost', 'found']);
const STATUSES = Object.freeze(['active', 'match_found', 'verification_pending', 'resolved', 'closed']);
const CATEGORIES = Object.freeze([
  'Bag',
  'Book',
  'Clothing',
  'Electronic device',
  'ID card',
  'Keys',
  'Bottle',
  'Other',
]);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_BRAND_LENGTH = 80;
const ALLOWED_IMAGE_TYPES = Object.freeze({
  'image/jpeg': { extension: '.jpg', magic: (buffer) =>
    buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff },
  'image/png': { extension: '.png', magic: (buffer) =>
    buffer.length >= 8 &&
    buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47 &&
    buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a },
  'image/webp': { extension: '.webp', magic: (buffer) =>
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP' },
});
const MATCH_WEIGHTS = Object.freeze({
  image: 0.45,
  itemName: 0.10,
  brand: 0.10,
  description: 0.15,
  categoryColour: 0.10,
  location: 0.05,
  eventTime: 0.05,
});
const DEFAULT_HIGH_CONFIDENCE_THRESHOLD = 75;
const DEFAULT_MINIMUM_MATCH_THRESHOLD = 55;

function cosineSimilarity(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length === 0 || left.length !== right.length) {
    return null;
  }
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    if (!Number.isFinite(left[index]) || !Number.isFinite(right[index])) return null;
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  if (leftNorm === 0 || rightNorm === 0) return null;
  return Math.max(-1, Math.min(1, dot / Math.sqrt(leftNorm * rightNorm)));
}

async function ensureClaimNotification(
  getNotificationsCollection,
  getUsersCollection,
  claim,
  match,
  lostReport,
  foundReport,
  now,
) {
  if (!getNotificationsCollection) return;
  const notifications = await getNotificationsCollection();
  if (await notifications.findOne({ claim_id: claim._id })) return;

  let studentId = '';
  if (getUsersCollection) {
    const owner = await (await getUsersCollection()).findOne({ _id: foundReport.user_id });
    studentId = typeof owner?.student_id === 'string' ? owner.student_id : '';
  }
  try {
    await notifications.insertOne({
      student_id: studentId,
      recipient_user_id: foundReport.user_id,
      claim_id: claim._id,
      match_id: match._id,
      lost_report_id: lostReport._id,
      found_report_id: foundReport._id,
      action_type: 'lost_found_claim',
      subject_code: 'lost-found',
      subject_name: 'Lost and Found',
      attendance_percentage: 0,
      threshold: 0,
      week_id: `LF-${String(match._id).slice(-8)}`,
      warning_type: 'lost_found_match',
      title: 'Lost and Found match request',
      message: 'A student requested verification for a potential match. Review it in Lost and Found.',
      reporting_date: now.toISOString().slice(0, 10),
      created_at: now,
      is_read: false,
    });
  } catch (error) {
    if (error.code !== 11000 || !await notifications.findOne({ claim_id: claim._id })) {
      throw error;
    }
  }
}

function tokenSet(value) {
  if (typeof value !== 'string') return new Set();
  const stopWords = new Set(['a', 'an', 'the', 'and', 'or', 'with', 'has', 'have', 'my', 'near', 'of']);
  const synonyms = {
    cellphone: 'phone',
    mobile: 'phone',
    smartphone: 'phone',
    eyeglasses: 'glasses',
    spectacles: 'glasses',
    knapsack: 'backpack',
    rucksack: 'backpack',
    flask: 'bottle',
    tumbler: 'bottle',
  };
  return new Set(value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((token) => token && !stopWords.has(token))
    .map((token) => synonyms[token] || token.replace(/(ies)$/, 'y').replace(/(s)$/, '')));
}

function jaccardSimilarity(left, right) {
  const leftSet = tokenSet(left);
  const rightSet = tokenSet(right);
  if (leftSet.size === 0 || rightSet.size === 0) return 0;
  let intersection = 0;
  for (const item of leftSet) if (rightSet.has(item)) intersection += 1;
  return intersection / new Set([...leftSet, ...rightSet]).size;
}

function colourSimilarity(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return 0;
  if (!left.trim() || !right.trim()) return 0;
  const colourAliases = {
    navy: 'blue',
    cyan: 'blue',
    turquoise: 'blue',
    crimson: 'red',
    maroon: 'red',
    scarlet: 'red',
    lime: 'green',
    olive: 'green',
    charcoal: 'gray',
    grey: 'gray',
  };
  const normalized = (value) => colourAliases[value.trim().toLowerCase()] || value.trim().toLowerCase();
  return normalized(left) === normalized(right) ? 1 : 0;
}

function locationSimilarity(left, right) {
  const normalizeLocation = (value) => typeof value === 'string'
    ? value.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').replace(/\b(the|at|near|of)\b/g, ' ').replace(/\s+/g, ' ').trim()
    : '';
  const leftValue = normalizeLocation(left);
  const rightValue = normalizeLocation(right);
  if (!leftValue || !rightValue) return 0;
  if (leftValue === rightValue) return 1;
  const leftTokens = tokenSet(leftValue);
  const rightTokens = tokenSet(rightValue);
  if (!leftTokens.size || !rightTokens.size) return 0;
  let intersection = 0;
  for (const item of leftTokens) if (rightTokens.has(item)) intersection += 1;
  const union = new Set([...leftTokens, ...rightTokens]).size;
  return union ? intersection / union : 0;
}

function timeSimilarity(left, right) {
  const leftTimestamp = getEventTimestamp(left);
  const rightTimestamp = getEventTimestamp(right);
  if (leftTimestamp === null || rightTimestamp === null) return 0;
  const day = 24 * 60 * 60 * 1000;
  return Math.max(0, 1 - Math.abs(leftTimestamp - rightTimestamp) / day);
}

function getEventTimestamp(report) {
  if (report.event_timestamp instanceof Date) return report.event_timestamp.valueOf();
  if (typeof report.event_timestamp === 'string') {
    const date = new Date(report.event_timestamp);
    if (!Number.isNaN(date.valueOf())) return date.valueOf();
  }
  if (typeof report.event_date === 'string' && typeof report.event_time === 'string') {
    const date = new Date(`${report.event_date}T${report.event_time}:00Z`);
    if (!Number.isNaN(date.valueOf())) return date.valueOf();
  }
  return null;
}

function passesMatchingFilters(left, right) {
  if (!left || !right || left._id?.equals?.(right._id) || String(left._id) === String(right._id)) return false;
  if (left.report_type === right.report_type) return false;
  if (!REPORT_TYPES.includes(left.report_type) || !REPORT_TYPES.includes(right.report_type)) return false;
  if (left.status !== 'active' || right.status !== 'active') return false;
  if (left.resolved_at || right.resolved_at || left.closed_at || right.closed_at) return false;
  const leftTimestamp = getEventTimestamp(left);
  const rightTimestamp = getEventTimestamp(right);
  if (leftTimestamp === null || rightTimestamp === null) return false;
  return Math.abs(leftTimestamp - rightTimestamp) <= 24 * 60 * 60 * 1000;
}

function canonicalMatchReports(left, right) {
  if (!left || !right || left.report_type === right.report_type) return null;
  if (left.report_type === 'lost' && right.report_type === 'found') {
    return { lost: left, found: right };
  }
  if (left.report_type === 'found' && right.report_type === 'lost') {
    return { lost: right, found: left };
  }
  return null;
}

function calculateMatchScore(left, right, leftEmbedding, rightEmbedding) {
  const imageCosine = leftEmbedding && rightEmbedding
    ? cosineSimilarity(leftEmbedding, rightEmbedding)
    : null;
  const imageScore = imageCosine === null ? null : Math.max(0, imageCosine);
  const itemNameScore = jaccardSimilarity(left.item_name, right.item_name);
  const brandScore = jaccardSimilarity(left.brand, right.brand);
  const descriptionText = (report) =>
    [report.description, report.additional_details].filter((value) => typeof value === 'string').join(' ');
  const leftDescription = descriptionText(left);
  const rightDescription = descriptionText(right);
  const descriptionScore = jaccardSimilarity(leftDescription, rightDescription);
  const normalizeCategory = (value) => {
    if (typeof value !== 'string') return '';
    const categoryAliases = {
      electronics: 'electronic device',
      electronic: 'electronic device',
      id: 'id card',
      card: 'id card',
      bags: 'bag',
      books: 'book',
      clothes: 'clothing',
    };
    const key = value.trim().toLowerCase();
    return categoryAliases[key] || key;
  };
  const categoryScore = typeof left.category === 'string' &&
    typeof right.category === 'string' &&
    left.category.trim() &&
    right.category.trim() &&
    normalizeCategory(left.category) === normalizeCategory(right.category)
    ? 1
    : 0;
  const colourScore = colourSimilarity(left.colour, right.colour);
  const categoryColourScore = (categoryScore + colourScore) / 2;
  const locationScore = locationSimilarity(left.location, right.location);
  const eventTimeScore = timeSimilarity(left, right);

  const availableFactors = [];
  if (imageScore !== null) {
    availableFactors.push([imageScore, MATCH_WEIGHTS.image]);
  }
  if (typeof left.item_name === 'string' && left.item_name.trim() &&
      typeof right.item_name === 'string' && right.item_name.trim()) {
    availableFactors.push([itemNameScore, MATCH_WEIGHTS.itemName]);
  }
  if (typeof left.brand === 'string' && left.brand.trim() &&
      typeof right.brand === 'string' && right.brand.trim()) {
    availableFactors.push([brandScore, MATCH_WEIGHTS.brand]);
  }
  if (leftDescription.trim() && rightDescription.trim()) {
    availableFactors.push([descriptionScore, MATCH_WEIGHTS.description]);
  }
  const categoryOrColourAvailable =
    (typeof left.category === 'string' && left.category.trim() &&
     typeof right.category === 'string' && right.category.trim()) ||
    (typeof left.colour === 'string' && left.colour.trim() &&
     typeof right.colour === 'string' && right.colour.trim());
  if (categoryOrColourAvailable) {
    availableFactors.push([categoryColourScore, MATCH_WEIGHTS.categoryColour]);
  }
  if (typeof left.location === 'string' && left.location.trim() &&
      typeof right.location === 'string' && right.location.trim()) {
    availableFactors.push([locationScore, MATCH_WEIGHTS.location]);
  }
  if (getEventTimestamp(left) !== null && getEventTimestamp(right) !== null) {
    availableFactors.push([eventTimeScore, MATCH_WEIGHTS.eventTime]);
  }

  const availableWeight = availableFactors.reduce((sum, [, weight]) => sum + weight, 0);
  const weighted = availableWeight === 0
    ? 0
    : availableFactors.reduce((sum, [factorScore, weight]) =>
      sum + factorScore * weight, 0) / availableWeight;
  const score = Math.max(0, Math.min(100, weighted * 100));

  const normalizedWeight = (weight) => availableWeight === 0
    ? 0
    : weight / availableWeight;

  return {
    score: Math.round(score * 100) / 100,
    factors: {
      image: imageScore === null ? null : Math.round(imageScore * 100) / 100,
      itemName: Math.round(itemNameScore * 100) / 100,
      brand: Math.round(brandScore * 100) / 100,
      description: Math.round(descriptionScore * 100) / 100,
      category: categoryScore,
      colour: colourScore,
      location: Math.round(locationScore * 100) / 100,
      eventTime: Math.round(eventTimeScore * 100) / 100,
    },
    weights: {
      image: imageScore === null ? 0 : normalizedWeight(MATCH_WEIGHTS.image),
      itemName: (typeof left.item_name === 'string' && left.item_name.trim() &&
        typeof right.item_name === 'string' && right.item_name.trim())
        ? normalizedWeight(MATCH_WEIGHTS.itemName)
        : 0,
      brand: (typeof left.brand === 'string' && left.brand.trim() &&
        typeof right.brand === 'string' && right.brand.trim())
        ? normalizedWeight(MATCH_WEIGHTS.brand)
        : 0,
      description: (leftDescription.trim() && rightDescription.trim())
        ? normalizedWeight(MATCH_WEIGHTS.description)
        : 0,
      categoryColour: categoryOrColourAvailable
        ? normalizedWeight(MATCH_WEIGHTS.categoryColour)
        : 0,
      location: (typeof left.location === 'string' && left.location.trim() &&
        typeof right.location === 'string' && right.location.trim())
        ? normalizedWeight(MATCH_WEIGHTS.location)
        : 0,
      eventTime: getEventTimestamp(left) !== null && getEventTimestamp(right) !== null
        ? normalizedWeight(MATCH_WEIGHTS.eventTime)
        : 0,
    },
  };
}

function matchExplanation(score, factors, highThreshold = DEFAULT_HIGH_CONFIDENCE_THRESHOLD) {
  const explanations = [
    score >= highThreshold
      ? 'Strong overall similarity across the available factors.'
      : 'Possible similarity across the available factors; ownership is not verified.',
  ];
  if (factors.image !== null && factors.image >= 0.75) explanations.push('Images are visually similar.');
  if (factors.itemName >= 0.5) explanations.push('Item names or related terms overlap.');
  if (factors.brand >= 0.5) explanations.push('Brand details overlap.');
  if (factors.description >= 0.35) explanations.push('Identifying details overlap.');
  if (factors.category > 0) explanations.push('Item categories match.');
  if (factors.colour > 0) explanations.push('Reported colours match.');
  if (factors.location >= 0.3) explanations.push('Approximate locations overlap.');
  if (factors.eventTime >= 0.5) explanations.push('Reported times are close.');
  return explanations;
}

function cleanText(body, field, min, max) {
  const value = body[field];
  if (typeof value !== 'string') return { error: `${field} must be text` };
  const cleaned = value.trim();
  if (cleaned.length < min || cleaned.length > max) {
    return { error: `${field} must be between ${min} and ${max} characters` };
  }
  return { value: cleaned };
}

function iso(value) {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function validateDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function validateTime(value) {
  return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function validateCreate(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'Request body must be a JSON object' };
  }
  if (!REPORT_TYPES.includes(body.report_type)) {
    return { error: 'report_type must be lost or found' };
  }
  const itemName = cleanText(body, 'item_name', 1, 120);
  if (itemName.error) return itemName;
  const description = cleanText(body, 'description', 1, 1000);
  if (description.error) return description;
  if (!CATEGORIES.includes(body.category)) return { error: 'category is invalid' };
  const colour = cleanText(body, 'colour', 1, 60);
  if (colour.error) return colour;
  if (!validateDate(body.event_date)) return { error: 'event_date must be a valid date' };
  if (!validateTime(body.event_time)) return { error: 'event_time must use 24-hour HH:MM format' };
  const location = cleanText(body, 'location', 1, 200);
  if (location.error) return location;

  const brand = body.brand == null ? '' : body.brand;
  if (typeof brand !== 'string' || brand.trim().length > MAX_BRAND_LENGTH) {
    return { error: `brand cannot exceed ${MAX_BRAND_LENGTH} characters` };
  }

  const additional = body.additional_details == null ? '' : body.additional_details;
  if (typeof additional !== 'string' || additional.trim().length > 1000) {
    return { error: 'additional_details cannot exceed 1000 characters' };
  }

  return {
    value: {
      report_type: body.report_type,
      item_name: itemName.value,
      brand: brand.trim(),
      description: description.value,
      category: body.category,
      colour: colour.value,
      event_date: body.event_date,
      event_time: body.event_time,
      location: location.value,
      additional_details: additional.trim(),
    },
  };
}

function reportOutput(report) {
  return {
    id: String(report._id),
    report_type: report.report_type,
    item_name: report.item_name,
    brand: report.brand || '',
    description: report.description,
    category: report.category,
    colour: report.colour,
    event_date: report.event_date,
    event_time: report.event_time,
    location: report.location,
    additional_details: report.additional_details || '',
    status: report.status,
    image_url: report.image_url || null,
    created_at: iso(report.created_at),
    updated_at: iso(report.updated_at),
    closed_at: iso(report.closed_at),
    resolved_at: iso(report.resolved_at),
    ai_analysis: report.ai_analysis || null,
    image_embedding_reference: report.image_embedding_reference || null,
    matching_status: report.matching_status || 'not_requested',
    last_matching_at: iso(report.last_matching_at),
  };
}

function publicMatchSafeOutput(report) {
  return {
    id: String(report._id),
    report_type: report.report_type,
    item_name: report.item_name,
    brand: report.brand || '',
    category: report.category,
    colour: report.colour,
    event_date: report.event_date,
    event_time: report.event_time,
    status: report.status,
    image_url: report.image_url || null,
  };
}

function createLostFoundRouter({
  authenticate,
  requireRoles,
  getLostFoundItemsCollection,
  getLostFoundMatchesCollection,
  getLostFoundClaimsCollection,
  getNotificationsCollection,
  getUsersCollection,
  uploadDir,
  saveImage,
  aiServiceBaseUrl,
  aiInternalKey,
  highConfidenceThreshold,
  minimumMatchThreshold,
}) {
  const router = express.Router();
  const studentOnly = requireRoles('student');
  const adminOnly = requireRoles('admin');
  const resolvedUploadDir = uploadDir ||
    path.resolve(__dirname, '..', '..', 'uploads', 'lost-found');
  const resolvedEmbeddingDir = path.resolve(resolvedUploadDir, '..', 'lost-found-embeddings');
  const highThreshold = Number(highConfidenceThreshold);
  const minimumThreshold = Number(minimumMatchThreshold);
  const highConfidenceThresholdValue = Number.isFinite(highThreshold)
    ? highThreshold
    : DEFAULT_HIGH_CONFIDENCE_THRESHOLD;
  const minimumMatchThresholdValue = Number.isFinite(minimumThreshold)
    ? minimumThreshold
    : DEFAULT_MINIMUM_MATCH_THRESHOLD;
  let indexesReady;

  async function ensureIndexes() {
    if (!indexesReady) {
      indexesReady = (async () => {
        const collection = await getLostFoundItemsCollection();
        await Promise.all([
          collection.createIndex({ user_id: 1 }, { name: 'lost_found_user' }),
          collection.createIndex(
            { report_type: 1, status: 1, event_timestamp: 1 },
            { name: 'lost_found_matching_scope' },
          ),
        ]);
        if (getLostFoundMatchesCollection) {
          const matches = await getLostFoundMatchesCollection();
          await Promise.all([
            matches.createIndex(
              { queried_report_id: 1, candidate_report_id: 1 },
              { name: 'lost_found_match_pair', unique: true },
            ),
            matches.createIndex({ score: -1 }, { name: 'lost_found_match_score' }),
          ]);
        }
        if (getLostFoundClaimsCollection) {
          const claims = await getLostFoundClaimsCollection();
          await claims.createIndex(
            { match_id: 1, claimant_id: 1 },
            { name: 'lost_found_claim_unique', unique: true },
          );
        }
        if (getNotificationsCollection) {
          const notifications = await getNotificationsCollection();
          await notifications.createIndex(
            { claim_id: 1 },
            { name: 'lost_found_claim_notification_unique', unique: true, sparse: true },
          );
        }
      })().catch((error) => {
        indexesReady = undefined;
        throw error;
      });
    }
    await indexesReady;
  }

  async function findReport(rawId) {
    if (!ID_PATTERN.test(rawId)) return null;
    return (await getLostFoundItemsCollection()).findOne({ _id: new ObjectId(rawId) });
  }

  function ownsReport(report, user) {
    return report.user_id instanceof ObjectId
      ? report.user_id.equals(user._id)
      : String(report.user_id) === String(user._id);
  }

  async function invalidateMatchesAndClaims(reportId, now) {
    if (!getLostFoundMatchesCollection) return;
    const matches = await getLostFoundMatchesCollection();
    const allMatches = await matches.find({}).toArray();
    for (const match of allMatches) {
      const isRelated =
        String(match.queried_report_id) === String(reportId) ||
        String(match.candidate_report_id) === String(reportId);
      if (!isRelated) continue;
      if (!match.match_status || ['pending', 'verification_pending'].includes(match.match_status)) {
        await matches.updateOne(
          { _id: match._id },
          {
            $set: {
              match_status: 'invalidated',
              invalidated_at: now,
              invalidation_reason: 'report_closed_or_resolved',
              updated_at: now,
            },
          },
        );
      }
    }

    if (!getLostFoundClaimsCollection) return;
    const claims = await getLostFoundClaimsCollection();
    const allClaims = await claims.find({}).toArray();
    for (const claim of allClaims) {
      if (claim.verification_status !== 'pending') continue;
      const match = allMatches.find((item) => String(item._id) === String(claim.match_id));
      if (!match) continue;
      const isRelated =
        String(match.queried_report_id) === String(reportId) ||
        String(match.candidate_report_id) === String(reportId);
      if (isRelated) {
        await claims.updateOne(
          { _id: claim._id, verification_status: 'pending' },
          {
            $set: {
              verification_status: 'invalidated',
              invalidated_at: now,
              invalidation_reason: 'report_closed_or_resolved',
              updated_at: now,
            },
          },
        );
      }
    }
  }

  async function defaultSaveImage(image) {
    if (!image || typeof image !== 'object') return null;
    if (typeof image.data !== 'string' || typeof image.type !== 'string') {
      throw Object.assign(new Error('image must contain supported image data'), { statusCode: 422 });
    }
    if (image.data.length > 7 * 1024 * 1024) {
      throw Object.assign(new Error('image must be 5 MB or smaller'), { statusCode: 422 });
    }

    let encoded = image.data.trim();
    const dataUrlMatch = /^data:([^;]+);base64,(.+)$/s.exec(encoded);
    if (dataUrlMatch) encoded = dataUrlMatch[2];

    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 !== 0) {
      throw Object.assign(new Error('image data is invalid'), { statusCode: 422 });
    }
    const buffer = Buffer.from(encoded, 'base64');
    if (buffer.length > MAX_IMAGE_BYTES) {
      throw Object.assign(new Error('image must be 5 MB or smaller'), { statusCode: 422 });
    }
    if (buffer.length === 0) {
      throw Object.assign(new Error('image data is invalid'), { statusCode: 422 });
    }

    const imageType = ALLOWED_IMAGE_TYPES[image.type];
    if (!imageType || !imageType.magic(buffer)) {
      throw Object.assign(new Error('image format is invalid'), { statusCode: 422 });
    }

    await fs.mkdir(resolvedUploadDir, { recursive: true });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const reference = `${crypto.randomBytes(20).toString('hex')}${imageType.extension}`;
      try {
        await fs.writeFile(path.join(resolvedUploadDir, reference), buffer, { flag: 'wx', mode: 0o600 });
        return {
          reference,
          url: `/api/lost-found/images/${reference}`,
          mimeType: image.type,
        };
      } catch (error) {
        if (error.code === 'EEXIST') continue;
        throw error;
      }
    }
    throw new Error('Could not generate a unique image filename');
  }

  async function readEmbedding(reference, report) {
    if (Array.isArray(report?.image_embedding) && report.image_embedding.length > 0) {
      return report.image_embedding;
    }
    if (typeof reference !== 'string' || !/^lost_found_[a-f\d]{40}\.json$/i.test(reference)) {
      return null;
    }
    try {
      const parsed = JSON.parse(await fs.readFile(path.join(resolvedEmbeddingDir, reference), 'utf8'));
      return Array.isArray(parsed.embedding) ? parsed.embedding : null;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      return null;
    }
  }

  async function saveEmbedding(reportId, result) {
    if (!Array.isArray(result.embedding) || result.embedding.length === 0) return null;
    await fs.mkdir(resolvedEmbeddingDir, { recursive: true });
    const reference = `lost_found_${crypto.createHash('sha256').update(String(reportId)).digest('hex')}.json`;
    await fs.writeFile(
      path.join(resolvedEmbeddingDir, reference),
      JSON.stringify({
        report_id: String(reportId),
        model: result.model || 'unknown',
        embedding: result.embedding,
        created_at: new Date().toISOString(),
      }),
      { mode: 0o600 },
    );
    return reference;
  }

  async function analyzeReportAsync(report) {
    if (!aiServiceBaseUrl || !aiInternalKey || !report.image_reference) {
      await (await getLostFoundItemsCollection()).updateOne(
        { _id: report._id },
        { $set: { matching_status: 'unavailable', last_matching_at: null, updated_at: new Date() } },
      );
      return;
    }
    try {
      const imageBuffer = await fs.readFile(path.join(resolvedUploadDir, report.image_reference));
      const response = await fetch(
        new URL('/lost-found/analyze', aiServiceBaseUrl),
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-lost-found-internal-key': aiInternalKey,
          },
          body: JSON.stringify({
            image_base64: imageBuffer.toString('base64'),
            image_mime_type: report.image_mime_type || 'image/jpeg',
          }),
          signal: AbortSignal.timeout(20000),
        },
      );
      if (!response.ok) throw new Error(`AI service returned ${response.status}`);
      const analysis = await response.json();
      const embeddingReference = await saveEmbedding(report._id, analysis);
      await (await getLostFoundItemsCollection()).updateOne(
        { _id: report._id },
        {
          $set: {
            ai_analysis: {
              predicted_category: analysis.predicted_category || 'Other',
              predicted_item: analysis.predicted_item || 'Uncertain',
              predicted_colour: analysis.predicted_colour || 'Unknown',
              visual_features: Array.isArray(analysis.visual_features) ? analysis.visual_features : [],
              analysis_status: analysis.analysis_status || 'failed',
              model: analysis.model || 'unknown',
              confidence: Number.isFinite(analysis.confidence) ? analysis.confidence : null,
              limitations: Array.isArray(analysis.limitations) ? analysis.limitations : [],
            },
            image_embedding_reference: embeddingReference,
            image_embedding: Array.isArray(analysis.embedding) ? analysis.embedding : null,
            matching_status: embeddingReference ? 'ready' : 'failed',
            last_matching_at: new Date(),
            updated_at: new Date(),
          },
        },
      );
      await recomputeMatchesForReport({ ...report, ai_analysis: analysis });
    } catch (error) {
      await (await getLostFoundItemsCollection()).updateOne(
        { _id: report._id },
        {
          $set: {
            ai_analysis: {
              predicted_category: 'Other',
              predicted_item: 'Uncertain',
              predicted_colour: 'Unknown',
              visual_features: [],
              analysis_status: 'failed',
              model: 'none',
              confidence: null,
              limitations: ['AI analysis is unavailable; matching factors may be reduced.'],
            },
            matching_status: 'failed',
            last_matching_at: null,
            updated_at: new Date(),
          },
        },
      );
    }
  }

  async function recomputeMatchesForReport(report) {
    if (!getLostFoundMatchesCollection || !getLostFoundItemsCollection) return;
    const items = await getLostFoundItemsCollection();
    const candidates = await items.find({}).toArray();
    const matches = await getLostFoundMatchesCollection();
    const leftEmbedding = await readEmbedding(report.image_embedding_reference, report);

    for (const candidate of candidates) {
      if (!passesMatchingFilters(report, candidate)) continue;
      if (String(report.user_id) === String(candidate.user_id)) continue;
      const direction = canonicalMatchReports(report, candidate);
      if (!direction) continue;
      const queryEmbedding = direction.lost === report
        ? leftEmbedding
        : await readEmbedding(direction.lost.image_embedding_reference, direction.lost);
      const candidateEmbedding = direction.found === candidate
        ? await readEmbedding(candidate.image_embedding_reference, candidate)
        : leftEmbedding;
      const calculated = calculateMatchScore(direction.lost, direction.found, queryEmbedding, candidateEmbedding);
      const pair = {
        queried_report_id: new ObjectId(String(direction.lost._id)),
        candidate_report_id: new ObjectId(String(direction.found._id)),
      };
      const now = new Date();
      const existing = await matches.findOne(pair);
      if (calculated.score < minimumMatchThresholdValue) {
        if (existing) {
          await matches.updateOne(
            { _id: existing._id },
            {
              $set: {
                similarity_score: calculated.score,
                factor_scores: calculated.factors,
                factor_weights: calculated.weights,
                matching_status: 'ineligible',
                updated_at: now,
              },
            },
          );
        }
        continue;
      }

      const matchDocument = {
        ...pair,
        claimant_id: new ObjectId(String(direction.lost.user_id)),
        report_owner_id: new ObjectId(String(direction.found.user_id)),
        similarity_score: calculated.score,
        factor_scores: calculated.factors,
        factor_weights: calculated.weights,
        match_status: ['invalidated', 'rejected', 'approved', 'verification_pending', 'pending'].includes(existing?.match_status)
          ? existing.match_status
          : 'pending',
        matching_status: 'eligible',
        thresholds: {
          high_confidence: highConfidenceThresholdValue,
          minimum: minimumMatchThresholdValue,
        },
        model: direction.lost.ai_analysis?.model || direction.found.ai_analysis?.model || 'unknown',
        updated_at: now,
      };
      if (existing) {
        await matches.updateOne(
          { _id: existing._id },
          { $set: { ...matchDocument, created_at: existing.created_at || now } },
        );
      } else {
        await matches.insertOne({ ...matchDocument, created_at: now });
      }
    }
  }

  router.post('/', authenticate, studentOnly, async (request, response, next) => {
    const validated = validateCreate(request.body);
    if (validated.error) return response.status(422).json({ detail: validated.error });
    try {
      await ensureIndexes();
      let image = null;
      if (request.body.image != null) {
        try {
          image = saveImage
            ? await saveImage(request.body.image)
            : await defaultSaveImage(request.body.image);
        } catch (error) {
          if (error.statusCode === 422) {
            return response.status(422).json({ detail: error.message });
          }
          throw error;
        }
      }

      const now = new Date();
      const eventTimestamp = new Date(`${validated.value.event_date}T${validated.value.event_time}:00Z`);
      const document = {
        user_id: request.user._id,
        ...validated.value,
        event_timestamp: eventTimestamp,
        status: 'active',
        image_reference: image?.reference || null,
        image_url: image?.url || null,
        image_mime_type: image?.mimeType || null,
        created_at: now,
        updated_at: now,
        closed_at: null,
        resolved_at: null,
      };

      const collection = await getLostFoundItemsCollection();
      const result = await collection.insertOne(document);
      const saved = { ...document, _id: result.insertedId, matching_status: 'processing' };
      await collection.updateOne(
        { _id: result.insertedId },
        { $set: { matching_status: 'processing', updated_at: now } },
      );
      setImmediate(() => {
        analyzeReportAsync(saved).catch(() => {});
      });
      return response.status(201).json(reportOutput(saved));
    } catch (error) {
      return next(error);
    }
  });

  router.get('/my-reports', authenticate, async (request, response, next) => {
    const reportType = request.query.report_type;
    const status = request.query.status;
    if (reportType !== undefined && !REPORT_TYPES.includes(reportType)) {
      return response.status(422).json({ detail: 'report_type must be lost or found' });
    }
    if (status !== undefined && !STATUSES.includes(status)) {
      return response.status(422).json({ detail: 'status is invalid' });
    }
    try {
      await ensureIndexes();
      const query = { user_id: request.user._id };
      if (reportType) query.report_type = reportType;
      if (status) query.status = status;
      const collection = await getLostFoundItemsCollection();
      const items = await collection.find(query).sort({ created_at: -1 }).toArray();
      return response.json({ items: items.map(reportOutput), total: items.length });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/:id/matches', authenticate, async (request, response, next) => {
    try {
      await ensureIndexes();
      const report = await findReport(request.params.id);
      if (!report) return response.status(404).json({ detail: 'Lost and Found report not found' });
      if (!ownsReport(report, request.user) && request.user.role !== 'admin') {
        return response.status(404).json({ detail: 'Lost and Found report not found' });
      }
      if (report.report_type !== 'lost') {
        return response.status(422).json({ detail: 'Matching results are available only for LOST reports' });
      }
      if (Date.now() - (report.last_matching_at?.valueOf?.() || 0) > 5 * 60 * 1000) {
        await recomputeMatchesForReport(report);
        const refreshed = await findReport(request.params.id);
        if (refreshed) Object.assign(report, refreshed);
      }

      if (!getLostFoundMatchesCollection) {
        return response.json({ items: [], high_confidence: [], possible_matches: [], minimum_threshold: minimumMatchThresholdValue });
      }
      const matches = await getLostFoundMatchesCollection();
      const allMatches = await matches.find({ queried_report_id: report._id }).toArray();
      const privacySafe = [];
      for (const match of allMatches) {
        if (match.match_status === 'invalidated' || match.match_status === 'rejected') continue;
        const candidate = await (await getLostFoundItemsCollection()).findOne({
          _id: match.candidate_report_id,
        });
        if (!candidate || candidate.report_type !== 'found' || !passesMatchingFilters(report, candidate)) continue;
        if (String(report.user_id) === String(candidate.user_id)) continue;
        const score = Number(match.similarity_score);
        if (!Number.isFinite(score) || score < minimumMatchThresholdValue) continue;
        privacySafe.push({
          id: String(match._id),
          similarity_score: score,
          factor_scores: match.factor_scores || {},
          explanation: matchExplanation(score, match.factor_scores || {}, highConfidenceThresholdValue),
          category: candidate.category || 'Other',
          colour: candidate.colour || 'Unknown',
          item_name: candidate.item_name || 'Potential item',
          brand: candidate.brand || '',
          report_type: candidate.report_type,
          event_date: candidate.event_date || null,
          event_time: candidate.event_time || null,
          approximate_location: 'Sensitive exact location withheld',
          image_url: `/api/lost-found/matches/${String(match._id)}/image`,
          match_status: match.match_status || 'pending',
        });
      }
      privacySafe.sort((left, right) => right.similarity_score - left.similarity_score);
      const highConfidence = privacySafe.filter((item) =>
        item.similarity_score >= highConfidenceThresholdValue);
      const possibleMatches = privacySafe.filter((item) =>
        item.similarity_score >= minimumMatchThresholdValue &&
        item.similarity_score < highConfidenceThresholdValue);
      return response.json({
        items: privacySafe,
        high_confidence: highConfidence,
        possible_matches: possibleMatches,
        high_confidence_threshold: highConfidenceThresholdValue,
        minimum_threshold: minimumMatchThresholdValue,
      });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/matches/:matchId/image', authenticate, async (request, response, next) => {
    if (!ID_PATTERN.test(request.params.matchId)) {
      return response.status(404).json({ detail: 'Match not found' });
    }
    try {
      if (!getLostFoundMatchesCollection) {
        return response.status(404).json({ detail: 'Match not found' });
      }
      const matches = await getLostFoundMatchesCollection();
      const match = await matches.findOne({ _id: new ObjectId(request.params.matchId) });
      if (!match) return response.status(404).json({ detail: 'Match not found' });
      const items = await getLostFoundItemsCollection();
      const queried = await items.findOne({ _id: match.queried_report_id });
      const candidate = await items.findOne({ _id: match.candidate_report_id });
      if (!queried || !candidate) return response.status(404).json({ detail: 'Match not found' });
      if (queried.report_type !== 'lost' || candidate.report_type !== 'found' ||
          !passesMatchingFilters(queried, candidate) ||
          ['invalidated', 'rejected'].includes(match.match_status)) {
        return response.status(404).json({ detail: 'Match not found' });
      }

      const isClaimant = ownsReport(queried, request.user);
      const isOwner = ownsReport(candidate, request.user);
      if (!isClaimant && !isOwner && request.user.role !== 'admin') {
        return response.status(404).json({ detail: 'Match not found' });
      }
      if (!candidate.image_reference) return response.status(404).json({ detail: 'Image not found' });
      const buffer = await fs.readFile(path.join(resolvedUploadDir, candidate.image_reference));
      response.set('Content-Type', candidate.image_mime_type || 'image/jpeg');
      response.set('Cache-Control', 'private, no-store');
      return response.send(buffer);
    } catch (error) {
      if (error.code === 'ENOENT') return response.status(404).json({ detail: 'Image not found' });
      return next(error);
    }
  });

  router.post('/matches/:matchId/request', authenticate, studentOnly, async (request, response, next) => {
    if (!ID_PATTERN.test(request.params.matchId)) {
      return response.status(404).json({ detail: 'Match not found' });
    }
    try {
      await ensureIndexes();
      if (!getLostFoundMatchesCollection || !getLostFoundClaimsCollection) {
        return response.status(503).json({ detail: 'Match request service is unavailable' });
      }
      const matches = await getLostFoundMatchesCollection();
      const match = await matches.findOne({ _id: new ObjectId(request.params.matchId) });
      if (!match) return response.status(404).json({ detail: 'Match not found' });
      const items = await getLostFoundItemsCollection();
      const queried = await items.findOne({ _id: match.queried_report_id });
      const candidate = await items.findOne({ _id: match.candidate_report_id });
      if (!queried || !candidate) {
        return response.status(409).json({ detail: 'This match is no longer eligible' });
      }
      if (queried.report_type !== 'lost' || candidate.report_type !== 'found') {
        return response.status(409).json({ detail: 'Only a LOST report can request a FOUND report match' });
      }
      if (!ownsReport(queried, request.user)) {
        return response.status(404).json({ detail: 'Match not found' });
      }
      if (!passesMatchingFilters(queried, candidate) ||
          !Number.isFinite(Number(match.similarity_score)) ||
          Number(match.similarity_score) < minimumMatchThresholdValue) {
        return response.status(409).json({ detail: 'This match is no longer eligible' });
      }

      const claims = await getLostFoundClaimsCollection();
      const existing = await claims.findOne({
        match_id: match._id,
        claimant_id: request.user._id,
      });
      if (existing) {
        await ensureClaimNotification(
          getNotificationsCollection,
          getUsersCollection,
          existing,
          match,
          queried,
          candidate,
          existing.created_at || new Date(),
        );
        return response.status(409).json({ detail: 'A match request already exists' });
      }

      const now = new Date();
      const claim = {
        match_id: match._id,
        claimant_id: request.user._id,
        report_owner_id: candidate.user_id,
        verification_status: 'pending',
        created_at: now,
        updated_at: now,
      };
      const result = await claims.insertOne(claim);
      const savedClaim = { ...claim, _id: result.insertedId };
      await matches.updateOne(
        { _id: match._id },
        { $set: { match_status: 'verification_pending', updated_at: now } },
      );
      await ensureClaimNotification(
        getNotificationsCollection,
        getUsersCollection,
        savedClaim,
        match,
        queried,
        candidate,
        now,
      );
      return response.status(201).json({
        id: String(result.insertedId),
        match_id: String(match._id),
        verification_status: 'pending',
        private_details_revealed: false,
      });
    } catch (error) {
      if (error.code === 11000) {
        return response.status(409).json({ detail: 'A match request already exists' });
      }
      return next(error);
    }
  });

  router.get('/claims/incoming', authenticate, async (request, response, next) => {
    try {
      if (!getLostFoundMatchesCollection || !getLostFoundClaimsCollection) {
        return response.status(503).json({ detail: 'Match request service is unavailable' });
      }
      const claims = await getLostFoundClaimsCollection();
      const query = request.user.role === 'admin'
        ? {}
        : { report_owner_id: request.user._id };
      const incoming = await claims.find(query).sort({ created_at: -1 }).toArray();
      const matches = await getLostFoundMatchesCollection();
      const items = await getLostFoundItemsCollection();
      const results = [];

      for (const claim of incoming) {
        const match = await matches.findOne({ _id: claim.match_id });
        if (!match) continue;
        const ownerReport = await items.findOne({ _id: match.candidate_report_id });
        const requestingReport = await items.findOne({ _id: match.queried_report_id });
        if (!ownerReport || !requestingReport) continue;
        if (ownerReport.report_type !== 'found' || requestingReport.report_type !== 'lost' ||
            !passesMatchingFilters(requestingReport, ownerReport)) continue;
        if (['invalidated', 'rejected'].includes(match.match_status)) continue;
        if (request.user.role !== 'admin' && !ownsReport(ownerReport, request.user)) continue;

        results.push({
          id: String(claim._id),
          match_id: String(match._id),
          verification_status: claim.verification_status,
          created_at: iso(claim.created_at),
          similarity_score: Number.isFinite(Number(match.similarity_score))
            ? Number(match.similarity_score)
            : null,
          owner_report: {
            id: String(ownerReport._id),
            item_name: ownerReport.item_name,
            report_type: ownerReport.report_type,
            status: ownerReport.status,
            image_url: ownerReport.image_url || null,
          },
          requesting_report: {
            item_name: requestingReport.item_name,
            report_type: requestingReport.report_type,
            category: requestingReport.category,
            colour: requestingReport.colour,
            event_date: requestingReport.event_date,
            event_time: requestingReport.event_time,
          },
        });
      }

      return response.json({ items: results });
    } catch (error) {
      return next(error);
    }
  });

  router.patch(
    '/matches/:matchId/claims/:claimId/review',
    authenticate,
    async (request, response, next) => {
      if (!ID_PATTERN.test(request.params.matchId) || !ID_PATTERN.test(request.params.claimId)) {
        return response.status(404).json({ detail: 'Match request not found' });
      }
      const decision = request.body?.decision;
      if (!['approved', 'rejected'].includes(decision)) {
        return response.status(422).json({ detail: 'decision must be approved or rejected' });
      }
      try {
        if (!getLostFoundMatchesCollection || !getLostFoundClaimsCollection) {
          return response.status(503).json({ detail: 'Match request service is unavailable' });
        }
        const matches = await getLostFoundMatchesCollection();
        const match = await matches.findOne({ _id: new ObjectId(request.params.matchId) });
        if (!match) return response.status(404).json({ detail: 'Match request not found' });

        const items = await getLostFoundItemsCollection();
        const candidate = await items.findOne({ _id: match.candidate_report_id });
        const queried = await items.findOne({ _id: match.queried_report_id });
        if (!candidate || !queried) return response.status(404).json({ detail: 'Match request not found' });
        if (request.user.role !== 'admin' && !ownsReport(candidate, request.user)) {
          return response.status(403).json({ detail: 'Only the report owner or an admin can review this request' });
        }
        if (queried.report_type !== 'lost' || candidate.report_type !== 'found' ||
            !passesMatchingFilters(queried, candidate) ||
            !Number.isFinite(Number(match.similarity_score)) ||
            Number(match.similarity_score) < minimumMatchThresholdValue) {
          return response.status(409).json({ detail: 'This match is no longer eligible' });
        }

        const claims = await getLostFoundClaimsCollection();
        const claim = await claims.findOne({ _id: new ObjectId(request.params.claimId), match_id: match._id });
        if (!claim) return response.status(404).json({ detail: 'Match request not found' });
        if (claim.verification_status !== 'pending') {
          return response.status(409).json({ detail: 'Match request has already been reviewed' });
        }

        const now = new Date();
        const reviewResult = await claims.updateOne(
          { _id: claim._id, verification_status: 'pending' },
          {
            $set: {
              verification_status: decision,
              reviewed_by: request.user._id,
              reviewed_at: now,
              updated_at: now,
            },
          },
        );
        if (reviewResult.matchedCount !== 1) {
          return response.status(409).json({ detail: 'Match request has already been reviewed' });
        }
        await matches.updateOne(
          { _id: match._id },
          {
            $set: {
              match_status: decision === 'approved' ? 'approved' : 'rejected',
              updated_at: now,
            },
          },
        );
        return response.json({
          id: String(claim._id),
          match_id: String(match._id),
          verification_status: decision,
          private_details_revealed: false,
        });
      } catch (error) {
        return next(error);
      }
    },
  );

  router.get('/images/:reference', authenticate, async (request, response, next) => {
    const reference = request.params.reference;
    if (!/^[a-f\d]{40}\.(jpg|png|webp)$/i.test(reference)) {
      return response.status(404).json({ detail: 'Image not found' });
    }
    try {
      const collection = await getLostFoundItemsCollection();
      const report = await collection.findOne({ image_reference: reference });
      if (!report || (!ownsReport(report, request.user) && request.user.role !== 'admin')) {
        return response.status(404).json({ detail: 'Image not found' });
      }
      const buffer = await fs.readFile(path.join(resolvedUploadDir, reference));
      const mimeType = reference.endsWith('.png')
        ? 'image/png'
        : reference.endsWith('.webp')
          ? 'image/webp'
          : 'image/jpeg';
      response.set('Content-Type', mimeType);
      response.set('Cache-Control', 'private, no-store');
      return response.send(buffer);
    } catch (error) {
      if (error.code === 'ENOENT') {
        return response.status(404).json({ detail: 'Image not found' });
      }
      return next(error);
    }
  });

  router.patch('/:id/ai-suggestions', authenticate, async (request, response, next) => {
    try {
      await ensureIndexes();
      const report = await findReport(request.params.id);
      if (!report) return response.status(404).json({ detail: 'Lost and Found report not found' });
      if (request.user.role !== 'admin' && !ownsReport(report, request.user)) {
        return response.status(403).json({ detail: 'Only the report owner or an admin can edit this report' });
      }
      const changes = {};
      if (Object.hasOwn(request.body || {}, 'category')) {
        if (!CATEGORIES.includes(request.body.category)) {
          return response.status(422).json({ detail: 'category is invalid' });
        }
        changes.category = request.body.category;
      }
      if (Object.hasOwn(request.body || {}, 'colour')) {
        if (typeof request.body.colour !== 'string' ||
            !request.body.colour.trim() ||
            request.body.colour.trim().length > 60) {
          return response.status(422).json({ detail: 'colour must be between 1 and 60 characters' });
        }
        changes.colour = request.body.colour.trim();
      }
      if (Object.keys(changes).length === 0) {
        return response.status(422).json({ detail: 'At least category or colour is required' });
      }
      const now = new Date();
      changes.updated_at = now;
      await (await getLostFoundItemsCollection()).updateOne(
        { _id: report._id },
        { $set: changes },
      );
      return response.json(reportOutput({ ...report, ...changes }));
    } catch (error) {
      return next(error);
    }
  });

  router.get('/:id', authenticate, async (request, response, next) => {
    try {
      await ensureIndexes();
      const report = await findReport(request.params.id);
      if (!report) return response.status(404).json({ detail: 'Lost and Found report not found' });
      if (!ownsReport(report, request.user) && request.user.role !== 'admin') {
        return response.status(404).json({ detail: 'Lost and Found report not found' });
      }
      return response.json(reportOutput(report));
    } catch (error) {
      return next(error);
    }
  });

  router.patch('/:id/close', authenticate, async (request, response, next) => {
    try {
      await ensureIndexes();
      const report = await findReport(request.params.id);
      if (!report) return response.status(404).json({ detail: 'Lost and Found report not found' });
      if (!ownsReport(report, request.user) && request.user.role !== 'admin') {
        return response.status(404).json({ detail: 'Lost and Found report not found' });
      }
      if (report.status === 'resolved') {
        return response.status(409).json({ detail: 'Resolved reports cannot be reopened or closed again' });
      }
      if (report.status === 'closed') {
        return response.status(409).json({ detail: 'Report is already closed' });
      }
      const now = new Date();
      const result = await (await getLostFoundItemsCollection()).updateOne(
        { _id: report._id, status: { $ne: 'closed' } },
        { $set: { status: 'closed', closed_at: now, updated_at: now } },
      );
      if (result.matchedCount !== 1) {
        return response.status(409).json({ detail: 'Report changed during close. Please retry.' });
      }
      await invalidateMatchesAndClaims(report._id, now);
      return response.json(reportOutput({ ...report, status: 'closed', closed_at: now, updated_at: now }));
    } catch (error) {
      return next(error);
    }
  });

  router.patch('/:id/resolve', authenticate, async (request, response, next) => {
    try {
      await ensureIndexes();
      const report = await findReport(request.params.id);
      if (!report) return response.status(404).json({ detail: 'Lost and Found report not found' });
      if (request.user.role !== 'admin' && !ownsReport(report, request.user)) {
        return response.status(403).json({ detail: 'Only the report owner or an admin can resolve this report' });
      }
      if (report.status === 'resolved') {
        return response.status(409).json({ detail: 'Report is already resolved' });
      }
      if (report.status === 'closed') {
        return response.status(409).json({ detail: 'Closed reports cannot be resolved' });
      }
      const now = new Date();
      const result = await (await getLostFoundItemsCollection()).updateOne(
        { _id: report._id, status: { $ne: 'resolved' } },
        { $set: { status: 'resolved', resolved_at: now, updated_at: now } },
      );
      if (result.matchedCount !== 1) {
        return response.status(409).json({ detail: 'Report changed during resolution. Please retry.' });
      }
      await invalidateMatchesAndClaims(report._id, now);
      return response.json(reportOutput({ ...report, status: 'resolved', resolved_at: now, updated_at: now }));
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

module.exports = {
  createLostFoundRouter,
  publicMatchSafeOutput,
  calculateMatchScore,
  passesMatchingFilters,
  cosineSimilarity,
};
