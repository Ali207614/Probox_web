const LeadModel = require('../models/lead-model');
const LeadChat = require('../models/lead-chat-model');

const {
    pickClientPhoneFromWebhook,
    pickOperatorExtFromPayload,
    deriveLeadFields,
    loadOperatorsMap,
} = require('./onlinepbx.utils');
const { generateShortId } = require("../utils/createLead");
// simple in-memory cache
let OPS_CACHE = { at: 0, map: null };
const OPS_TTL_MS = 60 * 1000;

async function getOperatorsMapCached() {
    const now = Date.now();
    if (OPS_CACHE.map && now - OPS_CACHE.at < OPS_TTL_MS) return OPS_CACHE.map;
    const map = await loadOperatorsMap();
    OPS_CACHE = { at: now, map };
    return map;
}

function isCallStartEvent(event) {
    const e = String(event || '').toLowerCase();
    return e === 'call_start' || e === 'call_user_start';
}

async function handleOnlinePbxPayload(payload) {
  try {
      const clientPhone = pickClientPhoneFromWebhook(payload);
      if (!clientPhone) {
          return { ok: true, skipped: 'no_client_phone' };
      }


      const operatorExt = pickOperatorExtFromPayload(payload);
      const opsMap = await getOperatorsMapCached();
      const slpCode = operatorExt != null ? (opsMap.get(operatorExt) ?? null) : null;

      const { source, status } = deriveLeadFields(payload);

      const now = payload.date_iso ? new Date(payload.date_iso) : new Date();
      const event = String(payload.event || '').toLowerCase();

      let leadBefore = null;

      if (payload.uuid) {
          const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

          leadBefore = await LeadModel.findOne({
              clientPhone,
              updatedAt: { $gte: since }, // yoki createdAt
          })
              .select('pbx callCount updatedAt')
              .lean();
      }

      const prevUuid = leadBefore?.pbx?.lxast_uuid ?? null;
      const isNewUuid = payload.uuid && payload.uuid !== prevUuid;
      const shouldIncCallCount = isCallStartEvent(event) && isNewUuid;
      const n = await generateShortId('PRO');
      const update = {
          $setOnInsert: {
              clientPhone,
              createdAt: now,
              time:now,
              n
              // callCount: 0  // ❌ olib tashlang
          },
          $set: {
              source,
              status,
              operator: slpCode,
              called: true,
              callTime: now,
              updatedAt: now,
              'pbx.last_uuid': payload.uuid ?? null,
              'pbx.last_event': payload.event ?? null,
              'pbx.last_direction': payload.direction ?? null,
              'pbx.last_date': payload.date_iso ?? null,
          },
      };

      if (shouldIncCallCount) {
          update.$inc = { callCount: 1 };
      }


      const lead = await LeadModel.findOneAndUpdate(
          { clientPhone },
          update,
          { upsert: true, new: true }
      ).lean();

      return { ok: true, leadId: String(lead._id) };
  }
  catch (err) {
      console.error('[handleOnlinePbxPayload] Error:', err);
      return { ok: false, error: err.message };
  }
}

module.exports = {
    handleOnlinePbxPayload,
};
