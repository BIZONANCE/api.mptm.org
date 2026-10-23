// ============================================================
// MPTM PhonePe Sandbox Provider
// Official SDK: @phonepe-pg/pg-sdk-node
// Environment: Env.SANDBOX
// ============================================================
const { StandardCheckoutClient, Env, StandardCheckoutPayRequest, } = require('@phonepe-pg/pg-sdk-node');
const { PHONEPE_CLIENT_ID, PHONEPE_CLIENT_SECRET, PHONEPE_CLIENT_VERSION, PHONEPE_ENVIRONMENT, PHONEPE_WEBHOOK_USERNAME, PHONEPE_WEBHOOK_PASSWORD, } = require('../config');
// Initialize singleton client
let clientInstance = null;
function getClient() {
    if (!clientInstance) {
        if (!PHONEPE_CLIENT_ID || !PHONEPE_CLIENT_SECRET) {
            throw new Error('PhonePe configuration missing: PHONEPE_CLIENT_ID or PHONEPE_CLIENT_SECRET not set in .env');
        }
        const targetEnv = (PHONEPE_ENVIRONMENT === 'PRODUCTION' || PHONEPE_ENVIRONMENT === 'PROD')
            ? Env.PRODUCTION
            : Env.SANDBOX;
        clientInstance = StandardCheckoutClient.getInstance(PHONEPE_CLIENT_ID, PHONEPE_CLIENT_SECRET, Number(PHONEPE_CLIENT_VERSION || 1), targetEnv);
    }
    return clientInstance;
}
/**
 * Creates an online order via PhonePe Standard Checkout.
 * 10-second timeout, no automatic retry.
 * @param {object} params - { merchantOrderId, amountPaise, redirectUrl }
 * @returns {Promise<{ redirectUrl: string, providerRef: string }>}
 */
async function createOrder({ merchantOrderId, amountPaise, redirectUrl }) {
    const client = getClient();
    const request = StandardCheckoutPayRequest.builder()
        .merchantOrderId(merchantOrderId)
        .amount(amountPaise)
        .redirectUrl(redirectUrl)
        .build();
    // 10 second timeout wrapper
    const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('PhonePe createOrder timed out after 10 seconds')), 10000));
    const payPromise = client.pay(request);
    const response = await Promise.race([payPromise, timeoutPromise]);
    const checkoutUrl = response.redirectUrl;
    if (!checkoutUrl) {
        throw new Error('PhonePe did not return a valid redirect URL: ' + JSON.stringify(response));
    }
    return {
        redirectUrl: checkoutUrl,
        providerRef: response.order_id || merchantOrderId,
    };
}
/**
 * Fetches order status directly from PhonePe API.
 * Never trusts redirect params.
 * @param {string} merchantOrderId
 * @returns {Promise<{ state: 'SUCCESS' | 'FAILED' | 'PENDING', amountPaise: number, paymentMode: string, paymentReference: string, raw: object }>}
 */
async function getStatus(merchantOrderId) {
    const client = getClient();
    const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('PhonePe getOrderStatus timed out after 10 seconds')), 10000));
    const statusPromise = client.getOrderStatus(merchantOrderId);
    const response = await Promise.race([statusPromise, timeoutPromise]);
    // Map PhonePe states (COMPLETED, FAILED, PENDING)
    let state = 'PENDING';
    if (response.state === 'COMPLETED') {
        state = 'SUCCESS';
    }
    else if (response.state === 'FAILED') {
        state = 'FAILED';
    }
    const paymentDetail = Array.isArray(response.payment_details) && response.payment_details.length > 0
        ? response.payment_details[0]
        : null;
    const paymentMode = paymentDetail?.payment_mode || 'PhonePe / UPI';
    const paymentReference = paymentDetail?.transaction_id || response.order_id || merchantOrderId;
    return {
        state,
        amountPaise: Number(response.amount),
        paymentMode,
        paymentReference,
        raw: response,
    };
}
/**
 * Validates S2S / Webhook callback from PhonePe.
 * @param {object} headers
 * @param {string} rawBody
 * @returns {{ valid: boolean, event: string, payload: object }}
 */
function verifyWebhook(headers, rawBody) {
    const client = getClient();
    const authHeader = headers['authorization'] || headers['Authorization'];
    if (!authHeader) {
        return { valid: false, event: 'UNKNOWN', payload: null };
    }
    try {
        const callbackResponse = client.validateCallback(PHONEPE_WEBHOOK_USERNAME, PHONEPE_WEBHOOK_PASSWORD, authHeader, typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody));
        return {
            valid: true,
            event: callbackResponse.event || 'PG_ORDER_COMPLETED',
            payload: callbackResponse.payload || {},
        };
    }
    catch (err) {
        return {
            valid: false,
            event: 'VALIDATION_FAILED',
            error: err.message,
            payload: null,
        };
    }
}
module.exports = {
    createOrder,
    getStatus,
    verifyWebhook,
};
