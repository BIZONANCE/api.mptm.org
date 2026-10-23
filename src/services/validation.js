// ============================================================
// MPTM Validation Service — Zod schema validation
// ============================================================

const { z } = require('zod');
const { MAX_MAIN_MEMBERS, MAX_FAMILY_MEMBERS } = require('../config');

// Reusable regex helpers: 10-digit mobile starting with 1 to 9
const mobileRegex = /^[1-9]\d{9}$/;
const pincodeRegex = /^\d{6}$/;     // 6-digit Indian PIN code

const mainMemberSchema = z.object({
  fullName: z.string().trim().min(2, 'नाव किमान २ अक्षरी असावे').max(100),
  mobileNo: z
    .string()
    .trim()
    .regex(mobileRegex, 'मोबाईल क्रमांक १० अंकी असणे आवश्यक आहे'),
  prabhagNo: z.string().trim().max(50).default(''),
});

const familyMemberSchema = z.object({
  name: z.string().trim().min(1, 'कुटुंब सदस्याचे नाव आवश्यक आहे').max(100),
  relation: z.string().trim().min(1, 'नाते आवश्यक आहे').max(50),
  dob: z.string().trim().max(30).default(''),
  occupation: z.string().trim().max(50).default(''),
  mobile: z
    .string()
    .trim()
    .refine((val) => val === '' || mobileRegex.test(val), {
      message: 'कुटुंब सदस्याचा मोबाईल क्रमांक वैध १० अंकी असावा किंवा रिकामा ठेवावा',
    })
    .default(''),
});

const registrationPayloadSchema = z.object({
  type: z.enum(['PRIMARY', 'EXECUTIVE']).default('PRIMARY'),
  address: z.string().trim().min(3, 'पत्ता आवश्यक आहे').max(300),
  gaav: z.string().trim().max(100).nullable().optional(),
  taluka: z.string().trim().max(100).nullable().optional(),
  city: z.string().trim().max(100).default('अमरावती'),
  district: z.string().trim().max(100).default('अमरावती'),
  state: z.string().trim().max(100).default('महाराष्ट्र'),
  country: z.string().trim().max(100).default('भारत'),
  pincode: z
    .string()
    .trim()
    .refine((val) => !val || pincodeRegex.test(val), {
      message: 'पिनकोड ६ अंकी असावा',
    })
    .nullable()
    .optional(),
  referredBy: z.string().trim().max(100).nullable().optional(),
  mainMembers: z
    .array(mainMemberSchema)
    .min(1, 'किमान १ मुख्य सदस्य आवश्यक आहे')
    .max(MAX_MAIN_MEMBERS, `कमाल ${MAX_MAIN_MEMBERS} मुख्य सदस्य नोंदवता येतील`),
  familyMembers: z
    .array(familyMemberSchema)
    .max(MAX_FAMILY_MEMBERS, `कमाल ${MAX_FAMILY_MEMBERS} कुटुंब सदस्य नोंदवता येतील`)
    .default([]),
  isTestPayment: z.boolean().optional(),
  testPin: z.string().optional(),
});

const donationPayloadSchema = z.object({
  name: z.string().trim().min(2, 'नाव किमान २ अक्षरी असावे').max(100),
  mobileNo: z
    .string()
    .trim()
    .regex(mobileRegex, 'मोबाईल क्रमांक १० अंकी असणे आवश्यक आहे'),
  amount: z
    .union([z.number().int().positive(), z.string().regex(/^\d+$/)])
    .transform((val) => Number(val))
    .refine((val) => val > 0, { message: 'देणगी रक्कम ० पेक्षा जास्त असावी' }),
  address: z.string().trim().max(300).nullable().optional(),
  gaav: z.string().trim().max(100).nullable().optional(),
  taluka: z.string().trim().max(100).nullable().optional(),
  city: z.string().trim().max(100).default('अमरावती'),
  district: z.string().trim().max(100).default('अमरावती'),
  state: z.string().trim().max(100).default('महाराष्ट्र'),
  country: z.string().trim().max(100).default('भारत'),
  pincode: z
    .string()
    .trim()
    .refine((val) => !val || pincodeRegex.test(val), {
      message: 'पिनकोड ६ अंकी असावा',
    })
    .nullable()
    .optional(),
  isTestPayment: z.boolean().optional(),
});

function validateRegistrationPayload(data) {
  let normalized = { ...data };
  if (data && data.formData && typeof data.formData === 'object') {
    normalized = {
      ...data.formData,
      ...data,
      address: data.formData.address !== undefined ? data.formData.address : data.address,
      gaav: data.formData.gaav !== undefined ? data.formData.gaav : data.gaav,
      taluka: data.formData.taluka !== undefined ? data.formData.taluka : data.taluka,
      city: data.formData.city !== undefined ? data.formData.city : data.city,
      district: data.formData.district !== undefined ? data.formData.district : data.district,
      state: data.formData.state !== undefined ? data.formData.state : data.state,
      country: data.formData.country !== undefined ? data.formData.country : data.country,
      pincode: data.formData.pincode !== undefined ? data.formData.pincode : data.pincode,
      referredBy: data.formData.referredBy !== undefined ? data.formData.referredBy : data.referredBy,
    };
  }
  return registrationPayloadSchema.parse(normalized);
}

function validateDonationPayload(data) {
  return donationPayloadSchema.parse(data);
}

module.exports = {
  registrationPayloadSchema,
  donationPayloadSchema,
  validateRegistrationPayload,
  validateDonationPayload,
};
